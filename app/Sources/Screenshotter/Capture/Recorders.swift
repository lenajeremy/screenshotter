import AVFoundation
import ScreenCaptureKit

/// The recording's clock, shared by the screen and the camera: when it was paused, so both drop
/// the same moments and close the same gaps. Times are the host clock both sources stamp frames with.
final class PauseClock: @unchecked Sendable {
    private let lock = NSLock()
    private var gaps: [(start: CMTime, end: CMTime?)] = []

    func pause() {
        lock.lock()
        defer { lock.unlock() }
        if gaps.last?.end == nil, !gaps.isEmpty { return }
        gaps.append((CMClockGetTime(CMClockGetHostTimeClock()), nil))
    }

    func resume() {
        lock.lock()
        defer { lock.unlock() }
        guard let last = gaps.last, last.end == nil else { return }
        gaps[gaps.count - 1].end = CMClockGetTime(CMClockGetHostTimeClock())
    }

    var isPaused: Bool {
        lock.lock()
        defer { lock.unlock() }
        return gaps.last.map { $0.end == nil } ?? false
    }

    /// Where a sample stamped `t` belongs once the pauses are taken out, or nil if it fell in one.
    func shifted(_ t: CMTime) -> CMTime? {
        lock.lock()
        defer { lock.unlock() }
        var removed = CMTime.zero
        for g in gaps {
            if t < g.start { break }
            guard let end = g.end, t >= end else { return nil }
            removed = removed + (end - g.start)
        }
        return t - removed
    }
}

/// One file written as samples arrive (video plus up to two audio tracks), with the pauses taken out.
final class TrackWriter: @unchecked Sendable {
    enum Track { case video, audio1, audio2 }
    let url: URL
    private let writer: AVAssetWriter
    private let video: AVAssetWriterInput
    private var audio: [Track: AVAssetWriterInput] = [:]
    private let clock: PauseClock
    private(set) var firstTime: CMTime?
    private var lastTime = CMTime.zero
    private var finished = false
    /// Samples written, and ones left out because the writer wasn't ready (falling behind), by track.
    private(set) var written: [Track: Int] = [:]
    private(set) var dropped: [Track: Int] = [:]
    /// Taking samples (false: the stream's running but the recording hasn't begun, as during a
    /// countdown, so it starts the moment it's let in).
    var open = true
    /// The recording's end: nothing after it is kept (sound from before it still comes in).
    var cutoff: CMTime?
    /// Whether the file waits for a picture to start. Off once the camera is turned off, so a
    /// recording whose camera went off before its first frame still keeps your voice.
    var waitsForVideo = true
    /// The picture's over (the camera was turned off): the sound carries on without waiting for it.
    private var videoEnded = false
    /// Sound waiting for the writer. It's held, never let go: a gap in the sound would pull
    /// everything after it early, out of step with the picture (your voice with your lips).
    private var waiting: [Track: [CMSampleBuffer]] = [:]
    /// Where each track's sound has reached in the file, and in what arrived.
    private var soundEnd: [Track: CMTime] = [:]
    private var heardEnd: [Track: CMTime] = [:]
    /// Seconds missing from the sound as it arrived, and of silence put in their place, by track.
    private(set) var gaps: [Track: Double] = [:]
    private(set) var filled: [Track: Double] = [:]
    /// Each sound track's span by its timestamps (first to last), and how much sound that held.
    private(set) var soundSpan: [Track: (start: CMTime, end: CMTime)] = [:]
    private(set) var soundHeld: [Track: Double] = [:]
    /// The picture's span by its timestamps.
    private(set) var pictureSpan: (start: CMTime, end: CMTime)?
    /// How long sound took to arrive after its moment, on average (seconds).
    private(set) var soundDelay: [Track: (total: Double, count: Int)] = [:]
    /// A gap or overlap smaller than this is left be (the clocks' jitter).
    private let slack = CMTime(value: 3, timescale: 1000)

