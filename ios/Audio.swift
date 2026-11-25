import AudioToolbox
import Foundation
import NitroModules

// The input procedure returns this when it has nothing more for now (as
// opposed to noErr with 0 packets, which is the end of the stream).
private let noMoreInputNow: OSStatus = 0x6e_6d_69_64  // 'nmid'

private let aacSampleRates: [Double] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

// AudioSpecificConfig for AAC-LC: object type 2, frequency index, channels.
func audioSpecificConfig(sampleRate: Double, channels: Int) -> Data {
  let index = aacSampleRates.firstIndex(of: sampleRate) ?? 4
  let objectType = 2
  let b0 = UInt8((objectType << 3) | (index >> 1))
  let b1 = UInt8(((index & 1) << 7) | (channels << 3))
  return Data([b0, b1])
}

private func floatFormat(sampleRate: Double, channels: Int) -> AudioStreamBasicDescription {
  AudioStreamBasicDescription(
    mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
    mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
    mBytesPerPacket: UInt32(4 * channels), mFramesPerPacket: 1, mBytesPerFrame: UInt32(4 * channels),
    mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 32, mReserved: 0)
}

// A converter between two formats, with the decoder's magic cookie if any.
private func makeConverter(
  _ source: AudioStreamBasicDescription, _ destination: AudioStreamBasicDescription, _ cookie: Data?
) throws -> AudioConverterRef {
  var source = source
  var destination = destination
  var converter: AudioConverterRef?
  let status = AudioConverterNew(&source, &destination, &converter)
  guard status == noErr, let converter else {
    throw WebCodecsError.notSupported("AudioConverterNew failed (\(status))")
  }
  if let cookie {
    let status = cookie.withUnsafeBytes {
      AudioConverterSetProperty(
        converter, kAudioConverterDecompressionMagicCookie, UInt32($0.count), $0.baseAddress!)
    }
    guard status == noErr else {
      AudioConverterDispose(converter)
      throw WebCodecsError.notSupported("the AAC magic cookie (\(status))")
    }
  }
  return converter
}

private func compressedFormat(codec: String, sampleRate: Double, channels: Int) throws
  -> AudioStreamBasicDescription
{
  let id: AudioFormatID
  let frames: UInt32
  switch codec {
  case "aac":
    id = kAudioFormatMPEG4AAC
    frames = 1024
  case "mp3":
    id = kAudioFormatMPEGLayer3
    frames = 1152
  default: throw WebCodecsError.notSupported("audio codec \(codec)")
  }
  return AudioStreamBasicDescription(
    mSampleRate: sampleRate, mFormatID: id, mFormatFlags: 0, mBytesPerPacket: 0,
    mFramesPerPacket: frames, mBytesPerFrame: 0, mChannelsPerFrame: UInt32(channels),
    mBitsPerChannel: 0, mReserved: 0)
}

