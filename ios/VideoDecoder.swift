import CoreMedia
import CoreVideo
import Foundation
import NitroModules
import VideoToolbox

private func withParameterSetPointers<R>(
  _ sets: [Data], _ body: (UnsafePointer<UnsafePointer<UInt8>>, UnsafePointer<Int>) -> R
) -> R {
  let copies = sets.map { data -> UnsafeMutablePointer<UInt8> in
    let p = UnsafeMutablePointer<UInt8>.allocate(capacity: data.count)
    data.copyBytes(to: p, count: data.count)
    return p
  }
  defer { copies.forEach { $0.deallocate() } }
  let pointers = copies.map { UnsafePointer($0) }
  let sizes = sets.map { $0.count }
  return pointers.withUnsafeBufferPointer { p in
    sizes.withUnsafeBufferPointer { s in body(p.baseAddress!, s.baseAddress!) }
  }
}

final class HybridNativeVideoDecoder: HybridNativeVideoDecoderSpec {
  private var session: VTDecompressionSession?
  private let format: CMVideoFormatDescription
  private let output: (NativeDecodedFrame) -> Void
  private let error: (String) -> Void
  private let queue = DispatchQueue(label: "webcodecs.video-decoder")
  private var failed = false
  private var background: BackgroundWatch?

  init(
    config: NativeVideoDecoderConfig,
    output: @escaping (NativeDecodedFrame) -> Void,
    error: @escaping (String) -> Void
  ) throws {
    self.output = output
    self.error = error
    format = try HybridNativeVideoDecoder.formatDescription(config)
    super.init()

    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: try cvPixelFormat(config.pixelFormat ?? "BGRA"),
      kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
      kCVPixelBufferMetalCompatibilityKey: true,
    ]
    var session: VTDecompressionSession?
    let status = VTDecompressionSessionCreate(
      allocator: kCFAllocatorDefault, formatDescription: format, decoderSpecification: nil,
      imageBufferAttributes: attributes as CFDictionary, outputCallback: nil,
      decompressionSessionOut: &session)
    guard status == noErr, let session else {
      throw WebCodecsError.notSupported("VTDecompressionSessionCreate failed (\(status))")
    }
    self.session = session
    background = BackgroundWatch { [weak self] in
      self?.fail(errorMessage("EncodingError", "interrupted", "the app went to the background"))
    }
  }

  // The SPS and PPS of an avcC record.
  static func parameterSets(avcC: Data) -> [Data]? {
    let b = [UInt8](avcC)
    guard b.count > 6 else { return nil }
    var sets: [Data] = []
    var i = 5
    for group in 0..<2 {
      guard i < b.count else { return nil }
      let count = group == 0 ? Int(b[i] & 0x1f) : Int(b[i])
      i += 1
      for _ in 0..<count {
        guard i + 2 <= b.count else { return nil }
        let length = Int(b[i]) << 8 | Int(b[i + 1])
        i += 2
        guard i + length <= b.count else { return nil }
        sets.append(Data(b[i..<i + length]))
        i += length
      }
    }
    return sets.count >= 2 ? sets : nil
  }

  static func formatDescription(_ config: NativeVideoDecoderConfig) throws -> CMVideoFormatDescription {
    let codec = try HybridNativeVideoEncoder.codecType(config.codec)
    guard let description = config.description else {
      throw WebCodecsError.notSupported("Annex B streams (no description) are not supported")
    }
    let atom = codec == kCMVideoCodecType_H264 ? "avcC" : "hvcC"
    let record = description.toData(copyIfNeeded: true)
    // From the parameter sets, the format carries the stream's VUI (color
    // primaries, matrix, range): from the avcC atom alone VideoToolbox
    // assumes BT.601 for small frames, and red comes out as (233, 0, 2).
    if codec == kCMVideoCodecType_H264, let sets = parameterSets(avcC: record) {
      var format: CMFormatDescription?
      let status = withParameterSetPointers(sets) { pointers, sizes in
        CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault, parameterSetCount: sets.count,
          parameterSetPointers: pointers, parameterSetSizes: sizes,
          nalUnitHeaderLength: Int32((record[4] & 0x3) + 1), formatDescriptionOut: &format)
      }
      if status == noErr, let format { return format }
    }
    let extensions: [CFString: Any] = [
      kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms: [atom: record]
    ]
    var format: CMVideoFormatDescription?
    let status = CMVideoFormatDescriptionCreate(
      allocator: kCFAllocatorDefault, codecType: codec,
      width: Int32(config.codedWidth ?? 0), height: Int32(config.codedHeight ?? 0),
      extensions: extensions as CFDictionary, formatDescriptionOut: &format)
    guard status == noErr, let format else {
      throw WebCodecsError.notSupported("CMVideoFormatDescriptionCreate failed (\(status))")
    }
    return format
  }

  private func fail(_ message: String) {
    queue.async {
      if self.failed { return }
      self.failed = true
      self.error(message)
    }
  }

  func decode(data: ArrayBuffer, timestamp: Double, duration: Double, key: Bool) throws {
    guard let session else { throw WebCodecsError.invalidState("the decoder is closed") }
    let bytes = data.toData(copyIfNeeded: true)
    let format = format
    queue.async {
      if self.failed { return }
      var block: CMBlockBuffer?
      var status = CMBlockBufferCreateWithMemoryBlock(
        allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes.count,
        blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
        dataLength: bytes.count, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
      guard status == noErr, let block else {
        self.fail(errorMessage("EncodingError", "decoder-failed", "CMBlockBufferCreate failed (\(status))"))
        return
      }
      bytes.withUnsafeBytes { raw in
        _ = CMBlockBufferReplaceDataBytes(
          with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes.count)
      }
      var timing = CMSampleTimingInfo(
        duration: duration > 0 ? CMTime(value: CMTimeValue(duration), timescale: 1_000_000) : .invalid,
        presentationTimeStamp: CMTime(value: CMTimeValue(timestamp), timescale: 1_000_000),
        decodeTimeStamp: .invalid)
      var size = bytes.count
      var sample: CMSampleBuffer?
      status = CMSampleBufferCreateReady(
        allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
        sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample)
      guard status == noErr, let sample else {
        self.fail(errorMessage("EncodingError", "decoder-failed", "CMSampleBufferCreate failed (\(status))"))
        return
      }
      // Temporal processing: frames come out in presentation order, as
      // WebCodecs outputs them.
      let flags: VTDecodeFrameFlags = [._EnableAsynchronousDecompression, ._EnableTemporalProcessing]
      status = VTDecompressionSessionDecodeFrame(
        session, sampleBuffer: sample, flags: flags, infoFlagsOut: nil
      ) { [weak self] status, _, imageBuffer, pts, dur in
        guard let self else { return }
        if status != noErr {
          self.fail(HybridNativeVideoEncoder.describe(status).replacingOccurrences(of: "encoder", with: "decoder"))
          return
        }
        guard let imageBuffer else { return }  // dropped
        let ts = pts.isValid ? Double(CMTimeConvertScale(pts, timescale: 1_000_000, method: .roundHalfAwayFromZero).value) : timestamp
        let d = dur.isValid ? Double(CMTimeConvertScale(dur, timescale: 1_000_000, method: .roundHalfAwayFromZero).value) : duration
        self.output(NativeDecodedFrame(surface: HybridNativeSurface(pixelBuffer: imageBuffer), timestamp: ts, duration: d))
      }
      if status != noErr {
        self.fail(HybridNativeVideoEncoder.describe(status).replacingOccurrences(of: "encoder", with: "decoder"))
      }
    }
  }

  func flush() throws -> Promise<Void> {
    guard let session else { return Promise.rejected(withError: WebCodecsError.invalidState("the decoder is closed")) }
    return Promise.parallel(queue) {
      VTDecompressionSessionFinishDelayedFrames(session)
      VTDecompressionSessionWaitForAsynchronousFrames(session)
    }
  }

  func close() throws {
    background = nil
    if let session {
      queue.async {
        self.failed = true
        VTDecompressionSessionInvalidate(session)
      }
    }
    session = nil
  }

  deinit {
    if let session { VTDecompressionSessionInvalidate(session) }
  }
}