    init(url: URL, size: CGSize, fps: Int, audioTracks: [(Track, Int)], clock: PauseClock) throws {
        self.url = url
        self.clock = clock
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: url.pathExtension.lowercased() == "mov" ? .mov : .mp4)
        let w = Int(size.width) / 2 * 2
        let h = Int(size.height) / 2 * 2
        // Screens are mostly flat colour and sharp text: a generous bit rate keeps text crisp.
        let bits = min(80_000_000, max(6_000_000, Int(Double(w * h * fps) * 0.12)))
        video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: w,
            AVVideoHeightKey: h,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bits,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: fps * 2,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
            // HD video's colours, said in the file, so every player (and the Studio) shows them alike.
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ])
        video.expectsMediaDataInRealTime = true
        writer.add(video)
        for (track, channels) in audioTracks {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: channels == 1 ? 96_000 : 160_000,
            ])
            input.expectsMediaDataInRealTime = true
            writer.add(input)
            audio[track] = input
        }
    }

    /// Appends a sample (on the caller's queue). The file starts at the first video frame (or, once
    /// it no longer waits for one, the first sample of any kind).
    func append(_ sample: CMSampleBuffer, to track: Track) {
        guard open, !finished, CMSampleBufferDataIsReady(sample) else { return }
        let t = CMSampleBufferGetPresentationTimeStamp(sample)
        if let cutoff, t > cutoff { return }
        guard let at = clock.shifted(t) else { return }
        if firstTime == nil {
            // Audio before the first frame has nothing to go with.
            guard track == .video || !waitsForVideo, writer.startWriting() else { return }
            writer.startSession(atSourceTime: at)
            firstTime = t
            if videoEnded { video.markAsFinished() }
        }
        let input = track == .video ? video : audio[track]
        guard let input, let out = at == t ? sample : retimed(sample, by: t - at) else { return }
        if track == .video {
            if videoEnded { return }
            if !input.isReadyForMoreMediaData {
                dropped[track, default: 0] += 1
            } else if input.append(out) {
                lastTime = max(lastTime, at)
                written[track, default: 0] += 1
                pictureSpan = (pictureSpan?.start ?? at, at)
            }
        } else {
            if let heard = heardEnd[track], t - heard > slack { gaps[track, default: 0] += (t - heard).seconds }
            heardEnd[track] = t + Self.length(of: sample)
            soundSpan[track] = (soundSpan[track]?.start ?? at, at + Self.length(of: sample))
            soundHeld[track, default: 0] += Self.length(of: sample).seconds
            let late = (CMClockGetTime(CMClockGetHostTimeClock()) - t).seconds
            soundDelay[track] = ((soundDelay[track]?.total ?? 0) + late, (soundDelay[track]?.count ?? 0) + 1)
            waiting[track, default: []].append(out)
            // Seconds behind: the oldest goes (and the gap it leaves is filled with silence).
            if waiting[track]!.count > 600 {
                waiting[track]!.removeFirst()
                dropped[track, default: 0] += 1
            }
        }
        writeSound()
    }

    /// Whether the picture can take another frame (the sync test waits for it).
    var readyForVideo: Bool { video.isReadyForMoreMediaData }

    /// The camera's been turned off: no more picture, and the sound doesn't wait for any.
    func endVideo() {
        guard !videoEnded else { return }
        videoEnded = true
        waitsForVideo = false
        if writer.status == .writing { video.markAsFinished() }
    }

    /// Writes the waiting sound, in order, as far as the writer will take it. A gap before a
    /// sample is filled with silence and an overlap trimmed, so the sound keeps its time.
    private func writeSound() {
        guard writer.status == .writing else { return }
        for (track, input) in audio {
            while var next = waiting[track]?.first, input.isReadyForMoreMediaData {
                let start = CMSampleBufferGetPresentationTimeStamp(next)
                if let end = soundEnd[track] {
                    if start - end > slack, let quiet = Self.silence(like: next, at: end, length: CMTimeMinimum(start - end, CMTime(value: 1, timescale: 1))) {
                        guard input.append(quiet) else { break }
                        soundEnd[track] = end + Self.length(of: quiet)
                        filled[track, default: 0] += Self.length(of: quiet).seconds
                        continue
                    }
                    if end - start > slack {
                        waiting[track]!.removeFirst()
                        guard let rest = Self.trimmed(next, from: end) else { continue }
                        waiting[track]!.insert(rest, at: 0)
                        next = rest
                    }
                }
                waiting[track]!.removeFirst()
                let at = CMSampleBufferGetPresentationTimeStamp(next)
                guard input.append(next) else { break }
                soundEnd[track] = at + Self.length(of: next)
                lastTime = max(lastTime, at)
                written[track, default: 0] += 1
            }
        }
    }

    private static func length(of sample: CMSampleBuffer) -> CMTime {
        let d = CMSampleBufferGetDuration(sample)
        if d.isValid, d > .zero { return d }
        guard let f = CMSampleBufferGetFormatDescription(sample), let rate = CMAudioFormatDescriptionGetStreamBasicDescription(f)?.pointee.mSampleRate, rate > 0 else { return .zero }
        return CMTime(value: CMTimeValue(CMSampleBufferGetNumSamples(sample)), timescale: CMTimeScale(rate))
    }

    /// `length` of silence in a sample's own format (plain PCM), starting `at`.
    static func silence(like sample: CMSampleBuffer, at start: CMTime, length: CMTime) -> CMSampleBuffer? {
        guard let format = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM, asbd.mBytesPerFrame > 0, asbd.mSampleRate > 0 else { return nil }
        let frames = Int((length.seconds * asbd.mSampleRate).rounded())
        guard frames > 0 else { return nil }
        let planes = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 ? Int(asbd.mChannelsPerFrame) : 1
        let bytes = frames * Int(asbd.mBytesPerFrame) * planes
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes, blockAllocator: kCFAllocatorDefault,
                                                 customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
              let block, CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) == noErr else { return nil }
        var out: CMSampleBuffer?
        let at = CMTimeConvertScale(start, timescale: CMTimeScale(asbd.mSampleRate), method: .roundHalfAwayFromZero)
        guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format, sampleCount: frames,
                                                                   presentationTimeStamp: at, packetDescriptions: nil, sampleBufferOut: &out) == noErr else { return nil }
        return out
    }

    /// A sample of sound without what comes before `from` (nil if that's all of it).
    private static func trimmed(_ sample: CMSampleBuffer, from: CMTime) -> CMSampleBuffer? {
        guard let f = CMSampleBufferGetFormatDescription(sample), let rate = CMAudioFormatDescriptionGetStreamBasicDescription(f)?.pointee.mSampleRate, rate > 0 else { return sample }
        let n = CMSampleBufferGetNumSamples(sample)
        let skip = Int(((from - CMSampleBufferGetPresentationTimeStamp(sample)).seconds * rate).rounded())
        guard skip < n else { return nil }
        guard skip > 0 else { return sample }
        var out: CMSampleBuffer?
        guard CMSampleBufferCopySampleBufferForRange(allocator: kCFAllocatorDefault, sampleBuffer: sample, sampleRange: CFRange(location: skip, length: n - skip), sampleBufferOut: &out) == noErr else { return sample }
        return out
    }

    private func retimed(_ sample: CMSampleBuffer, by offset: CMTime) -> CMSampleBuffer? {
        var count: CMItemCount = 0
        CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
        var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
        CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count)
        for i in timing.indices {
            timing[i].presentationTimeStamp = timing[i].presentationTimeStamp - offset
            if timing[i].decodeTimeStamp.isValid { timing[i].decodeTimeStamp = timing[i].decodeTimeStamp - offset }
        }
        var out: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sample, sampleTimingEntryCount: count, sampleTimingArray: &timing, sampleBufferOut: &out)
        return out
    }

    /// Closes the file. Returns false when nothing was recorded.
    func finish() async -> Bool {
        finished = true
        guard firstTime != nil, writer.status == .writing else {
            writer.cancelWriting()
            return false
        }
        // The sound still waiting goes in (the writer catches up now nothing new arrives).
        for _ in 0..<200 where waiting.values.contains(where: { !$0.isEmpty }) {
            writeSound()
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        if !videoEnded { video.markAsFinished() }
        audio.values.forEach { $0.markAsFinished() }
        writer.endSession(atSourceTime: lastTime)
        await writer.finishWriting()
        return writer.status == .completed
    }

    func cancel() {
        finished = true
        if writer.status == .writing { writer.cancelWriting() }
        try? FileManager.default.removeItem(at: url)
    }
}

