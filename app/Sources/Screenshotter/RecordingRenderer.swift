import AVFoundation
import CoreImage
import Metal

/// `Screenshotter --render-recording <spec.json>`: draws a screen recording's video on the GPU, for
/// the engine's export. The engine works out every frame (the camera's zooms and follow, each
/// layer's animation, the cursor's path) exactly as the Studio previews it, and draws what it
/// can't hand over (the backdrop, text, stickers) once per look, as pictures; this puts it all
/// together frame by frame: the recordings decoded in order by the hardware, composited with Core
/// Image on the GPU, encoded by the media engine. The picture only: the engine adds the sound.
enum RecordingRenderer {
    struct Spec: Decodable {
        var output: String
        var width: Int
        var height: Int
        var fps: Int
        var frames: Int
        var codec: String?
        /// Per frame: zoom, focus x, focus y, move x, move y (output px, from the top left).
        var camera: [[Double]]?
        /// Bottom to top.
        var layers: [Layer]
    }

    struct Layer: Decodable {
        /// "image" (one picture), "frames" (a picture per look, `index` per frame) or "video".
        var type: String
        var file: String?
        var files: [String]?
        var index: [Int]?
        /// Moves with the camera (false: a webcam that stays put).
        var camera: Bool?
        /// x, y, width, height in output px from the top left.
        var rect: [Double]?
        var radius: Double?
        var ring: Ring?
        var shadow: Shadow?
        /// Per frame: opacity, move x, move y, scale x, scale y, turn (degrees).
        var states: [[Double]]?
        var cursor: Cursor?
    }

    struct Ring: Decodable {
        var width: Double
        var color: String
    }

    struct Shadow: Decodable {
        var blur: Double
        var dy: Double
        var opacity: Double
    }

    struct Cursor: Decodable {
        var step: Double
        var xs: [Double]
        var ys: [Double]
        var kinds: [Kind]
        var clicks: [[Double]]
        var images: [String: Picture]
        var ripple: Picture?
    }

    struct Kind: Decodable {
        var t: Double
        var kind: String
    }

    /// A picture of a cursor (its point at `hot`) or of the click ring, in output px.
    struct Picture: Decodable {
        var file: String
        var hot: [Double]?
    }

    static func run(_ specURL: URL) -> Int32 {
        do {
            let spec = try JSONDecoder().decode(Spec.self, from: Data(contentsOf: specURL))
            try render(spec)
            return 0
        } catch {
            FileHandle.standardError.write(Data("render failed: \(error.localizedDescription)\n".utf8))
            return 1
        }
    }

    // MARK: Drawing