// An AudioSpecificConfig in an ES descriptor (esds): the magic cookie
// AudioToolbox takes for AAC, laid out as FFmpeg's ffat_get_magic_cookie does.
private func esdsCookie(_ asc: Data) -> Data {
  func descriptor(_ tag: UInt8, _ size: Int) -> [UInt8] {
    [
      tag, UInt8((size >> 21) & 0x7f) | 0x80, UInt8((size >> 14) & 0x7f) | 0x80,
      UInt8((size >> 7) & 0x7f) | 0x80, UInt8(size & 0x7f),
    ]
  }
  var cookie = descriptor(0x03, 3 + 5 + 13 + 5 + asc.count)
  cookie += [0, 0, 0]  // ES_ID, flags
  cookie += descriptor(0x04, 13 + 5 + asc.count)
  // MPEG-4 audio, an audio stream, buffer size, max and average bitrate.
  cookie += [0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  cookie += descriptor(0x05, asc.count)
  return Data(cookie) + asc
}

// The stream's format as its cookie describes it, which the config's rate and
// channels may not: the richest layer the system plays (HE-AAC v2, HE-AAC,
// then AAC-LC), so SBR and PS are decoded, at their rate and channels, with
// 2048 frames a packet.
private func aacFormat(cookie: Data) throws -> AudioStreamBasicDescription {
  try cookie.withUnsafeBytes { raw -> AudioStreamBasicDescription in
    var base = AudioStreamBasicDescription()
    base.mFormatID = kAudioFormatMPEG4AAC
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    let status = AudioFormatGetProperty(
      kAudioFormatProperty_FormatInfo, UInt32(raw.count), raw.baseAddress, &size, &base)
    guard status == noErr else {
      throw WebCodecsError.notSupported("an AudioSpecificConfig AudioToolbox rejects (\(status))")
    }
    var info = AudioFormatInfo(mASBD: base, mMagicCookie: raw.baseAddress!, mMagicCookieSize: UInt32(raw.count))
    let infoSize = UInt32(MemoryLayout<AudioFormatInfo>.size)
    let itemSize = MemoryLayout<AudioFormatListItem>.size
    var listSize = UInt32(0)
    guard AudioFormatGetPropertyInfo(kAudioFormatProperty_FormatList, infoSize, &info, &listSize) == noErr,
      Int(listSize) >= itemSize
    else { return base }
    var items = [AudioFormatListItem](repeating: AudioFormatListItem(), count: Int(listSize) / itemSize)
    guard AudioFormatGetProperty(kAudioFormatProperty_FormatList, infoSize, &info, &listSize, &items) == noErr
    else { return base }
    let count = min(items.count, Int(listSize) / itemSize)
    guard count > 0 else { return base }
    var index = UInt32(0)
    var indexSize = UInt32(MemoryLayout<UInt32>.size)
    if AudioFormatGetProperty(
      kAudioFormatProperty_FirstPlayableFormatFromList, UInt32(count * itemSize), &items, &indexSize, &index)
      != noErr || Int(index) >= count
    {
      index = 0
    }
    return items[Int(index)].mASBD
  }
}

// MARK: - AudioEncoder (PCM → AAC)

final class HybridNativeAudioEncoder: HybridNativeAudioEncoderSpec {
  private var converter: AudioConverterRef?
  private let channels: Int
  private let sampleRate: Double
  private let output: (NativeEncodedChunk) -> Void
  private let error: (String) -> Void
  private let queue = DispatchQueue(label: "webcodecs.audio-encoder")
  private let maxPacketSize: Int
  private var input: [Float] = []
  private var held: UnsafeMutablePointer<Float>?
  private var endOfStream = false
  private var start: Double?
  private var framesOut: Int64 = 0
  private var sentDescription = false
  private var failed = false

  init(
    config: NativeAudioEncoderConfig,
    output: @escaping (NativeEncodedChunk) -> Void,
    error: @escaping (String) -> Void
  ) throws {
    channels = Int(config.numberOfChannels)
    sampleRate = config.sampleRate
    self.output = output
    self.error = error
    guard config.codec == "aac", channels >= 1, channels <= 2,
      aacSampleRates.contains(sampleRate)
    else {
      throw WebCodecsError.notSupported("AAC-LC, 1 or 2 channels, at a standard sample rate")
    }
    let converter = try makeConverter(
      floatFormat(sampleRate: sampleRate, channels: channels),
      compressedFormat(codec: "aac", sampleRate: sampleRate, channels: channels), nil)
    self.converter = converter
    if let bitrate = config.bitrate, bitrate > 0 {
      var rate = UInt32(bitrate)
      AudioConverterSetProperty(
        converter, kAudioConverterEncodeBitRate, UInt32(MemoryLayout<UInt32>.size), &rate)
    }
    var size = UInt32(0)
    var propSize = UInt32(MemoryLayout<UInt32>.size)
    AudioConverterGetProperty(converter, kAudioConverterPropertyMaximumOutputPacketSize, &propSize, &size)
    maxPacketSize = max(Int(size), 2048)
    super.init()
  }

  deinit {
    held?.deallocate()
    if let converter { AudioConverterDispose(converter) }
  }

  func encode(pcm: ArrayBuffer, frames: Double, timestamp: Double) throws {
    guard converter != nil else { throw WebCodecsError.invalidState("the encoder is closed") }
    let count = Int(frames) * channels
    guard pcm.size >= count * 4 else { throw WebCodecsError.invalidArgument("not enough samples") }
    let samples = Array(UnsafeBufferPointer(start: UnsafeRawPointer(pcm.data).assumingMemoryBound(to: Float.self), count: count))
    queue.async {
      if self.failed { return }
      if self.start == nil { self.start = timestamp }
      self.input.append(contentsOf: samples)
      self.pull()
    }
  }

  fileprivate func provide(
    _ packets: UnsafeMutablePointer<UInt32>, _ data: UnsafeMutablePointer<AudioBufferList>
  ) -> OSStatus {
    held?.deallocate()
    held = nil
    let frames = input.count / channels
    if frames == 0 {
      packets.pointee = 0
      return endOfStream ? noErr : noMoreInputNow
    }
    let count = frames * channels
    let pointer = UnsafeMutablePointer<Float>.allocate(capacity: count)
    input.withUnsafeBufferPointer { pointer.initialize(from: $0.baseAddress!, count: count) }
    input.removeFirst(count)
    held = pointer
    data.pointee.mNumberBuffers = 1
    data.pointee.mBuffers.mData = UnsafeMutableRawPointer(pointer)
    data.pointee.mBuffers.mDataByteSize = UInt32(count * 4)
    data.pointee.mBuffers.mNumberChannels = UInt32(channels)
    packets.pointee = UInt32(frames)
    return noErr
  }

  private func pull() {
    guard let converter else { return }
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: maxPacketSize, alignment: 16)
    defer { buffer.deallocate() }
    while true {
      var packets: UInt32 = 1
      var list = AudioBufferList(
        mNumberBuffers: 1,
        mBuffers: AudioBuffer(mNumberChannels: UInt32(channels), mDataByteSize: UInt32(maxPacketSize), mData: buffer))
      var description = AudioStreamPacketDescription()
      let status = AudioConverterFillComplexBuffer(
        converter,
        { _, packets, data, _, user in
          Unmanaged<HybridNativeAudioEncoder>.fromOpaque(user!).takeUnretainedValue().provide(packets, data)
        },
        Unmanaged.passUnretained(self).toOpaque(), &packets, &list, &description)
      if packets > 0 {
        let size = Int(description.mDataByteSize > 0 ? description.mDataByteSize : list.mBuffers.mDataByteSize)
        let offset = Int(description.mStartOffset)
        let chunk = ArrayBuffer.allocate(size: size)
        memcpy(chunk.data, buffer.advanced(by: offset), size)
        var config: ArrayBuffer?
        if !sentDescription {
          sentDescription = true
          config = try? ArrayBuffer.copy(data: audioSpecificConfig(sampleRate: sampleRate, channels: channels))
        }
        let ts = (start ?? 0) + Double(framesOut) * 1_000_000 / sampleRate
        framesOut += 1024
        output(NativeEncodedChunk(data: chunk, timestamp: ts.rounded(), duration: (1024 * 1_000_000 / sampleRate).rounded(), key: true, description: config))
      }
      if status == noMoreInputNow || (status == noErr && packets == 0) { break }
      if status != noErr {
        failed = true
        error(errorMessage("EncodingError", "audio-failed", "AudioConverter failed (\(status))"))
        break
      }
    }
  }

  func flush() throws -> Promise<Void> {
    guard converter != nil else { return Promise.rejected(withError: WebCodecsError.invalidState("the encoder is closed")) }
    return Promise.parallel(queue) {
      // Nothing encoded since the last flush (start is set by the first
      // encode()): nothing to output. An end of stream now would still give
      // the converter's priming, as frames of silence.
      if self.failed || self.start == nil { return }
      self.endOfStream = true
      self.pull()
      // The converter is done after an end of stream: start a new stream for
      // later encode() calls, as WebCodecs allows encoding after a flush.
      if let converter = self.converter { AudioConverterReset(converter) }
      self.endOfStream = false
      // Which starts at its own first timestamp, as Android's does.
      self.start = nil
      self.framesOut = 0
    }
  }

  func close() throws {
    queue.sync {
      self.failed = true
      if let converter = self.converter { AudioConverterDispose(converter) }
      self.converter = nil
    }
  }
}

