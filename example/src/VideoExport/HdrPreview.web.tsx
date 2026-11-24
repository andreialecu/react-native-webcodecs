import React, { useEffect } from "react";
import { PixelRatio } from "react-native";
import type { SkSkottieAnimation } from "react-native-skia";
import { Skia } from "react-native-skia";
import { Canvas, useCanvasRef } from "react-native-webgpu";

import { makeHalfFloatSurface } from "./halfFloat";

// The HDR preview on the web. React Native Skia's web surfaces are 8-bit, so
// the card is drawn with CanvasKit (which React Native Skia runs on) on a
// half-float render target of its own WebGL context, where the lights keep
// their values above SDR white. Each frame is read back and uploaded to a
// WebGPU texture, and drawn on a canvas with toneMapping "extended": the
// browser shows values above 1.0 brighter than white, as far as the display
// allows. A Skia <Canvas> clips at white.

const SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

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

  useEffect(() => {
    const context = ref.current?.getContext("webgpu");
    if (!context) {
      return;
    }
    let cancelled = false;
    let id = 0;
    const cleanup: (() => void)[] = [];
    (async () => {
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter?.requestDevice();
      if (!device || cancelled) {
        return;
      }
      const ratio = PixelRatio.get();
      const w = Math.round(width * ratio);
      const h = Math.round(height * ratio);
      const canvas = context.canvas as HTMLCanvasElement;
      canvas.width = w;
      canvas.height = h;
      context.configure({
        device,
        format: "rgba16float",
        alphaMode: "opaque",
        toneMapping: TONE_MAPPING,
      });

      const half = makeHalfFloatSurface(w, h);
      cleanup.push(() => half.dispose());

      const texture = device.createTexture({
        size: [w, h],
        format: "rgba16float",
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      cleanup.push(() => texture.destroy());
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
      const render = (timestamp: number) => {
        if (cancelled) {
          return;
        }
        start ??= timestamp;
        animation.seekFrame(
          Math.floor(((timestamp - start) / 1000) * fps) % frames,
        );
        half.draw(w / sourceWidth, (sk) => animation.render(sk, bounds));
        const pixels = half.read();
        if (pixels) {
          device.queue.writeTexture(
            { texture },
            pixels,
            { bytesPerRow: w * 8 },
            [w, h],
          );
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
        }
        id = requestAnimationFrame(render);
      };
      id = requestAnimationFrame(render);
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
      cleanup.forEach((fn) => fn());
    };
  }, [ref, animation, width, height, sourceWidth]);

  return (
    <Canvas
      ref={ref}
      style={{ width, height }}
      colorSpace="srgb"
      toneMapping={TONE_MAPPING}
    />
  );
};
