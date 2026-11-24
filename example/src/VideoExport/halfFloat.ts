import type { SkCanvas } from "react-native-skia";
import type { CanvasKit, Surface } from "canvaskit-wasm";

// Web only (HdrPreview.web.tsx, export.web.ts). React Native Skia's web
// surfaces are 8-bit, so values above SDR white would clip: this is a
// half-float render target made with CanvasKit, which React Native Skia runs
// on, on a WebGL context of its own. Values stay sRGB-encoded, above 1.0
// where the lights are, as on the native rgba16float textures.

export interface HalfFloatSurface {
  // Skottie renders onto the CanvasKit canvas behind an SkCanvas (its
  // `ref`), so this one is enough for animation.render().
  canvas: SkCanvas;
  surface: Surface;
  // Clears, then runs `draw` on the canvas scaled by `scale`.
  draw(scale: number, draw: (canvas: SkCanvas) => void): void;
  // The pixels as RGBA half floats, unpremultiplied, 8 bytes each.
  read(): Uint8Array | null;
  dispose(): void;
}

export const makeHalfFloatSurface = (
  width: number,
  height: number,
): HalfFloatSurface => {
  const CK = (globalThis as unknown as { CanvasKit: CanvasKit }).CanvasKit;
  const glCanvas = document.createElement("canvas");
  glCanvas.width = width;
  glCanvas.height = height;
  const grContext = CK.MakeWebGLContext(CK.GetWebGLContext(glCanvas));
  const info = {
    width,
    height,
    colorType: CK.ColorType.RGBA_F16,
    alphaType: CK.AlphaType.Premul,
    colorSpace: CK.ColorSpace.SRGB,
  };
  const surface = grContext && CK.MakeRenderTarget(grContext, info);
  if (!surface) {
    throw new Error("CanvasKit could not make a half-float render target");
  }
  const readInfo = { ...info, alphaType: CK.AlphaType.Unpremul };
  const canvas = { ref: surface.getCanvas() } as unknown as SkCanvas;
  return {
    canvas,
    surface,
    draw(scale, draw) {
      const ck = surface.getCanvas();
      ck.clear(CK.BLACK);
      ck.save();
      ck.scale(scale, scale);
      draw(canvas);
      ck.restore();
      surface.flush();
    },
    read() {
      const image = surface.makeImageSnapshot();
      const pixels = image.readPixels(0, 0, readInfo) as Uint8Array | null;
      image.delete();
      return pixels;
    },
    dispose() {
      surface.delete();
      grContext?.delete();
    },
  };
};
