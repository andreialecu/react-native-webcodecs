import Foundation
import IOSurface
import NitroModules

func resolveURL(_ path: String) -> URL {
  if path.hasPrefix("file://"), let url = URL(string: path) { return url }
  if path.hasPrefix("/") { return URL(fileURLWithPath: path) }
  let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
  return caches.appendingPathComponent(path)
}

// MARK: - Files

final class HybridNativeFile: HybridNativeFileSpec {
  private var handle: FileHandle?
  private let queue = DispatchQueue(label: "webcodecs.file")
  let path: String

  init(path: String, write: Bool) throws {
    let url = resolveURL(path)
    self.path = url.path
    if write {
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: url.path, contents: nil)
      handle = try FileHandle(forUpdating: url)
      try handle?.truncate(atOffset: 0)
    } else {
      guard FileManager.default.fileExists(atPath: url.path) else {
        throw WebCodecsError.notFound("no file at \(url.path)")
      }
      handle = try FileHandle(forReadingFrom: url)
    }
    super.init()
  }

  var size: Double {
    queue.sync { (try? handle?.seekToEnd()).map { Double($0) } ?? 0 }
  }

  func write(position: Double, data: ArrayBuffer) throws -> Promise<Void> {
    // Copied now: the caller may reuse its buffer once write() returns.
    let bytes = data.toData(copyIfNeeded: true)
    return Promise.parallel(queue) {
      guard let handle = self.handle else { throw WebCodecsError.invalidState("the file is closed") }
      try handle.seek(toOffset: UInt64(position))
      try handle.write(contentsOf: bytes)
    }
  }

  func read(start: Double, end: Double) throws -> Promise<ArrayBuffer> {
    return Promise.parallel(queue) {
      guard let handle = self.handle else { throw WebCodecsError.invalidState("the file is closed") }
      try handle.seek(toOffset: UInt64(start))
      let data = try handle.read(upToCount: Int(end - start)) ?? Data()
      return try ArrayBuffer.copy(data: data)
    }
  }

  func close() throws -> Promise<Void> {
    return Promise.parallel(queue) {
      try self.handle?.synchronize()
      try self.handle?.close()
      self.handle = nil
    }
  }
}

// MARK: - Factory

final class HybridWebCodecs: HybridWebCodecsSpec {
  func wrapSurface(handle: UInt64) throws -> any HybridNativeSurfaceSpec {
    guard handle != 0, let pointer = UnsafeRawPointer(bitPattern: UInt(handle)) else {
      throw WebCodecsError.invalidArgument("the handle is null")
    }
    // takeUnretainedValue + the strong Swift reference = our own retain.
    let surface = Unmanaged<IOSurfaceRef>.fromOpaque(pointer).takeUnretainedValue()
    return HybridNativeSurface(surface: surface)
  }

  func createSurfacePool(width: Double, height: Double, format: String) throws -> any HybridNativeSurfacePoolSpec {
    return try HybridNativeSurfacePool(width: Int(width), height: Int(height), format: format)
  }

  func isVideoEncoderConfigSupported(config: NativeVideoEncoderConfig) throws -> Bool {
    guard (try? HybridNativeVideoEncoder.codecType(config.codec)) != nil else { return false }
    guard config.width > 0, config.height > 0 else { return false }
    // A session is the only reliable probe (size limits differ per device).
    guard let encoder = try? HybridNativeVideoEncoder(config: config, output: { _ in }, error: { _ in }) else {
      return false
    }
    try? encoder.close()
    return true
  }

  func createVideoEncoder(
    config: NativeVideoEncoderConfig, output: @escaping (NativeEncodedChunk) -> Void,
    error: @escaping (String) -> Void
  ) throws -> any HybridNativeVideoEncoderSpec {
    return try HybridNativeVideoEncoder(config: config, output: output, error: error)
  }

  func isVideoDecoderConfigSupported(config: NativeVideoDecoderConfig) throws -> Bool {
    guard let decoder = try? HybridNativeVideoDecoder(config: config, output: { _ in }, error: { _ in }) else {
      return false
    }
    try? decoder.close()
    return true
  }

  func createVideoDecoder(
    config: NativeVideoDecoderConfig, output: @escaping (NativeDecodedFrame) -> Void,
    error: @escaping (String) -> Void
  ) throws -> any HybridNativeVideoDecoderSpec {
    return try HybridNativeVideoDecoder(config: config, output: output, error: error)
  }

  func isAudioEncoderConfigSupported(config: NativeAudioEncoderConfig) throws -> Bool {
    return (try? HybridNativeAudioEncoder(config: config, output: { _ in }, error: { _ in })) != nil
  }

  func createAudioEncoder(
    config: NativeAudioEncoderConfig, output: @escaping (NativeEncodedChunk) -> Void,
    error: @escaping (String) -> Void
  ) throws -> any HybridNativeAudioEncoderSpec {
    return try HybridNativeAudioEncoder(config: config, output: output, error: error)
  }

  func isAudioDecoderConfigSupported(config: NativeAudioDecoderConfig) throws -> Bool {
    return (try? HybridNativeAudioDecoder(config: config, output: { _ in }, error: { _ in })) != nil
  }

  func createAudioDecoder(
    config: NativeAudioDecoderConfig, output: @escaping (NativeDecodedAudio) -> Void,
    error: @escaping (String) -> Void
  ) throws -> any HybridNativeAudioDecoderSpec {
    return try HybridNativeAudioDecoder(config: config, output: output, error: error)
  }

  func resolvePath(path: String) throws -> String {
    return resolveURL(path).path
  }

  func openFile(path: String, write: Bool) throws -> any HybridNativeFileSpec {
    return try HybridNativeFile(path: path, write: write)
  }

  func beginBackgroundTask(name: String) throws -> Double {
    BackgroundTasks.begin(name)
  }

  func endBackgroundTask(id: Double) throws {
    BackgroundTasks.end(id)
  }

  func removeFile(path: String) throws -> Bool {
    let url = resolveURL(path)
    guard FileManager.default.fileExists(atPath: url.path) else { return false }
    try FileManager.default.removeItem(at: url)
    return true
  }

  func writeFile(path: String, data: ArrayBuffer) throws -> String {
    let url = resolveURL(path)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.toData(copyIfNeeded: false).write(to: url)
    return url.path
  }
}
