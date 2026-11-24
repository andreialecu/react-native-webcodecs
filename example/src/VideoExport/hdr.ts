import type { SkSkottieAnimation, SkSurface } from "react-native-skia";
import { Skia } from "react-native-skia";
import type {
  GPUSharedFenceState,
  GPUSharedTextureMemory,
} from "react-native-webgpu";
import type { createSurfacePool } from "react-native-webcodecs";

// HDR export: Skia draws each frame into a half-float texture, where the
// lights can go above SDR white (1.0), and a WebGPU pass converts it to HLG
// in BT.2020 straight into the encoder's surface. VideoToolbox encodes that
// as HEVC Main 10, tagged HLG.

export const HLG_COLOR_SPACE = {
  primaries: "bt2020",
  transfer: "hlg",
  matrix: "bt2020-ncl",
  fullRange: false,
};

// HEVC Main 10 (general_profile_idc 2), level 5.1: what Mediabunny asks the
// encoder for.
export const HEVC_MAIN10 = "hvc1.2.4.L153.B0";

// AV1 Main (seq_profile 0), level 4.0, 10 bits: HDR on Android, where
// react-native-webcodecs encodes HDR as AV1 (the emulator's software encoder
// has Main 10).
export const AV1_MAIN10 = "av01.0.08M.10";

// The layers that carry light in the card animation, and how much brighter
// their colors get: the lamps' halos and banks, the pool of light, the sweep
// and the shine on the card 4x, and the beams 10x. The beams are gradients
// of low opacity (0.42 at the lamp, 0.12 halfway, under a layer at 85%), so
// 4x left them at about 1.6x SDR white once composited over the night sky;
// at 10x they reach the HLG peak near the lamps and fade from there.
const LIGHTS: Record<string, number> = {
  "left beam": 10,
  "right beam": 10,
  "left lamp": 4,
  "right lamp": 4,
  pool: 4,
  sweep: 4,
  shine: 4,
};

type Json = Record<string, unknown>;

const scaleColors = (shape: Json, factor: number) => {
  if (shape.ty === "gf") {
    // Gradient stops: [offset, r, g, b] × p, then the opacity stops.
    const g = shape.g as { p: number; k: { k: number[] } };
    const { k } = g.k;
    for (let i = 0; i < g.p; i++) {
      for (let c = 1; c <= 3; c++) {
        k[i * 4 + c] *= factor;
      }
    }
  } else if (shape.ty === "fl") {
    const { k } = shape.c as { k: number[] };
    for (let c = 0; c < 3; c++) {
      k[c] *= factor;
    }
  }
  for (const child of (shape.it as Json[] | undefined) ?? []) {
    scaleColors(child, factor);
  }
};

// The card with its lights brighter than SDR white allows.
export const boostLights = (card: object) => {
  const copy = JSON.parse(JSON.stringify(card)) as {
    layers: Json[];
    assets: { layers?: Json[] }[];
  };
  const layers = [
    ...copy.layers,
    ...copy.assets.flatMap((asset) => asset.layers ?? []),
  ];
  for (const layer of layers) {
    const factor = LIGHTS[layer.nm as string];
    if (factor) {
      for (const shape of (layer.shapes as Json[] | undefined) ?? []) {
        scaleColors(shape, factor);
      }
    }
  }
  return copy;
};

// Skia's values are sRGB-encoded (the texture has no color space, so Skia
// writes them as they are), and above 1.0 where the lights are. 1.0 is SDR
// white, shown at 203 nits (BT.2408) of a 1000-nit HLG peak. toHlg() turns
// them into HLG in BT.2020, R'G'B' from 0 to 1 (also used on the web, in
// export.web.ts).
export const HLG_WGSL = /* wgsl */ `
fn srgbToLinear(c: vec3f) -> vec3f {
  let a = abs(c);
  let l = select(pow((a + 0.055) / 1.055, vec3f(2.4)), a / 12.92, a <= vec3f(0.04045));
  return sign(c) * l;
}

fn hlgOetf(e: vec3f) -> vec3f {
  let a = 0.17883277;
  let b = 0.28466892;
  let c = 0.55991073;
  return select(a * log(max(12.0 * e - b, vec3f(1e-6))) + c, sqrt(3.0 * e), e <= vec3f(1.0 / 12.0));
}

fn toHlg(rgb: vec3f) -> vec3f {
  // BT.709 to BT.2020 primaries, in linear light.
  let toBt2020 = mat3x3f(
    vec3f(0.6274, 0.0691, 0.0164),
    vec3f(0.3293, 0.9195, 0.0880),
    vec3f(0.0433, 0.0114, 0.8956));
  let display = max(toBt2020 * srgbToLinear(rgb), vec3f(0.0)) * (203.0 / 1000.0);
  // HLG's inverse OOTF (system gamma 1.2), then its OETF.
  let y = dot(display, vec3f(0.2627, 0.6780, 0.0593));
  let scene = clamp(display * pow(max(y, 1e-4), (1.0 - 1.2) / 1.2), vec3f(0.0), vec3f(1.0));
  return hlgOetf(scene);
}
`;

// Skia's values are premultiplied here.
const SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
${HLG_WGSL}
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let s = textureLoad(src, vec2i(pos.xy), 0);
  let rgb = select(vec3f(0.0), s.rgb / s.a, s.a > 0.0);
  return vec4f(toHlg(rgb), 1.0);
}
`;

type Pool = ReturnType<typeof createSurfacePool>;

export class HlgRenderer {
  private texture: GPUTexture;
  private surface: SkSurface;
  private pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup;

  constructor(
    private device: GPUDevice,
    private width: number,
    private height: number,
  ) {
    this.texture = device.createTexture({
      size: [width, height],
      format: "rgba16float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const surface = Skia.Surface.MakeFromGPUTexture(this.texture);
    if (!surface) {
      throw new Error("Skia.Surface.MakeFromGPUTexture returned null");
    }
    this.surface = surface;
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{ format: "rgba16float" }],
      },
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.texture.createView() }],
    });
  }

  // Draws frame `index` and converts it into a pool surface.
  draw(animation: SkSkottieAnimation, pool: Pool, index: number) {
    const canvas = this.surface.getCanvas();
    canvas.clear(Skia.Color("black"));
    animation.seekFrame(index);
    animation.render(canvas, Skia.XYWHRect(0, 0, this.width, this.height));
    this.surface.flush();

    const surface = pool.acquire();
    const buffer = RNWebGPU.createNativeBufferFromPointer(surface.pixelBuffer);
    let memory: GPUSharedTextureMemory | null = null;
    let target: GPUTexture | null = null;
    try {
      memory = this.device.importSharedTextureMemory({ source: buffer });
      target = memory.createTexture();
      memory.beginAccess(target, false);
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: target.createView(), loadOp: "clear", storeOp: "store" },
        ],
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.draw(3);
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      const {
        fences: [fence],
      }: { fences: (GPUSharedFenceState | undefined)[] } =
        memory.endAccess(target);
      return { surface, fence };
    } catch (e) {
      surface.release();
      throw e;
    } finally {
      target?.destroy();
      memory?.destroy();
      buffer.release();
    }
  }

  dispose() {
    this.surface.dispose();
    this.texture.destroy();
  }
}
