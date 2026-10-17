import AVFoundation

/// `--sync-test <folder>`: writes a recording whose sound has holes in it (as a busy Mac's
/// microphone can leave) and a stretch sent twice, with a beep on each flash of the picture, then
/// checks every beep still lands on its flash and the sound runs as long as the picture.
enum SyncTest {
    static let flashes = [2.0, 5.0, 8.0]
    /// Stretches of sound that never arrive, and a moment sent twice.
    static let holes = [(1.0, 1.3), (3.0, 3.6), (6.0, 6.25)]
    static let twice = 7.0
    static let rate = 48_000.0
    static let step = 480

    static func run(in folder: URL) async -> Bool {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent("sync.mov")
        guard let writer = try? TrackWriter(url: url, size: CGSize(width: 320, height: 240), fps: 30, audioTracks: [(.audio1, 1)], clock: PauseClock()),
              let format = soundFormat() else { return report(false, "couldn't start writing") }
        let base = 100.0
        let lit = { (t: Double) in flashes.contains { t >= $0 && t < $0 + 0.1 } }
        var frame = 0
        var at = 0
        while Double(at) / rate < 10 {
            let t = Double(at) / rate
            // The picture: a frame each thirtieth of a second, white while a beep sounds.
            while Double(frame) / 30 <= t {
                for _ in 0..<500 where !writer.readyForVideo { try? await Task.sleep(nanoseconds: 1_000_000) }
                if let s = picture(white: lit(Double(frame) / 30), at: base + Double(frame) / 30) { writer.append(s, to: .video) }
                frame += 1
            }
            // The sound, a hundredth of a second at a time, except in the holes.
            if !holes.contains(where: { t >= $0.0 && t < $0.1 }) {
                let samples = (0..<step).map { i -> Float in
                    let u = Double(at + i) / rate
                    return lit(u) ? Float(0.5 * sin(2 * .pi * 1000 * u)) : 0
                }
                if let s = sound(samples, format: format, at: base + t) {
                    writer.append(s, to: .audio1)
                    if abs(t - twice) < 0.001 { writer.append(s, to: .audio1) }
                }
            }
            at += step
            try? await Task.sleep(nanoseconds: 300_000)
        }
        guard await writer.finish() else { return report(false, "the file didn't save") }
        // Read it back: when each flash shows and each beep sounds.
        let asset = AVURLAsset(url: url)
        guard let seen = try? await onsets(of: asset, media: .video), let heard = try? await onsets(of: asset, media: .audio) else { return report(false, "couldn't read it back") }
        let picture = (try? await asset.loadTracks(withMediaType: .video).first?.load(.timeRange).duration.seconds) ?? 0
        let soundLength = (try? await asset.loadTracks(withMediaType: .audio).first?.load(.timeRange).duration.seconds) ?? 0
        let offsets = zip(seen, heard).map { $1 - $0 }
        let ok = seen.count == flashes.count && heard.count == flashes.count && offsets.allSatisfy { abs($0) < 0.03 } && abs(picture - soundLength) < 0.1
        return report(ok, String(format: "beeps against flashes: %@ s; sound %.2f s, picture %.2f s; %.2f s of silence put in the holes",
                                 offsets.map { String(format: "%+.3f", $0) }.joined(separator: ", "), soundLength, picture, writer.filled[.audio1] ?? 0))
    }

    private static func report(_ ok: Bool, _ note: String) -> Bool {
        print("\(ok ? "PASS" : "FAIL") the voice stays with the picture through gaps in the sound: \(note)")
        return ok
    }

    private static func soundFormat() -> CMAudioFormatDescription? {
        var asbd = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                                               mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        var f: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &f)
        return f
    }

    private static func sound(_ samples: [Float], format: CMAudioFormatDescription, at t: Double) -> CMSampleBuffer? {
        let bytes = samples.count * 4
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes, blockAllocator: kCFAllocatorDefault,
                                                 customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
              let block else { return nil }
        samples.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) }
        var out: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format, sampleCount: samples.count,
                                                             presentationTimeStamp: CMTime(seconds: t, preferredTimescale: 48_000), packetDescriptions: nil, sampleBufferOut: &out)
        return out
    }

    private static func picture(white: Bool, at t: Double) -> CMSampleBuffer? {
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, 320, 240, kCVPixelFormatType_32BGRA, nil, &pb)
        guard let pb else { return nil }
        CVPixelBufferLockBaseAddress(pb, [])
        memset(CVPixelBufferGetBaseAddress(pb), white ? 255 : 0, CVPixelBufferGetDataSize(pb))
        CVPixelBufferUnlockBaseAddress(pb, [])
        var desc: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pb, formatDescriptionOut: &desc)
        guard let desc else { return nil }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: CMTime(seconds: t, preferredTimescale: 600), decodeTimeStamp: .invalid)
        var out: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pb, formatDescription: desc, sampleTiming: &timing, sampleBufferOut: &out)
        return out
    }

    /// When the picture turns white, or the sound starts, after a quiet spell (seconds into the file).
    private static func onsets(of asset: AVAsset, media: AVMediaType) async throws -> [Double] {
        guard let track = try await asset.loadTracks(withMediaType: media).first else { return [] }
        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = media == .video
            ? [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            : [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false, AVNumberOfChannelsKey: 1, AVSampleRateKey: rate]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        reader.add(output)
        reader.startReading()
        var found: [Double] = []
        var quietSince = -1.0
        var on = false
        while let s = output.copyNextSampleBuffer() {
            let t0 = CMSampleBufferGetPresentationTimeStamp(s).seconds
            if media == .video, let pb = CMSampleBufferGetImageBuffer(s) {
                CVPixelBufferLockBaseAddress(pb, .readOnly)
                let middle = CVPixelBufferGetBaseAddress(pb)!.load(fromByteOffset: CVPixelBufferGetBytesPerRow(pb) * 120 + 160 * 4, as: UInt8.self)
                CVPixelBufferUnlockBaseAddress(pb, .readOnly)
                if middle > 128, !on { found.append(t0) }
                on = middle > 128
            } else if let block = CMSampleBufferGetDataBuffer(s) {
                let n = CMBlockBufferGetDataLength(block) / 4
                var values = [Float](repeating: 0, count: n)
                values.withUnsafeMutableBytes { _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: n * 4, destination: $0.baseAddress!) }
                for (i, v) in values.enumerated() {
                    let t = t0 + Double(i) / rate
                    if abs(v) > 0.2 {
                        if t - quietSince > 0.05, quietSince >= 0 || found.isEmpty { found.append(t) }
                        quietSince = -1
                    } else if quietSince < 0 { quietSince = t }
                }
            }
        }
        return found
    }
}
