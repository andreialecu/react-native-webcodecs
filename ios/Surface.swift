import CoreVideo
import Foundation
import IOSurface
import Metal
import NitroModules

// Nitro rethrows Swift errors in JS with String(describing:), so the
// description is the "Name: message" the JS side turns into a DOMException.
enum WebCodecsError: LocalizedError, CustomStringConvertible {
  case invalidArgument(String)
  case invalidState(String)
  case notSupported(String)
  case encodingError(String)
  case notFound(String)
  // Already "Name: code: message".
  case raw(String)

  var description: String { errorDescription ?? "Error" }

  var errorDescription: String? {
    switch self {
    case .raw(let m): return m
    case .invalidArgument(let m): return "TypeError: \(m)"
    case .invalidState(let m): return "InvalidStateError: \(m)"
    case .notSupported(let m): return "NotSupportedError: \(m)"
    case .encodingError(let m): return "EncodingError: \(m)"
    case .notFound(let m): return "NotFoundError: \(m)"
    }
  }
}

func pointerBits(_ object: AnyObject?) -> UInt64 {
  guard let object else { return 0 }
  return UInt64(UInt(bitPattern: Unmanaged.passUnretained(object).toOpaque()))
}

func webCodecsFormat(_ fourcc: OSType) -> String {
  switch fourcc {
  case kCVPixelFormatType_32BGRA: return "BGRA"
  case kCVPixelFormatType_32RGBA: return "RGBA"
  case kCVPixelFormatType_64RGBAHalf: return "RGBA16F"
  case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:
    return "NV12"
  default: return "unknown"
  }
}

func cvPixelFormat(_ format: String) throws -> OSType {
  switch format {
  case "BGRA", "BGRX": return kCVPixelFormatType_32BGRA
  case "NV12": return kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
  // Half floats, for HDR: react-native-webgpu imports it as rgba16float.
  case "RGBA16F": return kCVPixelFormatType_64RGBAHalf
  default: throw WebCodecsError.notSupported("pixel format \(format)")
  }
}

// A GPU fence: wait() returns once the writer signaled it, or after a second.
final class SurfaceFence {
  private let event: MTLSharedEvent
  private let value: UInt64
  private static let listener = MTLSharedEventListener(
    dispatchQueue: DispatchQueue(label: "webcodecs.fence"))

  init?(handle: UInt64, value: UInt64) {
    guard handle != 0, let pointer = UnsafeRawPointer(bitPattern: UInt(handle)) else { return nil }
    // Unretained pointer from react-native-webgpu: take our own reference now.
    guard let event = Unmanaged<AnyObject>.fromOpaque(pointer).takeUnretainedValue() as? MTLSharedEvent
    else { return nil }
    self.event = event
    self.value = value
  }

  func wait() {
    if event.signaledValue >= value { return }
    let semaphore = DispatchSemaphore(value: 0)
    event.notify(SurfaceFence.listener, atValue: value) { _, _ in semaphore.signal() }
    _ = semaphore.wait(timeout: .now() + 1)
  }
}

// Holds its own reference on an IOSurface (and the CVPixelBuffer around it
// when it came from a pool or a decoder).
final class HybridNativeSurface: HybridNativeSurfaceSpec {
  private(set) var surface: IOSurfaceRef?
  private(set) var buffer: CVPixelBuffer?
  private(set) var fence: SurfaceFence?
  let width: Double
  let height: Double
  let format: String

  // Whether `surface` holds a use count, released with it.
  private var inUse = false

  init(surface: IOSurfaceRef) {
    self.surface = surface
    width = Double(IOSurfaceGetWidth(surface))
    height = Double(IOSurfaceGetHeight(surface))
    format = webCodecsFormat(IOSurfaceGetPixelFormat(surface))
    // A producer's CVPixelBufferPool reuses a surface once its use count is
    // zero, whatever its retain count: pin it until the frame is closed.
    IOSurfaceIncrementUseCount(surface)
    inUse = true
    super.init()
  }

  init(pixelBuffer: CVPixelBuffer) {
    buffer = pixelBuffer
    surface = CVPixelBufferGetIOSurface(pixelBuffer)?.takeUnretainedValue()
    width = Double(CVPixelBufferGetWidth(pixelBuffer))
    height = Double(CVPixelBufferGetHeight(pixelBuffer))
    format = webCodecsFormat(CVPixelBufferGetPixelFormatType(pixelBuffer))
    super.init()
  }

  var handle: UInt64 { pointerBits(surface) }
  var pixelBuffer: UInt64 { pointerBits(buffer) }

  var memorySize: Int {
    guard let surface else { return 0 }
    return IOSurfaceGetAllocSize(surface)
  }

  func setFence(handle: UInt64, value: UInt64) throws {
    guard let fence = SurfaceFence(handle: handle, value: value) else {
      throw WebCodecsError.invalidArgument("the fence is not an MTLSharedEvent")
    }
    self.fence = fence
  }

  // A CVPixelBuffer for the codecs: the pooled one, or one made around the
  // IOSurface.
  func makePixelBuffer() throws -> CVPixelBuffer {
    if let buffer { return buffer }
    guard let surface else { throw WebCodecsError.invalidState("the frame is closed") }
    var out: Unmanaged<CVPixelBuffer>?
    let status = CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault, surface, nil, &out)
    guard status == kCVReturnSuccess, let pb = out?.takeRetainedValue() else {
      throw WebCodecsError.encodingError("CVPixelBufferCreateWithIOSurface failed (\(status))")
    }
    return pb
  }

  func clone() throws -> any HybridNativeSurfaceSpec {
    let copy: HybridNativeSurface
    if let buffer {
      copy = HybridNativeSurface(pixelBuffer: buffer)
    } else if let surface {
      copy = HybridNativeSurface(surface: surface)
    } else {
      throw WebCodecsError.invalidState("the frame is closed")
    }
    copy.fence = fence
    return copy
  }

  private func unpin() {
    if inUse, let surface { IOSurfaceDecrementUseCount(surface) }
    inUse = false
  }

  func release() throws {
    unpin()
    surface = nil
    buffer = nil
    fence = nil
  }

  deinit {
    unpin()
  }
}

final class HybridNativeSurfacePool: HybridNativeSurfacePoolSpec {
  private let pool: CVPixelBufferPool
  let width: Double
  let height: Double

  init(width: Int, height: Int, format: String) throws {
    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: try cvPixelFormat(format),
      kCVPixelBufferWidthKey: width,
      kCVPixelBufferHeightKey: height,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
      kCVPixelBufferMetalCompatibilityKey: true,
    ]
    var pool: CVPixelBufferPool?
    let status = CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &pool)
    guard status == kCVReturnSuccess, let pool else {
      throw WebCodecsError.notSupported("CVPixelBufferPoolCreate failed (\(status))")
    }
    self.pool = pool
    self.width = Double(width)
    self.height = Double(height)
    super.init()
  }

  func acquire() throws -> any HybridNativeSurfaceSpec {
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &buffer)
    guard status == kCVReturnSuccess, let buffer else {
      throw WebCodecsError.encodingError("CVPixelBufferPoolCreatePixelBuffer failed (\(status))")
    }
    CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
    return HybridNativeSurface(pixelBuffer: buffer)
  }
}