/// The screen (or a window, or an area of it) recorded with ScreenCaptureKit, with the Mac's own
/// sound and, without the camera, the microphone (macOS 15).
final class ScreenRecorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let writer: TrackWriter
    let pixelSize: CGSize
    private let stream: SCStream
    private let queue = DispatchQueue(label: "screenshotter.screen-recorder", qos: .userInteractive)
    var onStop: ((Error?) -> Void)?

    /// `showsCursor` false: the cursor stays out of the picture (it's logged beside it instead).
    init(region: CaptureRegion, source: ScreenShot.Source, url: URL, systemAudio: Bool, micID: String?, clock: PauseClock, showsCursor: Bool = true) throws {
        let fps = 60
        // Long edges past 4K are scaled down: H.264 files beyond that won't play everywhere.
        var size = CGSize(width: source.pointSize.width * source.scale, height: source.pointSize.height * source.scale)
        let fit = min(1, 3840 / max(size.width, size.height))
        size = CGSize(width: (size.width * fit / 2).rounded() * 2, height: (size.height * fit / 2).rounded() * 2)
        pixelSize = size
        let cfg = SCStreamConfiguration()
        cfg.width = Int(size.width)
        cfg.height = Int(size.height)
        if let r = source.sourceRect { cfg.sourceRect = r }
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.queueDepth = 6
        cfg.showsCursor = showsCursor
        // The encoder's own format (a third of BGRA's size): less for the window server to copy.
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        cfg.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        cfg.colorSpaceName = CGColorSpace.sRGB
        cfg.captureResolution = .best
        if case .window = region { cfg.ignoreShadowsSingleWindow = true }
        var tracks: [(TrackWriter.Track, Int)] = []
        if systemAudio {
            cfg.capturesAudio = true
            cfg.excludesCurrentProcessAudio = true
            cfg.sampleRate = 48_000
            cfg.channelCount = 2
            tracks.append((.audio1, 2))
        }
        var mic = false
        if let micID, #available(macOS 15.0, *) {
            cfg.captureMicrophone = true
            cfg.microphoneCaptureDeviceID = micID
            cfg.showMouseClicks = showsCursor
            tracks.append((.audio2, 1))
            mic = true
        } else if #available(macOS 15.0, *) {
            cfg.showMouseClicks = showsCursor
        }
        writer = try TrackWriter(url: url, size: size, fps: fps, audioTracks: tracks, clock: clock)
        stream = SCStream(filter: source.filter, configuration: cfg, delegate: nil)
        super.init()
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        if systemAudio { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue) }
        if mic, #available(macOS 15.0, *) { try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue) }
    }

    /// Starts the stream. With `waiting`, nothing's kept until `begin()` (the stream warms up
    /// during a countdown, so the recording starts the moment it ends).
    func start(waiting: Bool = false) async throws {
        if waiting { queue.sync { writer.open = false } }
        try await stream.startCapture()
    }

    func begin() {
        queue.sync { writer.open = true }
    }

    func stop() async -> Bool {
        try? await stream.stopCapture()
        return await withCheckedContinuation { done in
            queue.async { Task { done.resume(returning: await self.writer.finish()) } }
        }
    }

    func cancel() async {
        try? await stream.stopCapture()
        queue.sync { writer.cancel() }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        switch type {
        case .screen:
            // Only finished frames: idle and blank ones carry no picture.
            guard let info = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = info.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
            writer.append(sample, to: .video)
        case .audio:
            writer.append(sample, to: .audio1)
        default:
            writer.append(sample, to: .audio2)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStop?(error)
    }
}

