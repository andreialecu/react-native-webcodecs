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

// Reads a NAL unit's RBSP (emulation prevention bytes removed) bit by bit.
// Reading past the end throws, so a truncated parameter set gives no answer
// rather than a wrong one.
struct BitReader {
  private let bytes: [UInt8]
  private var bit = 0

  struct End: Error {}

  init(nal: [UInt8]) {
    var out: [UInt8] = []
    out.reserveCapacity(nal.count)
    var zeros = 0
    for b in nal {
      if zeros >= 2 && b == 3 {
        zeros = 0
        continue
      }
      zeros = b == 0 ? zeros + 1 : 0
      out.append(b)
    }
    bytes = out
  }

  mutating func u(_ n: Int) throws -> Int {
    var v = 0
    for _ in 0..<n {
      guard bit / 8 < bytes.count else { throw End() }
      v = (v << 1) | Int((bytes[bit / 8] >> (7 - UInt8(bit % 8))) & 1)
      bit += 1
    }
    return v
  }

  mutating func skip(_ n: Int) throws { _ = try u(n) }

  mutating func ue() throws -> Int {
    var zeros = 0
    while try u(1) == 0 {
      zeros += 1
      if zeros > 31 { throw End() }
    }
    let rest = try u(zeros)
    return (1 << zeros) - 1 + rest
  }

  mutating func se() throws -> Int {
    let k = try ue()
    return k % 2 == 1 ? (k + 1) / 2 : -(k / 2)
  }
}

// How many frames a stream may decode ahead of the one it shows next: its
// SPS's max_num_reorder_frames (H.264, in the VUI) or
// sps_max_num_reorder_pics (HEVC). nil when the SPS does not say.
enum ReorderDepth {
  static func h264(sps nal: [UInt8]) -> Int? {
    var r = BitReader(nal: nal)
    do {
      try r.skip(8)  // NAL header
      let profile = try r.u(8)
      try r.skip(16)  // constraint flags, level
      _ = try r.ue()  // seq_parameter_set_id
      if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(profile) {
        let chroma = try r.ue()
        if chroma == 3 { try r.skip(1) }
        _ = try r.ue()  // bit depths
        _ = try r.ue()
        try r.skip(1)
        if try r.u(1) == 1 {  // seq_scaling_matrix_present_flag
          for i in 0..<(chroma == 3 ? 12 : 8) {
            guard try r.u(1) == 1 else { continue }
            var last = 8
            var next = 8
            for _ in 0..<(i < 6 ? 16 : 64) {
              if next != 0 {
                let delta = try r.se()
                next = (last + delta + 256) % 256
              }
              last = next == 0 ? last : next
            }
          }
        }
      }
      _ = try r.ue()  // log2_max_frame_num_minus4
      let pocType = try r.ue()
      if pocType == 0 {
        _ = try r.ue()
      } else if pocType == 1 {
        try r.skip(1)
        _ = try r.se()
        _ = try r.se()
        let cycle = try r.ue()
        for _ in 0..<cycle { _ = try r.se() }
      }
      // Picture order count type 2: shown in decoding order.
      if pocType == 2 { return 0 }
      _ = try r.ue()  // max_num_ref_frames
      try r.skip(1)
      _ = try r.ue()  // width, height
      _ = try r.ue()
      if try r.u(1) == 0 { try r.skip(1) }  // frame_mbs_only_flag
      try r.skip(1)
      if try r.u(1) == 1 {  // frame_cropping_flag
        for _ in 0..<4 { _ = try r.ue() }
      }
      // Baseline and Constrained Baseline have no B-frames.
      let noReordering: Int? = profile == 66 ? 0 : nil
      guard try r.u(1) == 1 else { return noReordering }  // vui_parameters_present_flag
      if try r.u(1) == 1 {  // aspect_ratio_info_present_flag
        if try r.u(8) == 255 { try r.skip(32) }
      }
      if try r.u(1) == 1 { try r.skip(1) }  // overscan
      if try r.u(1) == 1 {  // video_signal_type_present_flag
        try r.skip(4)
        if try r.u(1) == 1 { try r.skip(24) }
      }
      if try r.u(1) == 1 {  // chroma_loc_info_present_flag
        _ = try r.ue()
        _ = try r.ue()
      }
      if try r.u(1) == 1 { try r.skip(65) }  // timing_info
      let nalHrd = try r.u(1) == 1
      if nalHrd { try hrd(&r) }
      let vclHrd = try r.u(1) == 1
      if vclHrd { try hrd(&r) }
      if nalHrd || vclHrd { try r.skip(1) }
      try r.skip(1)  // pic_struct_present_flag
      guard try r.u(1) == 1 else { return noReordering }  // bitstream_restriction_flag
      try r.skip(1)
      for _ in 0..<4 { _ = try r.ue() }
      return try r.ue()  // max_num_reorder_frames
    } catch {
      return nil
    }
  }

