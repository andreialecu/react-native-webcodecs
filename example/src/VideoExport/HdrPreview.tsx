import React, { useEffect } from "react";
import { PixelRatio } from "react-native";
import type { SkSkottieAnimation } from "react-native-skia";
import { Skia } from "react-native-skia";
import {
  cancelAnimationFrame,
  Canvas,
  requestAnimationFrame,
  useCanvasRef,
} from "react-native-webgpu";

import { skiaDevice } from "./export";

// The HDR preview: Skia draws each frame into a half-float texture, where the
// lights go above SDR white (1.0), and a WebGPU pass copies it to a canvas
// that shows values above 1.0 brighter than white, up to what the display
// allows (EDR: toneMapping "extended"). A Skia <Canvas> clips at white.

const SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

// Skia's values are sRGB-encoded, which is what the canvas expects: they are
// copied as they are, above 1.0 included.
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(src, vec2i(pos.xy), 0).rgb, 1.0);
}
`;

const TONE_MAPPING = { mode: "extended" } as const;

export const HdrPreview = ({
  animation,
  width,
  height,
  sourceWidth,
}: {
  animation: SkSkottieAnimation;
  width: number;
  height: number;
  // The width the animation is laid out at.
  sourceWidth: number;
}) => {
  const ref = useCanvasRef();
  // Skia's own device: the texture Skia draws into must belong to it.
  const device = skiaDevice();

  useEffect(() => {
    const context = ref.current?.getContext("webgpu");
    if (!context) {
      return;
    }
    const canvas = context.canvas as unknown as {
      width: number;
      height: number;
    };
    const ratio = PixelRatio.get();
    const w = Math.round(width * ratio);
    const h = Math.round(height * ratio);
    canvas.width = w;
    canvas.height = h;
    context.configure({
      device,
      format: "rgba16float",
      alphaMode: "opaque",
      toneMapping: TONE_MAPPING,
    });

    const texture = device.createTexture({
      size: [w, h],
      format: "rgba16float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const surface = Skia.Surface.MakeFromGPUTexture(texture);
    const module = device.createShaderModule({ code: SHADER });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{ format: "rgba16float" }],
      },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: texture.createView() }],
    });

    const fps = animation.fps();
    const frames = Math.round(animation.duration() * fps);
    const bounds = Skia.XYWHRect(0, 0, sourceWidth, (sourceWidth * h) / w);
    let start: number | null = null;
    let id = 0;
    const render = (timestamp: number) => {
      start ??= timestamp;
      const sk = surface.getCanvas();
      sk.clear(Skia.Color("black"));
      sk.save();
      sk.scale(w / sourceWidth, w / sourceWidth);
      animation.seekFrame(
        Math.floor(((timestamp - start) / 1000) * fps) % frames,
      );
      animation.render(sk, bounds);
      sk.restore();
      surface.flush();

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      context.present();
      id = requestAnimationFrame(render);
    };
    id = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(id);
      surface.dispose();
      texture.destroy();
    };
  }, [ref, device, animation, width, height, sourceWidth]);

  return (
    <Canvas
      ref={ref}
      style={{ width, height }}
      colorSpace="srgb"
      toneMapping={TONE_MAPPING}
    />
  );
};
