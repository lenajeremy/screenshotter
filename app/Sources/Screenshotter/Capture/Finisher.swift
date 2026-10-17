import AppKit
import AVFoundation
import CoreImage
import UniformTypeIdentifiers

/// Where the camera bubble sits in the recording and how it looks: its centre (shares of the
/// recording's width and height), its height (a share of the recording's), its proportions, corner
/// roundness (a share of its shorter side; a half is round), whether it's mirrored like the
/// preview, and whether it has a white rim.
struct BubblePlacement: Codable {
    var x: Double
    var y: Double
    var diameter: Double
    var mirrored = true
    var shape = "circle"
    var aspect = 1.0
    var corner = 0.5
    var border = true
}

extension BubblePlacement {
    /// Read leniently: parts saved before a field existed keep its default.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        x = try c.decode(Double.self, forKey: .x)
        y = try c.decode(Double.self, forKey: .y)
        diameter = try c.decode(Double.self, forKey: .diameter)
        mirrored = try c.decodeIfPresent(Bool.self, forKey: .mirrored) ?? true
        shape = try c.decodeIfPresent(String.self, forKey: .shape) ?? "circle"
        aspect = try c.decodeIfPresent(Double.self, forKey: .aspect) ?? 1
        corner = try c.decodeIfPresent(Double.self, forKey: .corner) ?? 0.5
        border = try c.decodeIfPresent(Bool.self, forKey: .border) ?? true
    }
}

/// What a recording was made from, kept beside it for editing later (the screen and camera apart).
struct RecordingParts: Codable {
    var screen: String
    var camera: String?
    /// Seconds the camera started after the screen (negative: before).
    var cameraOffset: Double
    var bubble: BubblePlacement?
    /// Where the bubble went while recording: [seconds, centre x, centre y, height] (shares of the
    /// recording), when it was moved or resized.
    var bubblePath: [[Double]]? = nil
    var systemAudio: Bool
    var microphone: Bool
}

