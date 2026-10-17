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
    /// Whether the file waits for a picture to start. Off once the camera is turned off, so a
    /// recording whose camera went off before its first frame still keeps your voice.
    var waitsForVideo = true

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
        guard !finished, CMSampleBufferDataIsReady(sample) else { return }
        let t = CMSampleBufferGetPresentationTimeStamp(sample)
        guard let at = clock.shifted(t) else { return }
        if firstTime == nil {
            // Audio before the first frame has nothing to go with.
            guard track == .video || !waitsForVideo, writer.startWriting() else { return }
            writer.startSession(atSourceTime: at)
            firstTime = t
        }
        let input = track == .video ? video : audio[track]
        guard let input, input.isReadyForMoreMediaData else { return }
        let out = at == t ? sample : retimed(sample, by: t - at)
        if let out, input.append(out) { lastTime = max(lastTime, at) }
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
        video.markAsFinished()
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
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
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

    func start() async throws {
        try await stream.startCapture()
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
    private var cameraOff = false
    private(set) var videoSize = CGSize(width: 1280, height: 720)

    init(cameraID: String) throws {
        self.cameraID = cameraID
        guard let cam = AVCaptureDevice(uniqueID: cameraID) ?? AVCaptureDevice.default(for: .video) else { throw CaptureError.writeFailed("no camera is connected") }
        videoIn = try AVCaptureDeviceInput(device: cam)
        super.init()
        session.beginConfiguration()
        session.sessionPreset = .high
        if session.canAddInput(videoIn) { session.addInput(videoIn) }
        let dims = CMVideoFormatDescriptionGetDimensions(cam.activeFormat.formatDescription)
        videoSize = CGSize(width: Int(dims.width), height: Int(dims.height))
        videoOut.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        videoOut.alwaysDiscardsLateVideoFrames = true
        videoOut.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(videoOut) { session.addOutput(videoOut) }
        session.commitConfiguration()
    }

    var hasMic: Bool { queue.sync { session.outputs.contains(audioOut) } }

    /// Adds the microphone (as a recording starts). Returns whether it could.
    @discardableResult func addMic(_ micID: String) -> Bool {
        queue.sync {
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
    }

    /// Turns the camera off partway through a recording: no more pictures (its light goes out),
    /// while the microphone carries on. The preview must have let go of the session first.
    func turnOffCamera() {
        queue.async {
            self.cameraOff = true
            self.writer?.waitsForVideo = false
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

    func stopRecording() async -> Bool {
        await withCheckedContinuation { done in
            queue.async {
                guard let w = self.writer else { return done.resume(returning: false) }
                self.writer = nil
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

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output === videoOut, cameraOff { return }
        writer?.append(sample, to: output === videoOut ? .video : .audio1)
    }
}
