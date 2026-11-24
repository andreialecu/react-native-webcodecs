#pragma once

#define EGL_EGLEXT_PROTOTYPES 1
#define GL_GLEXT_PROTOTYPES 1
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <android/hardware_buffer.h>
#include <android/native_window.h>
#include <unistd.h>

#include <cstring>

#include "Common.hpp"
#include "Fence.hpp"

namespace margelo::nitro::webcodecs {

// An EGL context that copies AHardwareBuffers (sampled as external textures)
// into a window: the encoder's input surface. Use it on one thread only.
class GlBlitter {
public:
  GlBlitter() = default;
  GlBlitter(const GlBlitter&) = delete;
  GlBlitter& operator=(const GlBlitter&) = delete;

  ~GlBlitter() {
    destroy();
  }

  void init() {
    _display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (_display == EGL_NO_DISPLAY || !eglInitialize(_display, nullptr, nullptr)) {
      throw std::runtime_error("eglInitialize failed");
    }
    // A recordable window (the encoder's input surface) and a 1x1 pbuffer
    // to be current on between windows. Some devices have no config that
    // is both: then a window-only one, with no surface between windows
    // (EGL_KHR_surfaceless_context).
    EGLint count = 0;
    for (EGLint surfaceType : {EGL_WINDOW_BIT | EGL_PBUFFER_BIT, EGL_WINDOW_BIT}) {
      const EGLint attributes[] = {EGL_RED_SIZE,
                                   8,
                                   EGL_GREEN_SIZE,
                                   8,
                                   EGL_BLUE_SIZE,
                                   8,
                                   EGL_ALPHA_SIZE,
                                   8,
                                   EGL_RENDERABLE_TYPE,
                                   EGL_OPENGL_ES3_BIT,
                                   EGL_SURFACE_TYPE,
                                   surfaceType,
                                   EGL_RECORDABLE_ANDROID,
                                   1,
                                   EGL_NONE};
      if (eglChooseConfig(_display, attributes, &_config, 1, &count) && count > 0) {
        break;
      }
    }
    if (count == 0) {
      throw std::runtime_error("eglChooseConfig found no recordable ES 3 config (" + std::to_string(eglGetError()) + ")");
    }
    const EGLint contextAttributes[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    _context = eglCreateContext(_display, _config, EGL_NO_CONTEXT, contextAttributes);
    if (_context == EGL_NO_CONTEXT) {
      throw std::runtime_error("eglCreateContext failed (" + std::to_string(eglGetError()) + ")");
    }
    const EGLint pbufferAttributes[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
    _pbuffer = eglCreatePbufferSurface(_display, _config, pbufferAttributes);
    if (_pbuffer == EGL_NO_SURFACE) {
      EGLint error = eglGetError();
      const char* extensions = eglQueryString(_display, EGL_EXTENSIONS);
      if (!extensions || !std::strstr(extensions, "EGL_KHR_surfaceless_context")) {
        throw std::runtime_error("eglCreatePbufferSurface failed (" + std::to_string(error) +
                                 "), and EGL has no surfaceless contexts");
      }
      // Current with no surface (makeCurrent(EGL_NO_SURFACE)) instead.
      WC_LOG("eglCreatePbufferSurface failed (%d): surfaceless context", error);
    }
    makeCurrent(_pbuffer);
    buildProgram();
  }

  EGLSurface createWindowSurface(ANativeWindow* window) {
    const EGLint attributes[] = {EGL_NONE};
    EGLSurface surface = eglCreateWindowSurface(_display, _config, window, attributes);
    if (surface == EGL_NO_SURFACE) {
      throw std::runtime_error("eglCreateWindowSurface failed (" + std::to_string(eglGetError()) + ")");
    }
    return surface;
  }

  void destroySurface(EGLSurface surface) {
    if (surface == EGL_NO_SURFACE) {
      return;
    }
    makeCurrent(_pbuffer);
    eglDestroySurface(_display, surface);
  }

  void makeCurrent(EGLSurface surface) {
    if (!eglMakeCurrent(_display, surface, surface, _context)) {
      throw std::runtime_error("eglMakeCurrent failed (" + std::to_string(eglGetError()) + ")");
    }
  }

  // Waits for a frame's sync_fd (taken over, closed either way): on the CPU
  // first, bounded, so that a fence that never signals (a hung GPU) fails
  // the frame (throws) instead of blocking this thread in the driver; then
  // on the GPU, where EGL takes the fence, for drivers that order our reads
  // through it. That one can no longer block: the fence has signalled.
  void waitFence(int fd) {
    if (fd < 0) {
      return;
    }
    FenceWait wait = waitSyncFd(fd, kFenceTimeoutMs);
    if (wait != FenceWait::Signaled) {
      ::close(fd);
      throw std::runtime_error(describeFenceWait(wait, kFenceTimeoutMs));
    }
    const EGLint attributes[] = {EGL_SYNC_NATIVE_FENCE_FD_ANDROID, fd, EGL_NONE};
    EGLSyncKHR sync = eglCreateSyncKHR(_display, EGL_SYNC_NATIVE_FENCE_ANDROID, attributes);
    if (sync == EGL_NO_SYNC_KHR) {
      // Not taken over; the CPU wait above was enough.
      ::close(fd);
      return;
    }
    if (eglWaitSyncKHR(_display, sync, 0) != EGL_TRUE) {
      WC_LOG("eglWaitSyncKHR failed (%d) on a signalled fence", eglGetError());
    }
    eglDestroySyncKHR(_display, sync);
  }

  // Draws the top-left `visibleWidth` x `visibleHeight` of `source` (its
  // crop; 0: all of it) over the whole of `target` (current: window surface).
  void drawToWindow(EGLSurface target, AHardwareBuffer* source, uint32_t visibleWidth, uint32_t visibleHeight, int width, int height,
                    int64_t presentationNs) {
    makeCurrent(target);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    // Cleared first, though the quad covers it all: some drivers keep (and
    // tile-based GPUs load) the window buffer's old contents otherwise, and
    // the encoder can be given a stale or partly drawn picture (webrtc:5147).
    glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    // Window: GL's first row is the bottom of the picture.
    draw(source, visibleWidth, visibleHeight, width, height, true);
    eglPresentationTimeANDROID(_display, target, presentationNs);
    // Done reading `source` before it goes back to the pool.
    glFinish();
    if (!eglSwapBuffers(_display, target)) {
      throw std::runtime_error("eglSwapBuffers failed (" + std::to_string(eglGetError()) + ")");
    }
  }

  void destroy() {
    if (_display == EGL_NO_DISPLAY) {
      return;
    }
    eglMakeCurrent(_display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (_pbuffer != EGL_NO_SURFACE) {
      eglDestroySurface(_display, _pbuffer);
    }
    if (_context != EGL_NO_CONTEXT) {
      eglDestroyContext(_display, _context);
    }
    eglReleaseThread();
    _display = EGL_NO_DISPLAY;
    _context = EGL_NO_CONTEXT;
    _pbuffer = EGL_NO_SURFACE;
  }

private:
  struct CropUv {
    float scale;
    float max;
  };

  // The texture coordinates of the first `visible` of `size` texels. A
  // cropped edge stops one texel short of the crop, as SurfaceTexture's
  // transform does, so filtering (and 4:2:0 chroma, at half the size)
  // reads none of the padding.
  static CropUv cropUv(uint32_t visible, uint32_t size) {
    if (visible == 0 || size == 0 || visible >= size) {
      return {1.0f, 1.0f};
    }
    float scale = static_cast<float>(visible) / static_cast<float>(size);
    float max = static_cast<float>(visible > 1 ? visible - 1 : visible) / static_cast<float>(size);
    return {scale, max};
  }

  EGLImageKHR createImage(AHardwareBuffer* buffer) {
    EGLClientBuffer client = eglGetNativeClientBufferANDROID(buffer);
    const EGLint attributes[] = {EGL_IMAGE_PRESERVED_KHR, EGL_TRUE, EGL_NONE};
    EGLImageKHR image = eglCreateImageKHR(_display, EGL_NO_CONTEXT, EGL_NATIVE_BUFFER_ANDROID, client, attributes);
    if (image == EGL_NO_IMAGE_KHR) {
      throw std::runtime_error("eglCreateImageKHR failed (" + std::to_string(eglGetError()) + ")");
    }
    return image;
  }

  void draw(AHardwareBuffer* source, uint32_t visibleWidth, uint32_t visibleHeight, int width, int height, bool flipY) {
    AHardwareBuffer_Desc desc{};
    AHardwareBuffer_describe(source, &desc);
    CropUv x = cropUv(visibleWidth, desc.width);
    CropUv y = cropUv(visibleHeight, desc.height);
    EGLImageKHR image = createImage(source);
    GLuint texture = 0;
    glGenTextures(1, &texture);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_EXTERNAL_OES, texture);
    glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glEGLImageTargetTexture2DOES(GL_TEXTURE_EXTERNAL_OES, static_cast<GLeglImageOES>(image));

    glViewport(0, 0, width, height);
    glDisable(GL_BLEND);
    glDisable(GL_DEPTH_TEST);
    glUseProgram(_program);
    glUniform1i(_samplerLocation, 0);
    glUniform1f(_flipLocation, flipY ? 1.0f : 0.0f);
    glUniform2f(_scaleLocation, x.scale, y.scale);
    glUniform2f(_maxLocation, x.max, y.max);
    glBindVertexArray(_vertexArray);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glBindVertexArray(0);

    glBindTexture(GL_TEXTURE_EXTERNAL_OES, 0);
    glDeleteTextures(1, &texture);
    // The image keeps its own reference to the buffer until the GPU is done.
    eglDestroyImageKHR(_display, image);
  }

  static GLuint compile(GLenum type, const char* source) {
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &source, nullptr);
    glCompileShader(shader);
    GLint ok = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok) {
      char log[512] = {0};
      glGetShaderInfoLog(shader, sizeof(log), nullptr, log);
      throw std::runtime_error(std::string("shader: ") + log);
    }
    return shader;
  }

