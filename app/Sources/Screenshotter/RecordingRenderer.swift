import AVFoundation
import CoreImage
import Metal

/// `Screenshotter --render-recording <spec.json>`: draws a video's frames on the GPU, for the
/// engine's export. The engine works out everything (each part of the design drawn once as a
/// picture by the browser, where each part is on every frame, where the videos land, the cursor),
/// exactly as the Studio previews it; this puts it together frame by frame: the videos decoded in
/// order by the hardware, everything composited with Core Image, encoded by the media engine.
/// The picture only: the engine adds the sound.
enum RecordingRenderer {
    struct Spec: Decodable {
        var output: String
        var width: Int
        var height: Int
        var fps: Int
        var frames: Int
        /// "h264" (default), "hevc", "prores" (422 HQ) or "prores4444" (keeps transparency).
        var codec: String?
        var bitrate: Int?
        /// H.264 High 4.0, as Apple's app previews ask.
        var appStore: Bool?
        /// No backdrop under it all (a transparent design, written with its alpha).
        var transparent: Bool?
        /// Bottom to top.
        var layers: [Layer]
    }

    struct Layer: Decodable {
        /// "picture", "video", "fill", "grain" or "blur".
        var type: String
        // A picture: one file, or one per look (`files`, `index` per frame, -1 for none), placed at
        // `rect` (or `rects`, one per file), moved per frame by `matrix` (a, b, c, d, tx, ty).
        var file: String?
        var files: [String]?
        var index: [Int]?
        var rect: [Double]?
        var rects: [[Double]]?
        var matrix: [[Double]]?
        /// Instead of `matrix`: the corners (top left, top right, bottom right, bottom left) the
        /// picture lands on each frame (a device turned in 3D).
        var quads: [[Double]]?
        var opacity: [Double]?
        var blur: [Double]?
        var hue: [Double]?
        var blend: String?
        // A video: its box (width, height) before it's placed, the corners it lands on each frame
        // (`quads`), its corners' rounding, the part of the
        // source it shows, a colour matrix (the design's grade), and the cursor over it.
        var box: [Double]?
        /// Where the video itself sits in its box, top-left px (wider or taller than it, trimmed).
        var inner: [Double]?
        var radius: Double?
        var crop: [Double]?
        var colorMatrix: [Double]?
        var cursor: Cursor?
        // A fill (a grade's wash): one colour over the canvas, blended.
        var color: String?
        var amount: Double?
        // Grain: a tile repeated across `rect`, moved each frame by `offsets`.
        var tile: Double?
        var offsets: [[Double]]?
        // A blur band: blurs what's under `rect` by `radius`, fading out toward `toward` ("up"/"down"),
        // fully blurred over the first `solid` share of the band.
        var radiusPx: Double?
        var toward: String?
        var solid: Double?
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

    /// A picture of a cursor (its point at `hot`) or of the click ring, in the box's px.
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
        let codec = spec.codec ?? "h264"
        let prores = codec.hasPrefix("prores")
        let writer = try AVAssetWriter(outputURL: out, fileType: prores || out.pathExtension.lowercased() == "mov" ? .mov : .mp4)
        var settings: [String: Any] = [AVVideoWidthKey: Int(W), AVVideoHeightKey: Int(H)]
        if prores {
            settings[AVVideoCodecKey] = codec == "prores4444" ? AVVideoCodecType.proRes4444 : AVVideoCodecType.proRes422HQ
        } else {
            let hevc = codec == "hevc" || W > 4096 || H > 2304
            settings[AVVideoCodecKey] = hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264
            var props: [String: Any] = [
                AVVideoAverageBitRateKey: spec.bitrate ?? min(120_000_000, max(8_000_000, Int(W * H * CGFloat(spec.fps) * 0.14))),
                AVVideoExpectedSourceFrameRateKey: spec.fps,
                AVVideoMaxKeyFrameIntervalKey: spec.fps * 2,
            ]
            if spec.appStore == true, !hevc { props[AVVideoProfileLevelKey] = AVVideoProfileLevelH264High40 }
            settings[AVVideoCompressionPropertiesKey] = props
        }
        // HD video's colours, said in the file, so every player shows them as drawn.
        settings[AVVideoColorPropertiesKey] = [
            AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
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

        var videos: [Int: VideoSource] = [:]
        for (k, layer) in spec.layers.enumerated() where layer.type == "video" {
            if let f = layer.file { videos[k] = try VideoSource(url: URL(fileURLWithPath: f)) }
        }
        let transparent = spec.transparent == true
        // From the top-left coordinates the engine uses to Core Image's (from the bottom left).
        let flip = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: H)
        func ci(_ t: CGAffineTransform) -> CGAffineTransform { flip.concatenating(t).concatenating(flip) }
        func box(_ r: [Double]) -> CGRect { CGRect(x: r[0], y: H - r[1] - r[3], width: r[2], height: r[3]) }
        func at<T>(_ list: [T]?, _ i: Int) -> T? { list.flatMap { $0.isEmpty ? nil : $0[min(i, $0.count - 1)] } }