  private static func hrd(_ r: inout BitReader) throws {
    let count = try r.ue() + 1
    try r.skip(8)
    for _ in 0..<count {
      _ = try r.ue()
      _ = try r.ue()
      try r.skip(1)
    }
    try r.skip(20)
  }

  static func hevc(sps nal: [UInt8]) -> Int? {
    var r = BitReader(nal: nal)
    do {
      try r.skip(16)  // NAL header
      try r.skip(4)  // sps_video_parameter_set_id
      let subLayers = try r.u(3)  // sps_max_sub_layers_minus1
      try r.skip(1)
      // profile_tier_level
      try r.skip(2 + 1 + 5 + 32 + 48 + 8)
      var profilePresent: [Bool] = []
      var levelPresent: [Bool] = []
      for _ in 0..<subLayers {
        profilePresent.append(try r.u(1) == 1)
        levelPresent.append(try r.u(1) == 1)
      }
      if subLayers > 0 {
        for _ in subLayers..<8 { try r.skip(2) }
      }
      for i in 0..<subLayers {
        if profilePresent[i] { try r.skip(88) }
        if levelPresent[i] { try r.skip(8) }
      }
      _ = try r.ue()  // sps_seq_parameter_set_id
      if try r.ue() == 3 { try r.skip(1) }  // chroma_format_idc
      _ = try r.ue()  // width, height
      _ = try r.ue()
      if try r.u(1) == 1 {  // conformance_window_flag
        for _ in 0..<4 { _ = try r.ue() }
      }
      _ = try r.ue()  // bit depths
      _ = try r.ue()
      _ = try r.ue()  // log2_max_pic_order_cnt_lsb_minus4
      let all = try r.u(1) == 1  // sps_sub_layer_ordering_info_present_flag
      var reorder = 0
      for _ in (all ? 0 : subLayers)...subLayers {
        _ = try r.ue()  // sps_max_dec_pic_buffering_minus1
        reorder = try r.ue()  // sps_max_num_reorder_pics
        _ = try r.ue()
      }
      return reorder
    } catch {
      return nil
    }
  }

  // The SPS NAL units of an hvcC record.
  static func hevcParameterSets(hvcC: Data, type: Int) -> [[UInt8]] {
    let b = [UInt8](hvcC)
    guard b.count > 23 else { return [] }
    var sets: [[UInt8]] = []
    var i = 23
    for _ in 0..<Int(b[22]) {
      guard i + 3 <= b.count else { break }
      let nalType = Int(b[i] & 0x3f)
      let count = Int(b[i + 1]) << 8 | Int(b[i + 2])
      i += 3
      for _ in 0..<count {
        guard i + 2 <= b.count else { return sets }
        let length = Int(b[i]) << 8 | Int(b[i + 1])
        i += 2
        guard i + length <= b.count else { return sets }
        if nalType == type { sets.append(Array(b[i..<i + length])) }
        i += length
      }
    }
    return sets
  }

  // Without an answer from the stream: enough for the B-frame pyramids
  // encoders make (x264's default needs 2, phones' HEVC up to 3 or 4).
  static let fallback = 4
  // The most H.264 and HEVC allow (a DPB of 16 frames).
  static let most = 16

