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
    var source = floatFormat(sampleRate: sampleRate, channels: channels)
    var destination = try compressedFormat(codec: "aac", sampleRate: sampleRate, channels: channels)
    var converter: AudioConverterRef?
    let status = AudioConverterNew(&source, &destination, &converter)
    guard status == noErr, let converter else {
      throw WebCodecsError.notSupported("AudioConverterNew failed (\(status))")
    }
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
  private var packetDescription = AudioStreamPacketDescription()
  private var held: Data?
  private var start: Double?
  private var framesOut: Int64 = 0
  private var failed = false

  init(
    config: NativeAudioDecoderConfig,
    output: @escaping (NativeDecodedAudio) -> Void,
    error: @escaping (String) -> Void
  ) throws {
    channels = Int(config.numberOfChannels)
    sampleRate = config.sampleRate
    self.output = output
    self.error = error
    var source = try compressedFormat(codec: config.codec, sampleRate: sampleRate, channels: channels)
    framesPerPacket = Int(source.mFramesPerPacket)
    var destination = floatFormat(sampleRate: sampleRate, channels: channels)
    var converter: AudioConverterRef?
    let status = AudioConverterNew(&source, &destination, &converter)
    guard status == noErr, let converter else {
      throw WebCodecsError.notSupported("AudioConverterNew failed (\(status))")
    }
    self.converter = converter
    super.init()
  }

  deinit {
    if let converter { AudioConverterDispose(converter) }
  }

  fileprivate func provide(
    _ packets: UnsafeMutablePointer<UInt32>, _ data: UnsafeMutablePointer<AudioBufferList>,
    _ descriptions: UnsafeMutablePointer<UnsafeMutablePointer<AudioStreamPacketDescription>?>?
  ) -> OSStatus {
    guard let packet else {
      packets.pointee = 0
      return noMoreInputNow
    }
    held = packet  // valid until the next call
    self.packet = nil
    packetDescription = AudioStreamPacketDescription(
      mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.count))
    held!.withUnsafeMutableBytes { raw in
      data.pointee.mNumberBuffers = 1
      data.pointee.mBuffers.mData = raw.baseAddress
      data.pointee.mBuffers.mDataByteSize = UInt32(raw.count)
      data.pointee.mBuffers.mNumberChannels = UInt32(channels)
    }
    withUnsafeMutablePointer(to: &packetDescription) { descriptions?.pointee = $0 }
    packets.pointee = 1
    return noErr
  }

  func decode(data: ArrayBuffer, timestamp: Double, duration: Double) throws {
    guard converter != nil else { throw WebCodecsError.invalidState("the decoder is closed") }
    let bytes = data.toData(copyIfNeeded: true)
    queue.async {
      guard !self.failed, let converter = self.converter else { return }
      if self.start == nil { self.start = timestamp }
      self.packet = bytes
      let capacity = self.framesPerPacket * 2
      var samples = [Float](repeating: 0, count: capacity * self.channels)
      var total = 0
      while true {
        var frames = UInt32(capacity - total)
        if frames == 0 { break }
        let status = samples.withUnsafeMutableBytes { raw -> OSStatus in
          var list = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(
              mNumberChannels: UInt32(self.channels), mDataByteSize: UInt32(Int(frames) * 4 * self.channels),
              mData: raw.baseAddress!.advanced(by: total * 4 * self.channels)))
          return AudioConverterFillComplexBuffer(
            converter,
            { _, packets, data, descriptions, user in
              Unmanaged<HybridNativeAudioDecoder>.fromOpaque(user!).takeUnretainedValue()
                .provide(packets, data, descriptions)
            },
            Unmanaged.passUnretained(self).toOpaque(), &frames, &list, nil)
        }
        total += Int(frames)
        if status == noMoreInputNow || frames == 0 { break }
        if status != noErr {
          self.failed = true
          self.error(errorMessage("EncodingError", "audio-failed", "AudioConverter failed (\(status))"))
          return
        }
      }
      if total > 0 {
        let buffer = ArrayBuffer.allocate(size: total * 4 * self.channels)
        samples.withUnsafeBytes { memcpy(buffer.data, $0.baseAddress!, total * 4 * self.channels) }
        let ts = (self.start ?? 0) + Double(self.framesOut) * 1_000_000 / self.sampleRate
        self.framesOut += Int64(total)
        self.output(NativeDecodedAudio(
          data: buffer, frames: Double(total), sampleRate: self.sampleRate,
          numberOfChannels: Double(self.channels), timestamp: ts.rounded()))
      }
    }
  }

  func flush() throws -> Promise<Void> {
    guard converter != nil else { return Promise.rejected(withError: WebCodecsError.invalidState("the decoder is closed")) }
    return Promise.parallel(queue) {
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