        for i in 0..<spec.frames {
            autoreleasepool {
                let t = Double(i) / Double(spec.fps)
                var frame = transparent ? CIImage(color: .clear).cropped(to: canvas) : CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: canvas)
                for (k, layer) in spec.layers.enumerated() {
                    let opacity = at(layer.opacity, i) ?? 1
                    if opacity <= 0.001 { continue }
                    var img: CIImage?
                    switch layer.type {
                    case "picture":
                        var file = layer.file
                        var rect = layer.rect
                        if let files = layer.files {
                            let n = at(layer.index, i) ?? 0
                            if n < 0 || n >= files.count { continue }
                            file = files[n]
                            rect = layer.rects?[min(n, (layer.rects?.count ?? 1) - 1)] ?? rect
                        }
                        guard let f = file, let r = rect, var pic = loaded(f) else { continue }
                        // Drawn at its place (its own size scaled to the rect).
                        let e = pic.extent
                        pic = pic.transformed(by: CGAffineTransform(scaleX: r[2] / max(1, e.width), y: r[3] / max(1, e.height)))
                        let place = box(r)
                        pic = pic.transformed(by: CGAffineTransform(translationX: place.minX, y: place.minY))
                        if let qd = at(layer.quads, i), qd.count == 8 {
                            let p = { (x: Double, y: Double) in CIVector(x: x, y: H - y) }
                            pic = pic.applyingFilter("CIPerspectiveTransform", parameters: [
                                "inputTopLeft": p(qd[0], qd[1]), "inputTopRight": p(qd[2], qd[3]),
                                "inputBottomRight": p(qd[4], qd[5]), "inputBottomLeft": p(qd[6], qd[7]),
                            ])
                        } else if let m = at(layer.matrix, i), m.count == 6 {
                            pic = pic.transformed(by: ci(CGAffineTransform(a: m[0], b: m[1], c: m[2], d: m[3], tx: m[4], ty: m[5])))
                        }
                        if let hue = at(layer.hue, i), abs(hue) > 0.01 { pic = pic.applyingFilter("CIHueAdjust", parameters: [kCIInputAngleKey: hue * .pi / 180]) }
                        if let b = at(layer.blur, i), b > 0.05 { pic = pic.clampedToExtent().applyingGaussianBlur(sigma: b).cropped(to: pic.extent.insetBy(dx: -b * 2, dy: -b * 2)) }
                        img = pic
                    case "video":
                        img = videoLayer(layer, frame: i, t: t, source: videos[k]?.image(at: t), H: H)
                        // A device in soft focus: its video too.
                        if let b = at(layer.blur, i), b > 0.05, let v = img { img = v.clampedToExtent().applyingGaussianBlur(sigma: b).cropped(to: v.extent.insetBy(dx: -b * 2, dy: -b * 2)) }
                    case "fill":
                        let a = CGFloat(layer.amount ?? 1)
                        let fill = CIImage(color: color(layer.color ?? "#000")).cropped(to: layer.rect.map(box) ?? canvas)
                        frame = blended(fill, over: frame, mode: layer.blend, amount: a * CGFloat(opacity))
                        continue
                    case "grain":
                        guard let f = layer.file, let tilePic = loaded(f) else { continue }
                        let size = CGFloat(layer.tile ?? 220)
                        let e = tilePic.extent
                        var g = tilePic.transformed(by: CGAffineTransform(scaleX: size / max(1, e.width), y: size / max(1, e.height)))
                            .applyingFilter("CIAffineTile", parameters: [kCIInputTransformKey: NSValue(caTransform3D: CATransform3DIdentity)])
                        let off = at(layer.offsets, i) ?? [0, 0]
                        g = g.transformed(by: CGAffineTransform(translationX: off[0], y: -off[1]))
                        let area = layer.rect.map(box) ?? canvas
                        frame = blended(g.cropped(to: area), over: frame, mode: layer.blend ?? "overlay", amount: CGFloat(opacity))
                        continue
                    case "blur":
                        guard let r = layer.rect, let radius = layer.radiusPx, radius > 0.05 else { continue }
                        let band = box(r)
                        let blurred = frame.clampedToExtent().applyingGaussianBlur(sigma: radius).cropped(to: canvas)
                        // Opaque from the canvas edge, fading toward the middle.
                        let solid = CGFloat(layer.solid ?? 0)
                        let up = layer.toward == "up"
                        let from = up ? band.minY + band.height * solid : band.maxY - band.height * solid
                        let to = up ? band.maxY : band.minY
                        let mask = CIFilter(name: "CILinearGradient", parameters: [
                            "inputPoint0": CIVector(x: band.midX, y: from), "inputColor0": CIColor.white,
                            "inputPoint1": CIVector(x: band.midX, y: to), "inputColor1": CIColor.clear,
                        ])?.outputImage?.cropped(to: band) ?? CIImage.empty()
                        frame = blurred.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: frame, kCIInputMaskImageKey: mask]).cropped(to: canvas)
                        continue
                    default:
                        continue
                    }
                    guard var layerImage = img else { continue }
                    if opacity < 0.999 {
                        layerImage = layerImage.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(opacity))])
                    }
                    frame = layer.blend.map { blended(layerImage, over: frame, mode: $0, amount: 1) } ?? layerImage.composited(over: frame)
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

    /// `top` over `bottom` in a CSS blend mode, `amount` of the way (an element's opacity).
    private static func blended(_ top: CIImage, over bottom: CIImage, mode: String?, amount: CGFloat) -> CIImage {
        let filters = ["overlay": "CIOverlayBlendMode", "soft-light": "CISoftLightBlendMode", "lighten": "CILightenBlendMode", "darken": "CIDarkenBlendMode",
                       "multiply": "CIMultiplyBlendMode", "screen": "CIScreenBlendMode", "color": "CIColorBlendMode", "luminosity": "CILuminosityBlendMode",
                       "hard-light": "CIHardLightBlendMode", "color-dodge": "CIColorDodgeBlendMode", "color-burn": "CIColorBurnBlendMode", "difference": "CIDifferenceBlendMode"]
        let mixed: CIImage
        if let name = mode.flatMap({ filters[$0] }) {
            mixed = top.applyingFilter(name, parameters: [kCIInputBackgroundImageKey: bottom])
        } else {
            mixed = top.composited(over: bottom)
        }
        if amount >= 0.999 { return mixed.cropped(to: bottom.extent) }
        return bottom.applyingFilter("CIDissolveTransition", parameters: [kCIInputTargetImageKey: mixed, kCIInputTimeKey: amount]).cropped(to: bottom.extent)
    }

    /// A video: the frame filling its box (trimmed to its corners, graded, the cursor over it),
    /// then put on the four corners it lands on this frame.
    private static func videoLayer(_ layer: Layer, frame i: Int, t: Double, source: CIImage?, H: CGFloat) -> CIImage? {
        guard var src = source, let size = layer.box, size.count == 2, let quads = layer.quads, !quads.isEmpty else { return nil }
        let q = quads[min(i, quads.count - 1)]
        guard q.count == 8 else { return nil }
        let w = CGFloat(size[0])
        let h = CGFloat(size[1])
        let rect = CGRect(x: 0, y: 0, width: w, height: h)
        if let c = layer.crop, c.count == 4 {
            // The part asked for (source px from its top left).
            let e = src.extent
            src = src.cropped(to: CGRect(x: e.minX + c[0], y: e.maxY - c[1] - c[3], width: c[2], height: c[3]))
        }
        // The video fills its own box (as the page fits it), which the screen's box trims.
        let ir = layer.inner.flatMap { $0.count == 4 ? CGRect(x: $0[0], y: h - $0[1] - $0[3], width: $0[2], height: $0[3]) : nil } ?? rect
        let e = src.extent
        let s = max(ir.width / e.width, ir.height / e.height)
        var img = src.transformed(by: CGAffineTransform(translationX: -e.minX, y: -e.minY).concatenating(CGAffineTransform(scaleX: s, y: s)))
        img = img.transformed(by: CGAffineTransform(translationX: ir.midX - e.width * s / 2, y: ir.midY - e.height * s / 2)).cropped(to: ir.intersection(rect))
        if let m = layer.colorMatrix, m.count == 20 {
            img = img.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: m[0], y: m[1], z: m[2], w: m[3]),
                "inputGVector": CIVector(x: m[5], y: m[6], z: m[7], w: m[8]),
                "inputBVector": CIVector(x: m[10], y: m[11], z: m[12], w: m[13]),
                "inputAVector": CIVector(x: m[15], y: m[16], z: m[17], w: m[18]),
                "inputBiasVector": CIVector(x: m[4], y: m[9], z: m[14], w: m[19]),
            ])
        }
        if let c = layer.cursor, let drawn = cursor(c, rect: ir, t: t) { img = drawn.cropped(to: rect).composited(over: img) }
        let radius = min(CGFloat(layer.radius ?? 0), min(w, h) / 2)
        if radius > 0.5 {
            img = img.applyingFilter("CIBlendWithAlphaMask", parameters: [kCIInputBackgroundImageKey: CIImage.empty(), kCIInputMaskImageKey: rounded(rect, radius, .white)])
        }
        // Onto its corners (Core Image counts up from the bottom).
        let p = { (x: Double, y: Double) in CIVector(x: x, y: H - y) }
        img = img.applyingFilter("CIPerspectiveTransform", parameters: [
            "inputTopLeft": p(q[0], q[1]), "inputTopRight": p(q[2], q[3]),
            "inputBottomRight": p(q[4], q[5]), "inputBottomLeft": p(q[6], q[7]),
        ])
        return img
    }

    /// The cursor where its path has it at `t` (the cursor macOS showed, dipping as it clicks), and
    /// the ring where the latest click landed.
    private static func cursor(_ c: Cursor, rect: CGRect, t: Double) -> CIImage? {
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
    /// A picture, from the bottom left of its own extent; kept, as pictures come round again.
    private static func loaded(_ path: String) -> CIImage? {
        if let c = cache[path] { return c }
        guard let img = CIImage(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        let placed = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX, y: -img.extent.minY))
        if cache.count > 400 { cache.removeAll() }
        cache[path] = placed
        return placed
    }

    private static func rounded(_ r: CGRect, _ radius: CGFloat, _ color: CIColor) -> CIImage {
        let f = CIFilter(name: "CIRoundedRectangleGenerator", parameters: ["inputExtent": CIVector(cgRect: r), "inputRadius": max(0, radius), "inputColor": color])
        return f?.outputImage?.cropped(to: r) ?? CIImage.empty()
    }

    /// "#rrggbb" (or "#rgb", "rgb(r,g,b)", "white", "black").
    private static func color(_ s: String) -> CIColor {
        var hex = s.trimmingCharacters(in: .whitespaces).lowercased()
        if hex == "white" { return .white }
        if hex == "black" { return .black }
        if hex.hasPrefix("rgb") {
            let n = hex.split(whereSeparator: { !"0123456789.".contains($0) }).compactMap { Double($0) }
            if n.count >= 3 { return CIColor(red: n[0] / 255, green: n[1] / 255, blue: n[2] / 255) }
        }
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