// MARK: - AudioDecoder (AAC / MP3 → PCM)

final class HybridNativeAudioDecoder: HybridNativeAudioDecoderSpec {
  private var converter: AudioConverterRef?
  private let channels: Int
  private let sampleRate: Double
  private let framesPerPacket: Int
  private let output: (NativeDecodedAudio) -> Void
  private let error: (String) -> Void
  private let queue = DispatchQueue(label: "webcodecs.audio-decoder")
  private var packet: Data?
  // The packet the converter reads, and its description: AudioToolbox keeps
  // both pointers until the next input call, so they must not move. (A
  // pointer from Data.withUnsafeBytes is only valid inside the closure: for
  // a packet of 14 bytes or less, such as silent AAC, it points at a
  // temporary copy.)
  private var held: UnsafeMutableRawPointer?
  private let packetDescription = UnsafeMutablePointer<AudioStreamPacketDescription>.allocate(
    capacity: 1)
  private var start: Double?
  private var framesOut: Int64 = 0
  private var failed = false
  // flush(): the input procedure ends the stream when it has nothing more.
  private var endOfStream = false

  init(
    config: NativeAudioDecoderConfig,
    output: @escaping (NativeDecodedAudio) -> Void,
    error: @escaping (String) -> Void
  ) throws {
    self.output = output
    self.error = error
    // The AudioSpecificConfig is authoritative (WebCodecs AAC registration):
    // the format and cookie come from it, the config's values only without one.
    var source: AudioStreamBasicDescription
    var cookie: Data?
    if config.codec == "aac", let description = config.description, description.size > 0 {
      let esds = esdsCookie(description.toData(copyIfNeeded: true))
      source = try aacFormat(cookie: esds)
      cookie = esds
    } else {
      source = try compressedFormat(
        codec: config.codec, sampleRate: config.sampleRate, channels: Int(config.numberOfChannels))
    }
    if source.mSampleRate <= 0 { source.mSampleRate = config.sampleRate }
    if source.mChannelsPerFrame == 0 { source.mChannelsPerFrame = UInt32(config.numberOfChannels) }
    framesPerPacket = max(Int(source.mFramesPerPacket), 1024)
    let destination = floatFormat(sampleRate: source.mSampleRate, channels: Int(source.mChannelsPerFrame))
    let converter = try makeConverter(source, destination, cookie)
    // What the converter outputs, which the AudioData say.
    var current = destination
    var currentSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    if AudioConverterGetProperty(
      converter, kAudioConverterCurrentOutputStreamDescription, &currentSize, &current) != noErr
      || current.mSampleRate <= 0 || current.mChannelsPerFrame != destination.mChannelsPerFrame
    {
      current = destination
    }
    sampleRate = current.mSampleRate
    channels = Int(current.mChannelsPerFrame)
    self.converter = converter
    super.init()
  }