/// Puts a recording together: the screen with the camera bubble drawn in where it sat, and every
/// sound (the Mac's and the microphone) mixed into one track. Without a camera and with at most
/// one sound, the screen recording is used as it is.
enum Finisher {
    static func finish(screen: URL, camera: URL?, parts: RecordingParts, to output: URL) async throws {
        try? FileManager.default.removeItem(at: output)
        let screenAsset = AVURLAsset(url: screen)
        let screenAudio = try await screenAsset.loadTracks(withMediaType: .audio)
        if camera == nil, screenAudio.count <= 1 {
            try FileManager.default.copyItem(at: screen, to: output)
            return
        }
        let comp = AVMutableComposition()
        guard let screenVideo = try await screenAsset.loadTracks(withMediaType: .video).first else { throw CaptureError.noImage }
        let duration = try await screenAsset.load(.duration)
        let whole = CMTimeRange(start: .zero, duration: duration)
        let vTrack = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
        try vTrack.insertTimeRange(whole, of: screenVideo, at: .zero)
        var audioTracks: [(AVAssetTrack, CMTime)] = screenAudio.map { ($0, .zero) }

        var camTrackID: CMPersistentTrackID?
        var camSpan = CMTimeRange.zero
        // Kept for the whole export: a track only works while its asset is alive (the camera's sound
        // went silent when this lived only inside the `if`).
        let camAsset = camera.map { AVURLAsset(url: $0) }
        if let camAsset {
            // The camera started `offset` after the screen (before 0: its start is trimmed).
            let offset = CMTime(seconds: parts.cameraOffset, preferredTimescale: 600)
            if let camVideo = try await camAsset.loadTracks(withMediaType: .video).first {
                let camRange = try await camVideo.load(.timeRange)
                let trim = offset < .zero ? CMTimeMinimum(.zero - offset, camRange.duration) : .zero
                let at = max(.zero, offset)
                let length = CMTimeMinimum(camRange.duration - trim, duration - at)
                if length > .zero {
                    let cTrack = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
                    try cTrack.insertTimeRange(CMTimeRange(start: camRange.start + trim, duration: length), of: camVideo, at: at)
                    camTrackID = cTrack.trackID
                    camSpan = CMTimeRange(start: at, duration: length)
                }
            }
            // The microphone, which carries on when the camera is turned off partway.
            for a in try await camAsset.loadTracks(withMediaType: .audio) { audioTracks.append((a, offset)) }
        }
        for (track, at) in audioTracks {
            let a = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
            let range = try await track.load(.timeRange)
            let start = max(.zero, at)
            let skip = at < .zero ? .zero - at : .zero
            let length = CMTimeMinimum(range.duration - skip, duration - start)
            guard length > .zero else { continue }
            do { try a.insertTimeRange(CMTimeRange(start: range.start + skip, duration: length), of: track, at: start) }
            catch { NSLog("Screenshotter: a sound track was left out of the recording: \(error)") }
        }

        guard let export = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHighestQuality) else { throw CaptureError.writeFailed("no exporter") }
        if let camTrackID, let bubble = parts.bubble {
            let size = try await screenVideo.load(.naturalSize)
            let video = AVMutableVideoComposition()
            video.customVideoCompositorClass = BubbleCompositor.self
            video.renderSize = size
            video.frameDuration = CMTime(value: 1, timescale: 60)
            video.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
            video.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
            video.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
            // The bubble only while the camera was on: before and after it, the screen alone (a
            // track that has ended would otherwise hold its last frame).
            let span = camSpan.intersection(whole)
            var instructions: [BubbleInstruction] = []
            if span.start > .zero { instructions.append(BubbleInstruction(range: CMTimeRange(start: .zero, end: span.start), screen: vTrack.trackID, camera: nil, bubble: bubble, size: size)) }
            instructions.append(BubbleInstruction(range: span, screen: vTrack.trackID, camera: camTrackID, bubble: bubble, size: size, path: parts.bubblePath))
            if span.end < duration { instructions.append(BubbleInstruction(range: CMTimeRange(start: span.end, end: duration), screen: vTrack.trackID, camera: nil, bubble: bubble, size: size)) }
            video.instructions = instructions
            export.videoComposition = video
        }
        // Every sound together in one track: a player only plays the first of several.
        let mix = AVMutableAudioMix()
        mix.inputParameters = comp.tracks(withMediaType: .audio).map { AVMutableAudioMixInputParameters(track: $0) }
        export.audioMix = mix
        export.outputURL = output
        export.outputFileType = .mp4
        export.shouldOptimizeForNetworkUse = true
        try await run(export, "the video didn't finish")
        withExtendedLifetime(camAsset) {}
    }

    // MARK: For editing in Screenshotter

    /// The screen's picture as it is (copied, not re-encoded, so it's quick) with every sound (the
    /// Mac's and your voice, on the screen's clock) mixed into one track: the recording the
    /// Studio edits and plays.
    static func editable(screen: URL, camera: URL?, parts: RecordingParts, to output: URL) async throws {
        try? FileManager.default.removeItem(at: output)
        let screenAsset = AVURLAsset(url: screen)
        let camAsset = camera.map { AVURLAsset(url: $0) }
        let duration = try await screenAsset.load(.duration)
        let screenSounds = try await screenAsset.loadTracks(withMediaType: .audio)
        var sounds: [(AVAssetTrack, CMTime)] = screenSounds.map { ($0, .zero) }
        if let camAsset {
            for a in try await camAsset.loadTracks(withMediaType: .audio) { sounds.append((a, CMTime(seconds: parts.cameraOffset, preferredTimescale: 600))) }
        }
        // Just the screen's own sound, or none: the screen recording is the file.
        if sounds.count == screenSounds.count, sounds.count <= 1 {
            try FileManager.default.copyItem(at: screen, to: output)
            return
        }
        // 1. The sounds, mixed into one track (a player plays only the first of several).
        let mixURL = output.deletingLastPathComponent().appendingPathComponent(".\(output.deletingPathExtension().lastPathComponent)-sound.m4a")
        try? FileManager.default.removeItem(at: mixURL)
        defer { try? FileManager.default.removeItem(at: mixURL) }
        let soundComp = AVMutableComposition()
        try await insertSounds(sounds, into: soundComp, length: duration)
        guard let mixer = AVAssetExportSession(asset: soundComp, presetName: AVAssetExportPresetAppleM4A) else { throw CaptureError.writeFailed("no sound mixer") }
        let mix = AVMutableAudioMix()
        mix.inputParameters = soundComp.tracks(withMediaType: .audio).map { AVMutableAudioMixInputParameters(track: $0) }
        mixer.audioMix = mix
        mixer.outputURL = mixURL
        mixer.outputFileType = .m4a
        try await run(mixer, "the sound didn't mix")
        // 2. The picture, copied, with that track.
        let mixAsset = AVURLAsset(url: mixURL)
        let comp = AVMutableComposition()
        guard let picture = try await screenAsset.loadTracks(withMediaType: .video).first else { throw CaptureError.noImage }
        let v = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
        try v.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: picture, at: .zero)
        if let sound = try await mixAsset.loadTracks(withMediaType: .audio).first {
            let range = try await sound.load(.timeRange)
            let a = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
            try a.insertTimeRange(CMTimeRange(start: range.start, duration: CMTimeMinimum(range.duration, duration)), of: sound, at: .zero)
        }
        guard let copier = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough) else { throw CaptureError.writeFailed("no exporter") }
        copier.outputURL = output
        copier.outputFileType = .mp4
        copier.shouldOptimizeForNetworkUse = true
        try await run(copier, "the recording didn't save")
        withExtendedLifetime((screenAsset, camAsset, mixAsset)) {}
    }

    /// Runs an export, giving up when it stops moving for 30 seconds: macOS's video encoder can
    /// get stuck, and a capture shouldn't wait on it for ever.
    private static func run(_ export: AVAssetExportSession, _ failure: String) async throws {
        nonisolated(unsafe) let session = export
        let watchdog = Task.detached {
            var last: Float = -1
            var still = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                let p = session.progress
                if p > last { last = p; still = 0 } else { still += 1 }
                if still >= 30 { return session.cancelExport() }
            }
        }
        await export.export()
        watchdog.cancel()
        if export.status == .cancelled { throw CaptureError.writeFailed("macOS's video encoder stopped responding. Try again; if it keeps happening, restart your Mac.") }
        if export.status != .completed { throw export.error ?? CaptureError.writeFailed(failure) }
    }

    /// Sound tracks placed on a clock (`at` before 0 trims their start), cut at `length`.
    private static func insertSounds(_ sounds: [(AVAssetTrack, CMTime)], into comp: AVMutableComposition, length: CMTime) async throws {
        for (track, at) in sounds {
            let range = try await track.load(.timeRange)
            let start = max(.zero, at)
            let skip = at < .zero ? .zero - at : .zero
            let span = CMTimeMinimum(range.duration - skip, length - start)
            guard span > .zero else { continue }
            let a = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
            do { try a.insertTimeRange(CMTimeRange(start: range.start + skip, duration: span), of: track, at: start) }
            catch { NSLog("Screenshotter: a sound track was left out of the recording: \(error)") }
        }
    }

    /// The camera as its own clip on the screen's clock: cropped to the bubble's proportions from the
    /// middle of the picture, mirrored if the bubble was, without sound (that's in the recording).
    /// Returns when on that clock the camera stopped (it may have been turned off partway).
    static func cameraClip(camera: URL, parts: RecordingParts, length screenLength: CMTime, to output: URL) async throws -> Double {
        try? FileManager.default.removeItem(at: output)
        let asset = AVURLAsset(url: camera)
        guard let picture = try await asset.loadTracks(withMediaType: .video).first else { throw CaptureError.noImage }
        let range = try await picture.load(.timeRange)
        let natural = try await picture.load(.naturalSize)
        let offset = CMTime(seconds: parts.cameraOffset, preferredTimescale: 600)
        let trim = offset < .zero ? CMTimeMinimum(.zero - offset, range.duration) : .zero
        let at = max(.zero, offset)
        let length = CMTimeMinimum(range.duration - trim, screenLength - at)
        guard length > .zero else { throw CaptureError.noImage }
        let comp = AVMutableComposition()
        let track = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
        if at > .zero {
            // Started after the screen: its first frame waits until then.
            let first = CMTimeRange(start: range.start + trim, duration: CMTime(value: 1, timescale: 30))
            try track.insertTimeRange(first, of: picture, at: .zero)
            track.scaleTimeRange(CMTimeRange(start: .zero, duration: first.duration), toDuration: at)
        }
        try track.insertTimeRange(CMTimeRange(start: range.start + trim, duration: length), of: picture, at: at)
        // The bubble's proportions, from the middle of the picture.
        let aspect = max(0.2, parts.bubble?.aspect ?? 1)
        let crop = natural.width / natural.height > aspect
            ? CGRect(x: (natural.width - natural.height * aspect) / 2, y: 0, width: natural.height * aspect, height: natural.height)
            : CGRect(x: 0, y: (natural.height - natural.width / aspect) / 2, width: natural.width, height: natural.width / aspect)
        let outH = (min(1080, crop.height) / 2).rounded() * 2
        let outW = (outH * aspect / 2).rounded() * 2
        let mirrored = parts.bubble?.mirrored ?? true
        let video = AVMutableVideoComposition(asset: comp) { request in
            var img = request.sourceImage.cropped(to: crop).transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
            if mirrored { img = img.transformed(by: CGAffineTransform(scaleX: -1, y: 1).translatedBy(x: -crop.width, y: 0)) }
            img = img.transformed(by: CGAffineTransform(scaleX: outW / crop.width, y: outH / crop.height))
            request.finish(with: img, context: nil)
        }
        video.renderSize = CGSize(width: outW, height: outH)
        video.frameDuration = CMTime(value: 1, timescale: 30)
        video.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
        video.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
        video.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
        guard let export = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHighestQuality) else { throw CaptureError.writeFailed("no exporter") }
        export.videoComposition = video
        export.outputURL = output
        export.outputFileType = .mp4
        try await run(export, "the camera clip didn't save")
        withExtendedLifetime(asset) {}
        return (at + length).seconds
    }

    /// The recording's first moment as its poster: the picture the Studio and the panel show for it.
    static func poster(for video: URL, at url: URL) async -> CGImage? {
        let gen = AVAssetImageGenerator(asset: AVURLAsset(url: video))
        gen.appliesPreferredTrackTransform = true
        gen.requestedTimeToleranceBefore = .zero
        gen.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 2)
        guard let (image, _) = try? await gen.image(at: CMTime(value: 1, timescale: 10)) else { return nil }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? ScreenShot.writePNG(image, to: url, scale: 2)
        return image
    }
}