  static func of(_ config: NativeVideoDecoderConfig) -> Int {
    guard let description = config.description else { return fallback }
    let record = description.toData(copyIfNeeded: true)
    let depth: Int?
    if config.codec.hasPrefix("avc") {
      if let sps = HybridNativeVideoDecoder.parameterSets(avcC: record)?.first {
        depth = h264(sps: [UInt8](sps))
      } else {
        depth = nil
      }
    } else {
      depth = hevcParameterSets(hvcC: record, type: 33).first.flatMap { hevc(sps: $0) }
    }
    return min(depth ?? fallback, most)
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
  // VideoToolbox may output frames in decoding order (the Simulator's
  // decoder does, temporal processing or not), and WebCodecs outputs them in
  // presentation order: decoded frames wait here, sorted by timestamp, until
  // more than the stream's reorder depth are held, then the earliest goes
  // out. Frames that already come in order only wait, they are not moved.
  private let reorder = NSLock()
  private var held: [NativeDecodedFrame] = []
  private let baseDepth: Int
  private var depth: Int
  private var lastOut = -Double.infinity
  // On `queue`: the latest timestamp decoded since the stream started, and
  // whether the next key frame starts one (after configure or flush).
  private var lastIn = -Double.infinity
  private var start = true
  // HEVC: the NAL unit length size, and whether the stream started at a
  // CRA or BLA whose leading RASL pictures are still to be skipped.
  private let hevcNalLength: Int?
  private var skipRASL = false

  init(
    config: NativeVideoDecoderConfig,
    output: @escaping (NativeDecodedFrame) -> Void,
    error: @escaping (String) -> Void
  ) throws {
    self.output = output
    self.error = error
    format = try HybridNativeVideoDecoder.formatDescription(config)
    let base = ReorderDepth.of(config)
    baseDepth = base
    depth = base
    // From the format VideoToolbox made of the hvcC record, rather than
    // reading the record a second time.
    var nalLength: Int32 = 0
    if CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_HEVC,
      CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
        format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
        parameterSetCountOut: nil, nalUnitHeaderLengthOut: &nalLength) == noErr,
      nalLength > 0
    {
      hevcNalLength = Int(nalLength)
    } else {
      hevcNalLength = nil
    }
    super.init()

    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: try cvPixelFormat(config.pixelFormat ?? "BGRA"),
      kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
      kCVPixelBufferMetalCompatibilityKey: true,
    ]
    // config.hardwareAcceleration is left to VideoToolbox, which picks the
    // decoder (no decoder specification).
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
      self.stop()
      self.error(message)
    }
  }

  // On `queue`. `failed` is written under `reorder` too, as hold() reads it
  // there; held surfaces go back to the decoder's pool unseen.
  private func stop() {
    reorder.lock()
    failed = true
    held.removeAll()
    reorder.unlock()
  }

  // On `queue`: what follows starts from a key frame, with the stream's own
  // reorder depth again.
  private func restart() {
    lastIn = -Double.infinity
    start = true
    reorder.lock()
    lastOut = -Double.infinity
    depth = baseDepth
    reorder.unlock()
  }

  // The type of an HEVC sample's first picture (VCL) NAL unit, nil when it
  // cannot be read.
  static func hevcPictureType(_ bytes: Data, nalLength: Int) -> Int? {
    var i = bytes.startIndex
    while i + nalLength < bytes.endIndex {
      var length = 0
      for k in 0..<nalLength { length = length << 8 | Int(bytes[i + k]) }
      i += nalLength
      guard length > 0, i + length <= bytes.endIndex else { return nil }
      let type = Int(bytes[i] >> 1) & 0x3f
      if type < 32 { return type }
      i += length
    }
    return nil
  }

  // From VideoToolbox's output callback.
  private func hold(_ frame: NativeDecodedFrame) {
    reorder.lock()
    defer { reorder.unlock() }
    if failed { return }
    // Later than its turn: the stream reorders more than it said. It goes
    // out next (out of order, which cannot be helped now), and later
    // frames wait for one more.
    if frame.timestamp < lastOut && depth < ReorderDepth.most {
      depth += 1
    }
    let at = held.firstIndex { $0.timestamp > frame.timestamp } ?? held.count
    held.insert(frame, at: at)
    while held.count > depth {
      emit(held.removeFirst())
    }
  }

  private func emit(_ frame: NativeDecodedFrame) {
    lastOut = max(lastOut, frame.timestamp)
    output(frame)
  }

  // On `queue`: the frames VideoToolbox still has, then those held for
  // reordering, go out, and what follows starts a new stream.
  private func endStream(_ session: VTDecompressionSession) {
    VTDecompressionSessionFinishDelayedFrames(session)
    VTDecompressionSessionWaitForAsynchronousFrames(session)
    if !failed { drainHeld() }
    restart()
  }

  private func drainHeld() {
    reorder.lock()
    defer { reorder.unlock() }
    while !held.isEmpty { emit(held.removeFirst()) }
  }

  func decode(data: ArrayBuffer, timestamp: Double, duration: Double, key: Bool) throws {
    guard let session else { throw WebCodecsError.invalidState("the decoder is closed") }
    let bytes = data.toData(copyIfNeeded: true)
    let format = format
    let hevcNalLength = hevcNalLength
    queue.async {
      if self.failed { return }
      // A key frame earlier than what came before it, without a flush: a
      // new stream. The frames held for reordering go out first, rather
      // than being sorted in with the new stream's.
      if key && timestamp < self.lastIn {
        self.endStream(session)
      }
      self.lastIn = max(self.lastIn, timestamp)
      let first = key && self.start
      if key { self.start = false }
      // Started at a CRA or BLA (a seek in an open-GOP stream): the RASL
      // pictures after it reference frames before it, which the decoder
      // never had. VideoToolbox fails them, so they are skipped until the
      // next IRAP picture, as Chromium does.
      if let hevcNalLength, let type = HybridNativeVideoDecoder.hevcPictureType(bytes, nalLength: hevcNalLength) {
        if first {
          self.skipRASL = type == 21 || (16...18).contains(type)
        } else if (16...23).contains(type) {
          self.skipRASL = false
        } else if self.skipRASL && (type == 8 || type == 9) {
          return
        }
      }
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
      // The first key frame of a stream may be a recovery point or CRA
      // rather than an IDR: without a reset, VideoToolbox may decode it
      // against stale state, silently corrupted (Apple's advice to
      // Chromium, crbug 451536366).
      if first {
        CMSetAttachment(
          sample, key: kCMSampleBufferAttachmentKey_ResetDecoderBeforeDecoding, value: kCFBooleanTrue,
          attachmentMode: CMAttachmentMode(kCMAttachmentMode_ShouldNotPropagate))
      }
      // Temporal processing: frames come out in presentation order, as
      // WebCodecs outputs them.
      let flags: VTDecodeFrameFlags = [._EnableAsynchronousDecompression, ._EnableTemporalProcessing]
      status = VTDecompressionSessionDecodeFrame(
        session, sampleBuffer: sample, flags: flags, infoFlagsOut: nil
      ) { [weak self] status, _, imageBuffer, pts, dur in
        guard let self else { return }
        // A frame referencing one from before the stream's start (it
        // started at a recovery point or open-GOP key frame): dropped, as
        // Chromium, WebKit and FFmpeg do.
        if status == kVTVideoDecoderReferenceMissingErr { return }
        if status != noErr {
          self.fail(HybridNativeVideoEncoder.describe(status).replacingOccurrences(of: "encoder", with: "decoder"))
          return
        }
        guard let imageBuffer else { return }  // dropped
        let ts = pts.isValid ? Double(CMTimeConvertScale(pts, timescale: 1_000_000, method: .roundHalfAwayFromZero).value) : timestamp
        let d = dur.isValid ? Double(CMTimeConvertScale(dur, timescale: 1_000_000, method: .roundHalfAwayFromZero).value) : duration
        self.hold(NativeDecodedFrame(surface: HybridNativeSurface(pixelBuffer: imageBuffer), timestamp: ts, duration: d))
      }
      if status != noErr && status != kVTVideoDecoderReferenceMissingErr {
        self.fail(HybridNativeVideoEncoder.describe(status).replacingOccurrences(of: "encoder", with: "decoder"))
      }
    }
  }

  func flush() throws -> Promise<Void> {
    guard let session else { return Promise.rejected(withError: WebCodecsError.invalidState("the decoder is closed")) }
    return Promise.parallel(queue) {
      // A flush ends the stream: what follows starts from a key frame.
      self.endStream(session)
    }
  }

  func close() throws {
    background = nil
    if let session {
      queue.async {
        self.stop()
        VTDecompressionSessionInvalidate(session)
      }
    }
    session = nil
  }

  deinit {
    if let session { VTDecompressionSessionInvalidate(session) }
  }
}