/// The camera (and, when recording, the microphone with it) recorded to its own file on the same
/// clock as the screen, so the two line up exactly when they're put together. It starts as the
/// bubble's preview, before any recording; the microphone joins only when a recording starts.
final class CameraRecorder: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    let cameraID: String
    private let queue = DispatchQueue(label: "screenshotter.camera", qos: .userInteractive)
    private let videoIn: AVCaptureDeviceInput
    private let videoOut = AVCaptureVideoDataOutput()
    private let audioOut = AVCaptureAudioDataOutput()
    private var writer: TrackWriter?
    /// The last recording's writer (for its counts), and frames the camera dropped for being late.
    private(set) var lastWriter: TrackWriter?
    private(set) var lateFrames = 0
    private var cameraOff = false
    private(set) var videoSize = CGSize(width: 1280, height: 720)

    init(cameraID: String) throws {
        self.cameraID = cameraID
        guard let cam = AVCaptureDevice(uniqueID: cameraID) ?? AVCaptureDevice.default(for: .video) else { throw CaptureError.writeFailed("no camera is connected") }
        videoIn = try AVCaptureDeviceInput(device: cam)
        super.init()
    }

    /// Sets the camera up, on its own queue (it takes a moment, and the bar, bubble and pill
    /// mustn't stall while it does). Before anything attaches to the session.
    func configure() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async {
                self.session.beginConfiguration()
                self.session.sessionPreset = .high
                if self.session.canAddInput(self.videoIn) { self.session.addInput(self.videoIn) }
                let dims = CMVideoFormatDescriptionGetDimensions(self.videoIn.device.activeFormat.formatDescription)
                self.videoSize = CGSize(width: Int(dims.width), height: Int(dims.height))
                // The encoder's own format: no conversion on the way in.
                self.videoOut.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
                self.videoOut.alwaysDiscardsLateVideoFrames = true
                self.videoOut.setSampleBufferDelegate(self, queue: self.queue)
                if self.session.canAddOutput(self.videoOut) { self.session.addOutput(self.videoOut) }
                self.session.commitConfiguration()
                done.resume()
            }
        }
    }

    var hasMic: Bool { queue.sync { session.outputs.contains(audioOut) } }

    /// Adds the microphone (as a recording starts), on the camera's queue. Returns whether it could.
    @discardableResult func addMic(_ micID: String) async -> Bool {
        await withCheckedContinuation { done in
            queue.async { done.resume(returning: self.attachMic(micID)) }
        }
    }

    private func attachMic(_ micID: String) -> Bool {
        guard !session.outputs.contains(audioOut),
              let mic = AVCaptureDevice(uniqueID: micID) ?? AVCaptureDevice.default(for: .audio),
              let input = try? AVCaptureDeviceInput(device: mic) else { return session.outputs.contains(audioOut) }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        guard session.canAddInput(input) else { return false }
        session.addInput(input)
        audioOut.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(audioOut) else {
            session.removeInput(input)
            return false
        }
        session.addOutput(audioOut)
        return true
    }

    /// Turns the camera off partway through a recording: no more pictures (its light goes out),
    /// while the microphone carries on. The preview must have let go of the session first.
    func turnOffCamera() {
        queue.async {
            self.cameraOff = true
            self.writer?.endVideo()
            self.session.beginConfiguration()
            self.session.removeOutput(self.videoOut)
            self.session.removeInput(self.videoIn)
            self.session.commitConfiguration()
        }
    }

    /// Starts the camera. Anything that attaches to the session (the preview bubble) must do so
    /// first: changing a session while it starts up makes AVFoundation abort.
    func run() { queue.async { self.session.startRunning() } }

    /// Stops the camera, then (on the main thread) `then`: the place to let go of the preview, which
    /// mustn't detach while the session is still stopping.
    func shutDown(then: @escaping @MainActor () -> Void = {}) {
        queue.async {
            self.session.stopRunning()
            DispatchQueue.main.async { MainActor.assumeIsolated { then() } }
        }
    }

    func startRecording(to url: URL, clock: PauseClock) throws {
        let w = try TrackWriter(url: url, size: videoSize, fps: 30, audioTracks: hasMic ? [(.audio1, 1)] : [], clock: clock)
        queue.sync {
            w.waitsForVideo = !cameraOff
            writer = w
        }
    }

    var firstTime: CMTime? { queue.sync { writer?.firstTime } }

    /// The recording ends now. Sound arrives a moment after it's heard, so the file stays open a
    /// little longer (in `stopRecording`) for the last of what was said, and nothing later.
    func endNow() {
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        queue.async { self.writer?.cutoff = now }
        endedAt = now
    }
    private var endedAt: CMTime?

    func stopRecording() async -> Bool {
        if let end = endedAt {
            let wait = (end + CMTime(value: 300, timescale: 1000) - CMClockGetTime(CMClockGetHostTimeClock())).seconds
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1e9)) }
        }
        return await withCheckedContinuation { done in
            queue.async {
                guard let w = self.writer else { return done.resume(returning: false) }
                self.writer = nil
                self.lastWriter = w
                Task { done.resume(returning: await w.finish()) }
            }
        }
    }

    func cancelRecording() {
        queue.sync {
            writer?.cancel()
            writer = nil
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didDrop sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output === videoOut { lateFrames += 1 }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output === videoOut, cameraOff { return }
        writer?.append(sample, to: output === videoOut ? .video : .audio1)
    }
}
