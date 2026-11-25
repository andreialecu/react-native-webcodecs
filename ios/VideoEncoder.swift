import CoreMedia
import CoreVideo
import Foundation
import NitroModules
import UIKit
import VideoToolbox

// UIApplication background tasks held through withBackgroundTask(): while
// one is, the app keeps running in the background and codecs keep going.
enum BackgroundTasks {
  private static let lock = NSLock()
  private static var tasks: [Double: UIBackgroundTaskIdentifier] = [:]
  private static var next: Double = 1

  static var isActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !tasks.isEmpty
  }

  static func begin(_ name: String) -> Double {
    lock.lock()
    let key = next
    next += 1
    lock.unlock()
    // Callable from any thread. When iOS runs out of time, the task ends.
    let id = UIApplication.shared.beginBackgroundTask(withName: name) { BackgroundTasks.end(key) }
    if id != .invalid {
      lock.lock()
      tasks[key] = id
      lock.unlock()
    }
    return key
  }

  static func end(_ key: Double) {
    lock.lock()
    let id = tasks.removeValue(forKey: key)
    lock.unlock()
    if let id { UIApplication.shared.endBackgroundTask(id) }
  }
}

// Watches the app going to the background: iOS takes the hardware codecs
// away from a backgrounded app (VideoToolbox then fails with
// kVTInvalidSessionErr), so a codec in use reports `interrupted` right away
// instead of failing on a later frame.
final class BackgroundWatch {
  private var observer: NSObjectProtocol?

  init(_ onBackground: @escaping () -> Void) {
    observer = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
    ) { _ in
      // An export finishing inside withBackgroundTask() keeps its codecs.
      if !BackgroundTasks.isActive { onBackground() }
    }
  }

  deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
  }
}

func errorMessage(_ name: String, _ code: String, _ message: String) -> String {
  "\(name): \(code): \(message)"
}

final class HybridNativeVideoEncoder: HybridNativeVideoEncoderSpec {
  private var session: VTCompressionSession?
  private let output: (NativeEncodedChunk) -> Void
  private let error: (String) -> Void
  private let codec: CMVideoCodecType
  private var lastDescription: Data?
  // Frames wait for their GPU fence here, in order, before VideoToolbox.
  private let queue = DispatchQueue(label: "webcodecs.video-encoder")
  private var failed = false
  private var background: BackgroundWatch?
  private(set) var maxFrameDelay: Double = -1
  private(set) var hardwareAccelerated = false

  init(
    config: NativeVideoEncoderConfig,
    output: @escaping (NativeEncodedChunk) -> Void,
    error: @escaping (String) -> Void
  ) throws {
    self.output = output
    self.error = error
    codec = try HybridNativeVideoEncoder.codecType(config.codec)
    // VideoToolbox makes a session for any size and fails at the first
    // frame: refuse what the codec's highest level (6.2) cannot hold.
    let macroblocks = ((Int(config.width) + 15) / 16) * ((Int(config.height) + 15) / 16)
    let tooLarge =
      codec == kCMVideoCodecType_H264
      ? macroblocks > 139_264
      : Int(config.width) * Int(config.height) > 35_651_584
    if tooLarge {
      throw WebCodecsError.notSupported("\(config.width)x\(config.height) is above the codec's highest level")
    }
    // A per-frame quantizer needs BaseFrameQP, which only VideoToolbox's
    // low-latency H.264 mode takes: refused, so that Mediabunny falls back to
    // a bitrate instead of encoding at the default rate.
    if config.bitrateMode == "quantizer" {
      throw WebCodecsError.notSupported("bitrateMode quantizer")
    }
    super.init()

    var session: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: Int32(config.width),
      height: Int32(config.height),
      codecType: codec,
      encoderSpecification: nil,  // iOS picks the hardware encoder when there is one
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: nil,
      refcon: nil,
      compressionSessionOut: &session)
    guard status == noErr, let session else {
      throw WebCodecsError.notSupported("VTCompressionSessionCreate failed (\(status))")
    }
    self.session = session