  void buildProgram() {
    const char* vertex = R"(#version 300 es
in vec2 aPosition;
uniform float uFlip;
// The visible part of the buffer (its crop, at the top left).
uniform vec2 uScale;
out vec2 vUv;
void main() {
  // Texture row 0 is the top of the picture.
  float v = uFlip > 0.5 ? (1.0 - aPosition.y) * 0.5 : (1.0 + aPosition.y) * 0.5;
  vUv = vec2((aPosition.x + 1.0) * 0.5, v) * uScale;
  gl_Position = vec4(aPosition, 0.0, 1.0);
})";
    const char* fragment = R"(#version 300 es
#extension GL_OES_EGL_image_external_essl3 : require
precision mediump float;
uniform samplerExternalOES uTexture;
// Where sampling stops: short of the padding past a crop.
uniform vec2 uMax;
in vec2 vUv;
out vec4 color;
void main() {
  color = texture(uTexture, min(vUv, uMax));
})";
    GLuint vs = compile(GL_VERTEX_SHADER, vertex);
    GLuint fs = compile(GL_FRAGMENT_SHADER, fragment);
    _program = glCreateProgram();
    glAttachShader(_program, vs);
    glAttachShader(_program, fs);
    glBindAttribLocation(_program, 0, "aPosition");
    glLinkProgram(_program);
    glDeleteShader(vs);
    glDeleteShader(fs);
    GLint ok = 0;
    glGetProgramiv(_program, GL_LINK_STATUS, &ok);
    if (!ok) {
      throw std::runtime_error("program link failed");
    }
    _samplerLocation = glGetUniformLocation(_program, "uTexture");
    _flipLocation = glGetUniformLocation(_program, "uFlip");
    _scaleLocation = glGetUniformLocation(_program, "uScale");
    _maxLocation = glGetUniformLocation(_program, "uMax");

    const GLfloat quad[] = {-1, -1, 1, -1, -1, 1, 1, 1};
    glGenVertexArrays(1, &_vertexArray);
    glBindVertexArray(_vertexArray);
    glGenBuffers(1, &_vertexBuffer);
    glBindBuffer(GL_ARRAY_BUFFER, _vertexBuffer);
    glBufferData(GL_ARRAY_BUFFER, sizeof(quad), quad, GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, nullptr);
    glBindVertexArray(0);
  }

  EGLDisplay _display = EGL_NO_DISPLAY;
  EGLConfig _config = nullptr;
  EGLContext _context = EGL_NO_CONTEXT;
  EGLSurface _pbuffer = EGL_NO_SURFACE;
  GLuint _program = 0;
  GLuint _vertexArray = 0;
  GLuint _vertexBuffer = 0;
  GLint _samplerLocation = -1;
  GLint _flipLocation = -1;
  GLint _scaleLocation = -1;
  GLint _maxLocation = -1;
};

} // namespace margelo::nitro::webcodecs