    private static func render(_ spec: Spec) throws {
        let W = CGFloat(spec.width / 2 * 2)
        let H = CGFloat(spec.height / 2 * 2)
        let canvas = CGRect(x: 0, y: 0, width: W, height: H)
        let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
        let context: CIContext = MTLCreateSystemDefaultDevice().map { CIContext(mtlDevice: $0, options: [.workingColorSpace: srgb, .cacheIntermediates: false]) }
            ?? CIContext(options: [.workingColorSpace: srgb])

        // The video, written as frames are drawn.
        let out = URL(fileURLWithPath: spec.output)
        try? FileManager.default.removeItem(at: out)
        let writer = try AVAssetWriter(outputURL: out, fileType: out.pathExtension.lowercased() == "mov" ? .mov : .mp4)
        let hevc = spec.codec == "hevc" || W > 4096 || H > 2304
        let bits = min(120_000_000, max(8_000_000, Int(W * H * CGFloat(spec.fps) * 0.14)))
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
            AVVideoWidthKey: Int(W),
            AVVideoHeightKey: Int(H),
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bits,
                AVVideoExpectedSourceFrameRateKey: spec.fps,
                AVVideoMaxKeyFrameIntervalKey: spec.fps * 2,
            ] as [String: Any],
            // HD video's colours, said in the file, so every player shows them as drawn.
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(W),
            kCVPixelBufferHeightKey as String: Int(H),
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        ])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? CaptureError.writeFailed("the video couldn't start") }
        writer.startSession(atSourceTime: .zero)

        // Each layer's sources, opened once.
        var pictures: [String: CIImage] = [:]
        func picture(_ path: String) -> CIImage? {
            if let p = pictures[path] { return p }
            guard let img = CIImage(contentsOf: URL(fileURLWithPath: path)) else { return nil }
            // Pictures come in at their own size, top-left first: placed on the canvas's grid.
            let placed = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX, y: -img.extent.minY))
            pictures[path] = placed
            return placed
        }
        var videos: [Int: VideoSource] = [:]
        for (k, layer) in spec.layers.enumerated() where layer.type == "video" {
            if let f = layer.file { videos[k] = try VideoSource(url: URL(fileURLWithPath: f)) }
        }

        // From the top-left coordinates the engine uses to Core Image's (from the bottom left).
        let flip = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: H)
        func ci(_ t: CGAffineTransform) -> CGAffineTransform { flip.concatenating(t).concatenating(flip) }
        func box(_ r: [Double]) -> CGRect { CGRect(x: r[0], y: H - r[1] - r[3], width: r[2], height: r[3]) }

        for i in 0..<spec.frames {
            autoreleasepool {
                let t = Double(i) / Double(spec.fps)
                // The camera this frame (top-left coordinates).
                var cam = CGAffineTransform.identity
                if let c = spec.camera, i < c.count, c[i].count >= 5, c[i][0] > 1.0005 {
                    let v = c[i]
                    cam = CGAffineTransform(translationX: -v[1], y: -v[2])
                        .concatenating(CGAffineTransform(scaleX: v[0], y: v[0]))
                        .concatenating(CGAffineTransform(translationX: v[1] + v[3], y: v[2] + v[4]))
                }
                var frame = CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: canvas)
                for (k, layer) in spec.layers.enumerated() {
                    let moves = layer.camera ?? true
                    var img: CIImage?
                    var own = CGAffineTransform.identity
                    var opacity = 1.0
                    switch layer.type {
                    case "image":
                        img = layer.file.flatMap(picture)
                    case "frames":
                        if let files = layer.files, let index = layer.index, !index.isEmpty {
                            let n = index[min(i, index.count - 1)]
                            if n >= 0, n < files.count { img = picture(files[n]) }
                        }
                    case "video":
                        guard let r = layer.rect, r.count == 4 else { break }
                        let rect = box(r)
                        if let s = layer.states, i < s.count, s[i].count >= 6 {
                            let st = s[i]
                            opacity = st[0]
                            // About the layer's middle, as CSS turns and scales it (top-left coordinates).
                            let cx = r[0] + r[2] / 2
                            let cy = r[1] + r[3] / 2
                            own = CGAffineTransform(translationX: -cx, y: -cy)
                                .concatenating(CGAffineTransform(scaleX: st[3], y: st[4]))
                                .concatenating(CGAffineTransform(rotationAngle: st[5] * .pi / 180))
                                .concatenating(CGAffineTransform(translationX: cx + st[1], y: cy + st[2]))
                        }
                        img = videoLayer(layer, rect: rect, source: videos[k]?.image(at: t), t: t, H: H)
                    default:
                        break
                    }
                    guard var layerImage = img, opacity > 0.001 else { continue }
                    if opacity < 0.999 {
                        layerImage = layerImage.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(opacity))])
                    }
                    let whole = moves ? own.concatenating(cam) : own
                    if !whole.isIdentity { layerImage = layerImage.transformed(by: ci(whole)) }
                    frame = layerImage.composited(over: frame)
                }
                frame = frame.cropped(to: canvas)
                while !input.isReadyForMoreMediaData { usleep(2000) }
                var buffer: CVPixelBuffer?
                if let pool = adaptor.pixelBufferPool { CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) }
                guard let pb = buffer else { return }
                context.render(frame, to: pb, bounds: canvas, colorSpace: srgb)
                adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: CMTimeScale(spec.fps)))
                if i % 15 == 0 || i == spec.frames - 1 {
                    print("progress \(i + 1)/\(spec.frames)")
                    fflush(stdout)
                }
            }
        }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        if writer.status != .completed { throw writer.error ?? CaptureError.writeFailed("the video didn't finish") }
    }

    /// A video layer: the frame filling its box (trimmed to its shape), its ring and shadow, and the
    /// recording's cursor drawn over it.
    private static func videoLayer(_ layer: Layer, rect: CGRect, source: CIImage?, t: Double, H: CGFloat) -> CIImage? {
        guard let src = source else { return nil }
        let e = src.extent
        let s = max(rect.width / e.width, rect.height / e.height)
        var img = src.transformed(by: CGAffineTransform(translationX: -e.minX, y: -e.minY).concatenating(CGAffineTransform(scaleX: s, y: s)))
        img = img.transformed(by: CGAffineTransform(translationX: rect.midX - e.width * s / 2, y: rect.midY - e.height * s / 2)).cropped(to: rect)
        let radius = min(CGFloat(layer.radius ?? 0), min(rect.width, rect.height) / 2)
        if radius > 0.5 {
            img = img.applyingFilter("CIBlendWithAlphaMask", parameters: [kCIInputBackgroundImageKey: CIImage.empty(), kCIInputMaskImageKey: rounded(rect, radius, .white)])
        }
        // The cursor over the recording, kept within it.
        if let c = layer.cursor, let drawn = cursor(c, rect: rect, t: t, H: H) { img = drawn.cropped(to: rect).composited(over: img) }
        if let ring = layer.ring, ring.width > 0 {
            let w = CGFloat(ring.width)
            let outer = rounded(rect, radius, color(ring.color))
            let inner = rounded(rect.insetBy(dx: w, dy: w), max(0, radius - w), .white)
            img = outer.applyingFilter("CISourceOutCompositing", parameters: [kCIInputBackgroundImageKey: inner]).composited(over: img)
        }
        if let sh = layer.shadow, sh.opacity > 0 {
            let shade = rounded(rect, radius, CIColor(red: 0, green: 0, blue: 0, alpha: CGFloat(sh.opacity)))
                .applyingGaussianBlur(sigma: max(0.1, sh.blur / 2))
                .transformed(by: CGAffineTransform(translationX: 0, y: -CGFloat(sh.dy)))
            img = img.composited(over: shade)
        }
        return img
    }

    /// The cursor where its path has it at `t` (the cursor macOS showed, dipping as it clicks), and
    /// the ring where the latest click landed.
    private static func cursor(_ c: Cursor, rect: CGRect, t: Double, H: CGFloat) -> CIImage? {
        let n = c.xs.count
        guard n > 0 else { return nil }
        let f = max(0, t / c.step)
        let i = min(n - 1, Int(f))
        let j = min(n - 1, i + 1)
        let px = c.xs[i] + (c.xs[j] - c.xs[i]) * (f - Double(i))
        let py = c.ys[i] + (c.ys[j] - c.ys[i]) * (f - Double(i))
        guard px >= -0.01, px <= 1.01, py >= -0.01, py <= 1.01 else { return nil }
        var kind = "arrow"
        for k in c.kinds {
            if k.t > t { break }
            kind = k.kind
        }
        var click: [Double]?
        for k in c.clicks where k.count >= 3 {
            if k[0] > t + 0.06 { break }
            click = k
        }
        let since = click.map { t - $0[0] }
        // Where it points, in Core Image's coordinates.
        let at = CGPoint(x: rect.minX + CGFloat(px) * rect.width, y: rect.maxY - CGFloat(py) * rect.height)
        var out = CIImage.empty()
        if let ripple = c.ripple, let k = click, let since, since >= 0, since <= 0.5, let ring = loaded(ripple.file) {
            let p = since / 0.5
            let scale = CGFloat(0.45 + p * 0.9)
            let centre = CGPoint(x: rect.minX + CGFloat(k[1]) * rect.width, y: rect.maxY - CGFloat(k[2]) * rect.height)
            let e = ring.extent
            var r = ring.transformed(by: CGAffineTransform(translationX: -e.width / 2, y: -e.height / 2)
                .concatenating(CGAffineTransform(scaleX: scale, y: scale))
                .concatenating(CGAffineTransform(translationX: centre.x, y: centre.y)))
            r = r.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(max(0, 1 - p)))])
            out = r.composited(over: out)
        }
        guard let pic = c.images[kind] ?? c.images["arrow"], let art = loaded(pic.file) else { return out }
        let press: CGFloat = (since.map { $0 >= 0 && $0 < 0.14 } ?? false) ? 0.86 : 1
        let hot = pic.hot ?? [0, 0]
        let e = art.extent
        // The picture's top-left corner sits up and left of the point by the hot spot, and a press
        // shrinks it toward the point.
        let placed = art.transformed(by: CGAffineTransform(translationX: -CGFloat(hot[0]), y: -(e.height - CGFloat(hot[1])))
            .concatenating(CGAffineTransform(scaleX: press, y: press))
            .concatenating(CGAffineTransform(translationX: at.x, y: at.y)))
        return placed.composited(over: out)
    }

    private nonisolated(unsafe) static var cache: [String: CIImage] = [:]
    private static func loaded(_ path: String) -> CIImage? {
        if let c = cache[path] { return c }
        guard let img = CIImage(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        let placed = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX, y: -img.extent.minY))
        cache[path] = placed
        return placed
    }

    private static func rounded(_ r: CGRect, _ radius: CGFloat, _ color: CIColor) -> CIImage {
        let f = CIFilter(name: "CIRoundedRectangleGenerator", parameters: ["inputExtent": CIVector(cgRect: r), "inputRadius": max(0, radius), "inputColor": color])
        return f?.outputImage?.cropped(to: r) ?? CIImage.empty()
    }

    /// "#rrggbb" (or "#rgb", "white", "black").
    private static func color(_ s: String) -> CIColor {
        var hex = s.trimmingCharacters(in: .whitespaces).lowercased()
        if hex == "white" { return .white }
        if hex == "black" { return .black }
        hex = hex.replacingOccurrences(of: "#", with: "")
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count >= 6, let v = UInt32(hex.prefix(6), radix: 16) else { return .white }
        return CIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255)
    }
}

/// A video's frames in order, decoded by the hardware: the frame showing at each time asked for,
/// holding its last one past its end (as the Studio's export does).
final class VideoSource {
    private let reader: AVAssetReader
    private let output: AVAssetReaderTrackOutput
    private var current: CIImage?
    private var upcoming: CMSampleBuffer?
    private let asset: AVURLAsset

    init(url: URL) throws {
        asset = AVURLAsset(url: url)
        reader = try AVAssetReader(asset: asset)
        let sem = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var found: AVAssetTrack?
        asset.loadTracks(withMediaType: .video) { tracks, _ in
            found = tracks?.first
            sem.signal()
        }
        sem.wait()
        guard let track = found else { throw CaptureError.noImage }
        output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? CaptureError.noImage }
    }

    func image(at t: Double) -> CIImage? {
        while true {
            if upcoming == nil { upcoming = output.copyNextSampleBuffer() }
            guard let next = upcoming else { break }
            let at = CMSampleBufferGetPresentationTimeStamp(next).seconds
            if current != nil, at > t + 0.0005 { break }
            if let pb = CMSampleBufferGetImageBuffer(next) { current = CIImage(cvPixelBuffer: pb) }
            upcoming = nil
        }
        return current
    }
}
