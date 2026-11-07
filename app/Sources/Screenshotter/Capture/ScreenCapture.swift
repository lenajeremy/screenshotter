import AppKit
import AudioToolbox
import ScreenCaptureKit
import UniformTypeIdentifiers

enum CaptureError: LocalizedError {
    case noDisplay, noWindow, noImage, noCamera, writeFailed(String)
    var errorDescription: String? {
        switch self {
        case .noDisplay: return "That screen isn't available any more. Choose another."
        case .noWindow: return "That window has closed. Choose another."
        case .noImage: return "Nothing was captured. Try again."
        case .noCamera: return "No camera is connected. Connect one, or record without the camera."
        case .writeFailed(let why): return "Couldn't save the capture (\(why)). Try again."
        }
    }
}

/// ScreenCaptureKit, as the capture bar uses it: the content to capture for a region (never
/// Screenshotter's own panels), and a still of it at the screen's full resolution.
enum ScreenShot {
    static func displayID(of screen: NSScreen) -> CGDirectDisplayID {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
    }

    /// The filter for a region, and the part of it to keep (in the display's points, from its top
    /// left), with the pixels per point.
    struct Source {
        let filter: SCContentFilter
        let sourceRect: CGRect?
        let pointSize: CGSize
        let scale: CGFloat
    }

    static func source(for region: CaptureRegion) async throws -> Source {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        switch region {
        case .window(let id, _, _, _):
            guard let window = content.windows.first(where: { $0.windowID == id }) else { throw CaptureError.noWindow }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            return Source(filter: filter, sourceRect: nil, pointSize: filter.contentRect.size, scale: CGFloat(filter.pointPixelScale))
        case .area(let screen, _), .screen(let screen):
            let id = displayID(of: screen)
            guard let display = content.displays.first(where: { $0.displayID == id }) else { throw CaptureError.noDisplay }
            // Screenshotter itself, looked up among every app (not just those with a window showing
            // now): leaving the app out keeps its capture UI out, the pill and bubble that come later too.
            // Its Studio window is put back: it's an app like any other, and people capture it too
            // (left out, a capture of it came out black, or showed what was behind it).
            let everything = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            let me = everything.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
            let studio = await MainActor.run { StudioWindow.visibleIDs() }
            let keep = content.windows.filter { studio.contains($0.windowID) }
            let filter = SCContentFilter(display: display, excludingApplications: me, exceptingWindows: keep)
            let scale = CGFloat(filter.pointPixelScale)
            if case .area(_, let rect) = region {
                // AppKit's global coordinates → this display's points from its top left.
                let local = CGRect(x: rect.minX - screen.frame.minX, y: screen.frame.maxY - rect.maxY, width: rect.width, height: rect.height)
                return Source(filter: filter, sourceRect: local, pointSize: rect.size, scale: scale)
            }
            return Source(filter: filter, sourceRect: nil, pointSize: screen.frame.size, scale: scale)
        }
    }

    static func image(of region: CaptureRegion) async throws -> (CGImage, CGFloat) {
        let src = try await source(for: region)
        let cfg = SCStreamConfiguration()
        cfg.width = Int((src.pointSize.width * src.scale).rounded())
        cfg.height = Int((src.pointSize.height * src.scale).rounded())
        if let r = src.sourceRect { cfg.sourceRect = r }
        cfg.showsCursor = false
        cfg.captureResolution = .best
        cfg.colorSpaceName = CGColorSpace.sRGB
        if case .window = region { cfg.ignoreShadowsSingleWindow = true }
        let image = try await SCScreenshotManager.captureImage(contentFilter: src.filter, configuration: cfg)
        return (image, src.scale)
    }

    static func writePNG(_ image: CGImage, to url: URL, scale: CGFloat) throws {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw CaptureError.writeFailed("no image writer") }
        let dpi = 72 * scale
        CGImageDestinationAddImage(dest, image, [kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw CaptureError.writeFailed("the PNG didn't finish") }
    }
}

/// The Mac's own screenshot sound, the one ⌘⇧3 makes: read from the system (the app doesn't carry
/// it) and played as a sound effect, at the alert volume, through the sound effects output.
enum ShutterSound {
    private static let sound: SystemSoundID? = {
        let dir = "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system"
        for name in ["Screen Capture", "Shutter", "Grab"] {
            let path = "\(dir)/\(name).aif"
            var id: SystemSoundID = 0
            if FileManager.default.fileExists(atPath: path), AudioServicesCreateSystemSoundID(URL(fileURLWithPath: path) as CFURL, &id) == noErr { return id }
        }
        return nil
    }()

    /// Loaded ahead, so it plays the instant the picture's taken.
    static func prepare() { _ = sound }

    static func play() {
        // Quiet when "Play user interface sound effects" is off in System Settings › Sound, as macOS's own screenshots are.
        guard UserDefaults.standard.object(forKey: "com.apple.sound.uiaudio.enabled") as? Bool ?? true else { return }
        if let sound { AudioServicesPlaySystemSound(sound) } else { NSSound(named: "Tink")?.play() }
    }
}