final class BubbleInstruction: NSObject, AVVideoCompositionInstructionProtocol {
    let timeRange: CMTimeRange
    let enablePostProcessing = false
    let containsTweening = true
    let requiredSourceTrackIDs: [NSValue]?
    let passthroughTrackID = kCMPersistentTrackID_Invalid
    let screen: CMPersistentTrackID
    /// The camera's track, or nil for a stretch without it.
    let camera: CMPersistentTrackID?
    let bubble: BubblePlacement
    let size: CGSize
    /// Where it went, when it was moved: [seconds, x, y, height].
    let path: [[Double]]?

    init(range: CMTimeRange, screen: CMPersistentTrackID, camera: CMPersistentTrackID?, bubble: BubblePlacement, size: CGSize, path: [[Double]]? = nil) {
        timeRange = range
        self.screen = screen
        self.camera = camera
        self.bubble = bubble
        self.size = size
        self.path = path
        requiredSourceTrackIDs = ([screen] + (camera.map { [$0] } ?? [])).map { NSNumber(value: $0) }
    }
}

/// Draws each frame: the screen, then the camera cropped to a circle (mirrored like the preview),
/// with a thin white rim and a soft shadow, where the bubble was on screen.
final class BubbleCompositor: NSObject, AVVideoCompositing {
    private let context = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!])
    let sourcePixelBufferAttributes: [String: any Sendable]? = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    let requiredPixelBufferAttributesForRenderContext: [String: any Sendable] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        guard let ins = request.videoCompositionInstruction as? BubbleInstruction,
              let screen = request.sourceFrame(byTrackID: ins.screen),
              let out = request.renderContext.newPixelBuffer() else {
            return request.finish(with: CaptureError.noImage)
        }
        var image = CIImage(cvPixelBuffer: screen)
        if let id = ins.camera, let cam = request.sourceFrame(byTrackID: id) {
            var place = ins.bubble
            if let path = ins.path, let p = BubbleCompositor.along(path, at: request.compositionTime.seconds) {
                place.x = p[1]
                place.y = p[2]
                place.diameter = p[3]
            }
            image = BubbleCompositor.bubble(CIImage(cvPixelBuffer: cam), place, in: ins.size).composited(over: image)
        }
        context.render(image, to: out)
        request.finish(withComposedVideoFrame: out)
    }

    /// Where the bubble was at `t` along its path. The path notes only changes: between notes close
    /// together (a drag) it was in between them; after a long gap it had stayed where it was.
    static func along(_ path: [[Double]], at t: Double) -> [Double]? {
        guard let first = path.first, first.count == 4 else { return nil }
        if t <= first[0] { return first }
        for k in 1..<path.count where path[k].count == 4 && path[k][0] >= t {
            let a = path[k - 1]
            let b = path[k]
            if b[0] - a[0] > 0.12 { return a }
            let p = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 1
            return (0..<4).map { a[$0] + (b[$0] - a[$0]) * p }
        }
        return path.last
    }

    /// The camera as a bubble placed for a frame of `size` (Core Image measures from the bottom left).
    static func bubble(_ camera: CIImage, _ p: BubblePlacement, in size: CGSize) -> CIImage {
        let h = max(40, p.diameter * size.height)
        let w = h * max(0.2, p.aspect)
        let center = CGPoint(x: p.x * size.width, y: (1 - p.y) * size.height)
        // Fill the bubble with the middle of the camera's picture, mirrored if the preview was.
        var cam = camera
        let ext = cam.extent
        let want = w / h
        let crop = ext.width / ext.height > want
            ? CGRect(x: ext.midX - ext.height * want / 2, y: ext.minY, width: ext.height * want, height: ext.height)
            : CGRect(x: ext.minX, y: ext.midY - ext.width / want / 2, width: ext.width, height: ext.width / want)
        cam = cam.cropped(to: crop)
        cam = cam.transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
        if p.mirrored { cam = cam.transformed(by: CGAffineTransform(scaleX: -1, y: 1).translatedBy(x: -crop.width, y: 0)) }
        cam = cam.transformed(by: CGAffineTransform(scaleX: w / crop.width, y: h / crop.height))
        cam = cam.transformed(by: CGAffineTransform(translationX: center.x - w / 2, y: center.y - h / 2))
        let box = CGRect(x: center.x - w / 2, y: center.y - h / 2, width: w, height: h)
        let corner = min(w, h) * min(0.5, max(0, p.corner))
        let mask = BubbleCompositor.outline(box, corner: corner)
        var out = cam.applyingFilter("CIBlendWithAlphaMask", parameters: [kCIInputBackgroundImageKey: CIImage.empty(), kCIInputMaskImageKey: mask])
        let rim = h * 0.018
        if p.border {
            out = out.composited(over: BubbleCompositor.outline(box.insetBy(dx: -rim, dy: -rim), corner: corner + rim, color: CIColor(red: 1, green: 1, blue: 1, alpha: 0.92)))
        }
        let shadow = BubbleCompositor.outline(box.insetBy(dx: -rim, dy: -rim).offsetBy(dx: 0, dy: -h * 0.03), corner: corner + rim, color: CIColor(red: 0, green: 0, blue: 0, alpha: 0.35))
            .applyingGaussianBlur(sigma: h * 0.045)
        return out.composited(over: shadow)
    }

    /// A filled shape: a circle when the corners are half of a square's side, else a rectangle with
    /// rounded (or square) corners.
    static func outline(_ box: CGRect, corner: CGFloat, color: CIColor = .white) -> CIImage {
        if abs(box.width - box.height) < 1, corner >= box.width / 2 - 0.5 {
            let r = box.width / 2
            let g = CIFilter(name: "CIRadialGradient", parameters: [
                "inputCenter": CIVector(x: box.midX, y: box.midY),
                "inputRadius0": max(0, r - 1),
                "inputRadius1": r,
                "inputColor0": color,
                "inputColor1": CIColor(red: color.red, green: color.green, blue: color.blue, alpha: 0),
            ])
            return (g?.outputImage ?? CIImage.empty()).cropped(to: box.insetBy(dx: -1, dy: -1))
        }
        let shape = CIFilter(name: "CIRoundedRectangleGenerator", parameters: ["inputExtent": CIVector(cgRect: box), "inputRadius": max(0, corner), "inputColor": color])
        return shape?.outputImage ?? CIImage.empty()
    }
}