    func set(_ key: CFString, _ value: CFTypeRef) {
      VTSessionSetProperty(session, key: key, value: value)
    }
    set(kVTCompressionPropertyKey_RealTime, (config.realtime ? kCFBooleanTrue : kCFBooleanFalse)!)
    // WebCodecs outputs chunks in decode order; MP4 without B-frames needs no
    // composition offsets.
    set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
    // Key frames come from encode({ keyFrame: true }), as on the web.
    set(kVTCompressionPropertyKey_MaxKeyFrameInterval, 0x7fff_ffff as CFNumber)
    let profileLevel =
      codec == kCMVideoCodecType_H264
      ? HybridNativeVideoEncoder.profileLevel(config.profile)
      : (config.profile == "main10" ? kVTProfileLevel_HEVC_Main10_AutoLevel : kVTProfileLevel_HEVC_Main_AutoLevel)
    let profileStatus = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: profileLevel)
    guard profileStatus == noErr else {
      VTCompressionSessionInvalidate(session)
      throw WebCodecsError.notSupported("the encoder has no \(config.profile ?? "default") profile (\(profileStatus))")
    }
    // The chunks are tagged BT.709 (EncodedVideoChunkMetadata.decoderConfig):
    // make the RGB → YCbCr conversion and the stream's VUI say the same.
    set(kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2)
    set(kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2)
    set(kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2)
    // VideoToolbox otherwise holds 15 or so frames for lookahead before the
    // first output. Each one is a whole surface (8 MB at 1080x1920), and JS
    // only gets dequeue back as fast as outputs come, so keep it small.
    if VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: 3 as CFNumber) == noErr
    {
      maxFrameDelay = 3
    }
    if let bitrate = config.bitrate, bitrate > 0 {
      var constant = false
      if #available(iOS 16.0, *), config.bitrateMode == "constant" {
        // Not every encoder has CBR (kVTPropertyNotSupportedErr): the
        // average bitrate then. It excludes AverageBitRate and DataRateLimits.
        constant =
          VTSessionSetProperty(
            session, key: kVTCompressionPropertyKey_ConstantBitRate, value: Int(bitrate) as CFNumber) == noErr
      }
      if !constant {
        set(kVTCompressionPropertyKey_AverageBitRate, Int(bitrate) as CFNumber)
      }
      if config.bitrateMode != "constant" {
        // "variable" (WebCodecs' default): AverageBitRate alone overshoots
        // freely, so cap each second at 1.5x the bitrate, as WebRTC does.
        // Some encoders have no data rate limits; the average still holds.
        let limits = [bitrate * 1.5 / 8, 1] as CFArray
        set(kVTCompressionPropertyKey_DataRateLimits, limits)
      }
    }
    if let framerate = config.framerate, framerate > 0 {
      set(kVTCompressionPropertyKey_ExpectedFrameRate, framerate as CFNumber)
    }
    // Allocates what the session needs now, so that a config it cannot run
    // fails here (and isConfigSupported says so) rather than at a frame.
    let prepared = VTCompressionSessionPrepareToEncodeFrames(session)
    guard prepared == noErr else {
      VTCompressionSessionInvalidate(session)
      throw WebCodecsError.notSupported("VTCompressionSessionPrepareToEncodeFrames failed (\(prepared))")
    }
    if #available(iOS 17.4, *) {
      var usingHardware: CFTypeRef?
      if VTSessionCopyProperty(
        session, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
        allocator: kCFAllocatorDefault, valueOut: &usingHardware) == noErr
      {
        hardwareAccelerated = (usingHardware as? Bool) ?? false
      }
    }

    background = BackgroundWatch { [weak self] in
      self?.fail(errorMessage("EncodingError", "interrupted", "the app went to the background"))
    }
  }

  // The color attachments set on each pixel buffer, from setColorSpace():
  // they tell VideoToolbox how to read the surface (an HLG RGBA16F surface
  // is converted to 10-bit BT.2020 YCbCr).
  private var attachments: [CFString: CFString]?

  func setColorSpace(colorSpace: NativeColorSpace) throws {
    guard let session else { throw WebCodecsError.invalidState("the encoder is closed") }
    let primaries: CFString =
      switch colorSpace.primaries {
      case "bt2020": kCVImageBufferColorPrimaries_ITU_R_2020
      case "smpte432": kCVImageBufferColorPrimaries_P3_D65
      default: kCVImageBufferColorPrimaries_ITU_R_709_2
      }
    let transfer: CFString =
      switch colorSpace.transfer {
      case "hlg": kCVImageBufferTransferFunction_ITU_R_2100_HLG
      case "pq": kCVImageBufferTransferFunction_SMPTE_ST_2084_PQ
      case "linear": kCVImageBufferTransferFunction_Linear
      default: kCVImageBufferTransferFunction_ITU_R_709_2
      }
    let matrix: CFString =
      switch colorSpace.matrix {
      case "bt2020-ncl": kCVImageBufferYCbCrMatrix_ITU_R_2020
      case "smpte170m", "bt470bg": kCVImageBufferYCbCrMatrix_ITU_R_601_4
      default: kCVImageBufferYCbCrMatrix_ITU_R_709_2
      }
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ColorPrimaries, value: primaries)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_TransferFunction, value: transfer)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_YCbCrMatrix, value: matrix)
    attachments = [
      kCVImageBufferColorPrimariesKey: primaries,
      kCVImageBufferTransferFunctionKey: transfer,
      kCVImageBufferYCbCrMatrixKey: matrix,
    ]
  }

  static func codecType(_ codec: String) throws -> CMVideoCodecType {
    switch codec {
    case "avc": return kCMVideoCodecType_H264
    case "hevc": return kCMVideoCodecType_HEVC
    default: throw WebCodecsError.notSupported("codec \(codec)")
    }
  }

  static func profileLevel(_ profile: String?) -> CFString {
    switch profile {
    case "baseline": return kVTProfileLevel_H264_Baseline_AutoLevel
    case "main": return kVTProfileLevel_H264_Main_AutoLevel
    default: return kVTProfileLevel_H264_High_AutoLevel
    }
  }

  private func fail(_ message: String) {
    queue.async {
      if self.failed { return }
      self.failed = true
      self.error(message)
    }
  }

  func encode(surface: any HybridNativeSurfaceSpec, timestamp: Double, duration: Double, keyFrame: Bool) throws {
    guard let session else { throw WebCodecsError.invalidState("the encoder is closed") }
    guard let native = surface as? HybridNativeSurface else {
      throw WebCodecsError.invalidArgument("not a native surface")
    }
    // Taken now: JS may close the frame right after encode().
    let pixelBuffer = try native.makePixelBuffer()
    for (key, value) in attachments ?? [:] {
      CVBufferSetAttachment(pixelBuffer, key, value, .shouldPropagate)
    }
    let fence = native.fence
    queue.async {
      if self.failed { return }
      fence?.wait()
      let pts = CMTime(value: CMTimeValue(timestamp), timescale: 1_000_000)
      let dur = duration > 0 ? CMTime(value: CMTimeValue(duration), timescale: 1_000_000) : .invalid
      let options: CFDictionary? =
        keyFrame ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
      let status = VTCompressionSessionEncodeFrame(
        session, imageBuffer: pixelBuffer, presentationTimeStamp: pts, duration: dur,
        frameProperties: options, infoFlagsOut: nil
      ) { [weak self] status, flags, sampleBuffer in
        self?.handle(
          status: status, flags: VTEncodeInfoFlags(rawValue: flags), sampleBuffer: sampleBuffer,
          timestamp: timestamp, duration: duration)
      }
      if status != noErr {
        self.failed = true
        self.error(HybridNativeVideoEncoder.describe(status))
      }
    }
  }

  static func describe(_ status: OSStatus) -> String {
    if status == kVTInvalidSessionErr {
      return errorMessage("EncodingError", "interrupted", "the encoder was taken away (\(status))")
    }
    return errorMessage("EncodingError", "encoder-failed", "VideoToolbox failed (\(status))")
  }

  private func handle(
    status: OSStatus, flags: VTEncodeInfoFlags, sampleBuffer: CMSampleBuffer?,
    timestamp: Double, duration: Double
  ) {
    if status != noErr {
      fail(HybridNativeVideoEncoder.describe(status))
      return
    }
    guard let sampleBuffer, !flags.contains(.frameDropped),
      let block = CMSampleBufferGetDataBuffer(sampleBuffer)
    else {
      // Dropped: an empty chunk tells JS the frame came back without output.
      output(NativeEncodedChunk(data: ArrayBuffer.allocate(size: 0), timestamp: timestamp, duration: duration, key: false, description: nil))
      return
    }

    var key = true
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
      as? [[CFString: Any]], let first = attachments.first
    {
      key = !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    }

    var description: ArrayBuffer?
    if key, let format = CMSampleBufferGetFormatDescription(sampleBuffer),
      let atoms = CMFormatDescriptionGetExtension(
        format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms)
        as? [String: Any],
      let record = (atoms["avcC"] ?? atoms["hvcC"]) as? Data,
      record != lastDescription
    {
      // Outputs come one at a time from VideoToolbox's own queue.
      lastDescription = record
      description = try? ArrayBuffer.copy(data: record)
    }

    let length = CMBlockBufferGetDataLength(block)
    let data = ArrayBuffer.allocate(size: length)
    CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: data.data)

    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let ts = pts.isValid ? Double(CMTimeConvertScale(pts, timescale: 1_000_000, method: .roundHalfAwayFromZero).value) : timestamp
    output(NativeEncodedChunk(data: data, timestamp: ts, duration: duration, key: key, description: description))
  }

  func flush() throws -> Promise<Void> {
    guard let session else { return Promise.rejected(withError: WebCodecsError.invalidState("the encoder is closed")) }
    // Behind every pending encode() on the queue.
    return Promise.parallel(queue) {
      let status = VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      if status != noErr {
        throw WebCodecsError.raw(HybridNativeVideoEncoder.describe(status))
      }
    }
  }

  func close() throws {
    background = nil
    if let session {
      queue.async {
        self.failed = true
        VTCompressionSessionInvalidate(session)
      }
    }
    session = nil
  }

  deinit {
    if let session { VTCompressionSessionInvalidate(session) }
  }
}