  deinit {
    held?.deallocate()
    packetDescription.deallocate()
    if let converter { AudioConverterDispose(converter) }
  }

  fileprivate func provide(
    _ packets: UnsafeMutablePointer<UInt32>, _ data: UnsafeMutablePointer<AudioBufferList>,
    _ descriptions: UnsafeMutablePointer<UnsafeMutablePointer<AudioStreamPacketDescription>?>?
  ) -> OSStatus {
    guard let packet else {
      packets.pointee = 0
      return endOfStream ? noErr : noMoreInputNow
    }
    held?.deallocate()
    let bytes = UnsafeMutableRawPointer.allocate(byteCount: max(packet.count, 1), alignment: 16)
    packet.copyBytes(to: bytes.assumingMemoryBound(to: UInt8.self), count: packet.count)
    held = bytes  // valid until the next call
    self.packet = nil
    packetDescription.pointee = AudioStreamPacketDescription(
      mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.count))
    data.pointee.mNumberBuffers = 1
    data.pointee.mBuffers.mData = bytes
    data.pointee.mBuffers.mDataByteSize = UInt32(packet.count)
    data.pointee.mBuffers.mNumberChannels = UInt32(channels)
    descriptions?.pointee = packetDescription
    packets.pointee = 1
    return noErr
  }

  func decode(data: ArrayBuffer, timestamp: Double, duration: Double) throws {
    guard converter != nil else { throw WebCodecsError.invalidState("the decoder is closed") }
    let bytes = data.toData(copyIfNeeded: true)
    queue.async {
      guard !self.failed, self.converter != nil else { return }
      if self.start == nil { self.start = timestamp }
      self.packet = bytes
      self.pull()
    }
  }

  // Outputs what the converter has decoded, until it wants more input (or,
  // at the end of the stream, has no more).
  private func pull() {
    guard let converter else { return }
    let capacity = framesPerPacket * 2
    // Scratch space for each pass, copied out before the next.
    var samples = [Float](repeating: 0, count: capacity * channels)
    var done = false
    while !done {
      var total = 0
      while total < capacity {
        var frames = UInt32(capacity - total)
        let status = samples.withUnsafeMutableBytes { raw -> OSStatus in
          var list = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(
              mNumberChannels: UInt32(channels), mDataByteSize: UInt32(Int(frames) * 4 * channels),
              mData: raw.baseAddress!.advanced(by: total * 4 * channels)))
          return AudioConverterFillComplexBuffer(
            converter,
            { _, packets, data, descriptions, user in
              Unmanaged<HybridNativeAudioDecoder>.fromOpaque(user!).takeUnretainedValue()
                .provide(packets, data, descriptions)
            },
            Unmanaged.passUnretained(self).toOpaque(), &frames, &list, nil)
        }
        total += Int(frames)
        // An error first: with 0 frames it would otherwise pass for the end.
        if status != noErr && status != noMoreInputNow {
          failed = true
          error(errorMessage("EncodingError", "audio-failed", "AudioConverter failed (\(status))"))
          return
        }
        if status == noMoreInputNow || frames == 0 {
          done = true
          break
        }
      }
      if total > 0 {
        let buffer = ArrayBuffer.allocate(size: total * 4 * channels)
        samples.withUnsafeBytes { memcpy(buffer.data, $0.baseAddress!, total * 4 * channels) }
        let ts = (start ?? 0) + Double(framesOut) * 1_000_000 / sampleRate
        framesOut += Int64(total)
        output(NativeDecodedAudio(
          data: buffer, frames: Double(total), sampleRate: sampleRate,
          numberOfChannels: Double(channels), timestamp: ts.rounded()))
      }
    }
  }

  func flush() throws -> Promise<Void> {
    guard converter != nil else { return Promise.rejected(withError: WebCodecsError.invalidState("the decoder is closed")) }
    return Promise.parallel(queue) {
      // Nothing decoded since the last flush: nothing to end.
      if self.failed || self.start == nil { return }
      // End the stream, for the frames the converter still holds, then start
      // a new one: without a reset, the next chunk would overlap the last
      // (MDCT and SBR state), as after a seek.
      self.endOfStream = true
      self.pull()
      if let converter = self.converter { AudioConverterReset(converter) }
      self.endOfStream = false
      self.packet = nil
      // A later decode() may jump: start timing from its timestamp again.
      self.start = nil
      self.framesOut = 0
    }
  }

  func close() throws {
    queue.sync {
      self.failed = true
      if let converter = self.converter { AudioConverterDispose(converter) }
      self.converter = nil
    }
  }
}
