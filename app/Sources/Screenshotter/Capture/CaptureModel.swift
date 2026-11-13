import AppKit
import AVFoundation
import ScreenCaptureKit

/// What the capture bar is set to: a screenshot or a recording, of an area, a window or a whole
/// screen, with or without the camera, microphone and the Mac's own sound. Remembered between launches.
@MainActor final class CaptureModel: ObservableObject {
    enum Mode: String { case screenshot, record }
    enum Target: String { case area, window, screen }
    /// Where a capture is kept: Screenshotter's library (where the Studio lists it), the Desktop, a
    /// folder of your choosing, or (screenshots) just the clipboard.
    enum Destination: String { case library, desktop, folder, clipboard }
    /// What stopping a recording does: open it in Screenshotter to edit (the default), or save the
    /// finished video straight away where Save to says.
    enum AfterRecording: String { case edit, save }
    /// The camera bubble's outline.
    enum Shape: String, CaseIterable { case circle, rounded, square }
    /// The camera bubble's proportions (width ÷ height).
    enum Aspect: String, CaseIterable {
        case square, landscape, portrait
        var ratio: Double { self == .landscape ? 4.0 / 3 : self == .portrait ? 3.0 / 4 : 1 }
    }
    struct Device: Identifiable, Hashable {
        let id: String
        let name: String
    }

    @Published var mode: Mode { didSet { save("mode", mode.rawValue) } }
    @Published var target: Target { didSet { save("target", target.rawValue) } }
    @Published var cameraOn: Bool { didSet { save("cameraOn", cameraOn) } }
    @Published var cameraID: String { didSet { save("cameraID", cameraID) } }
    @Published var micOn: Bool { didSet { save("micOn", micOn) } }
    @Published var micID: String { didSet { save("micID", micID) } }
    @Published var systemAudio: Bool { didSet { save("systemAudio", systemAudio) } }
    @Published var countdown: Bool { didSet { save("countdown", countdown) } }
    @Published var afterRecording: AfterRecording { didSet { save("afterRecording", afterRecording.rawValue) } }
    /// A tick for each number of the countdown.
    @Published var countdownSound: Bool { didSet { save("countdownSound", countdownSound) } }
    /// The camera shutter when a screenshot is taken.
    @Published var shutterSound: Bool { didSet { save("shutterSound", shutterSound) } }
    /// Log the cursor beside a recording to edit (and keep it out of the picture), for the editor's
    /// smooth cursor, click ripples, auto zoom and following.
    @Published var cursorEffects: Bool { didSet { save("cursorEffects", cursorEffects) } }
    @Published var shotDestination: Destination { didSet { save("shotDestination", shotDestination.rawValue) } }
    @Published var videoDestination: Destination { didSet { save("videoDestination", videoDestination.rawValue) } }
    @Published var shotFolder: String { didSet { save("shotFolder", shotFolder) } }
    @Published var videoFolder: String { didSet { save("videoFolder", videoFolder) } }
    // The camera bubble's look, as the preview shows it and the recording keeps it.
    @Published var bubbleShape: Shape { didSet { save("bubbleShape", bubbleShape.rawValue) } }
    @Published var bubbleRoundness: Double { didSet { save("bubbleRoundness", bubbleRoundness) } }
    @Published var bubbleAspect: Aspect { didSet { save("bubbleAspect", bubbleAspect.rawValue) } }
    /// Its height in points on screen.
    @Published var bubbleSize: Double { didSet { save("bubbleSize", bubbleSize) } }
    @Published var bubbleMirrored: Bool { didSet { save("bubbleMirrored", bubbleMirrored) } }
    @Published var bubbleBorder: Bool { didSet { save("bubbleBorder", bubbleBorder) } }
    @Published private(set) var cameras: [Device] = []
    @Published private(set) var mics: [Device] = []
    /// A capture or recording is under way: the bar's button waits.
    @Published var busy = false

    private static let prefix = "capture."

    /// Where the choices are kept (the snapshots use a scratch store, leaving yours alone).
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let d = defaults
        let p = CaptureModel.prefix
        mode = Mode(rawValue: d.string(forKey: p + "mode") ?? "") ?? .screenshot
        target = Target(rawValue: d.string(forKey: p + "target") ?? "") ?? .area
        cameraOn = d.bool(forKey: p + "cameraOn")
        cameraID = d.string(forKey: p + "cameraID") ?? ""
        micOn = d.object(forKey: p + "micOn") as? Bool ?? true
        micID = d.string(forKey: p + "micID") ?? ""
        systemAudio = d.bool(forKey: p + "systemAudio")
        countdown = d.object(forKey: p + "countdown") as? Bool ?? true
        afterRecording = AfterRecording(rawValue: d.string(forKey: p + "afterRecording") ?? "") ?? .edit
        countdownSound = d.object(forKey: p + "countdownSound") as? Bool ?? true
        shutterSound = d.object(forKey: p + "shutterSound") as? Bool ?? true
        cursorEffects = d.object(forKey: p + "cursorEffects") as? Bool ?? true
        shotDestination = Destination(rawValue: d.string(forKey: p + "shotDestination") ?? "") ?? .library
        videoDestination = Destination(rawValue: d.string(forKey: p + "videoDestination") ?? "") ?? .library
        shotFolder = d.string(forKey: p + "shotFolder") ?? ""
        videoFolder = d.string(forKey: p + "videoFolder") ?? ""
        bubbleShape = Shape(rawValue: d.string(forKey: p + "bubbleShape") ?? "") ?? .circle
        bubbleRoundness = d.object(forKey: p + "bubbleRoundness") as? Double ?? 0.24
        bubbleAspect = Aspect(rawValue: d.string(forKey: p + "bubbleAspect") ?? "") ?? .square
        bubbleSize = d.object(forKey: p + "bubbleSize") as? Double ?? 200
        bubbleMirrored = d.object(forKey: p + "bubbleMirrored") as? Bool ?? true
        bubbleBorder = d.object(forKey: p + "bubbleBorder") as? Bool ?? true
        refreshDevices()
    }

    private func save(_ key: String, _ value: Any) {
        defaults.set(value, forKey: CaptureModel.prefix + key)
    }

    /// The cameras and microphones connected now (a Continuity Camera or USB mic included).
    func refreshDevices() {
        let videoTypes: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera, .external, .continuityCamera]
        cameras = AVCaptureDevice.DiscoverySession(deviceTypes: videoTypes, mediaType: .video, position: .unspecified).devices.map { Device(id: $0.uniqueID, name: $0.localizedName) }
        mics = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices.map { Device(id: $0.uniqueID, name: $0.localizedName) }
        if !cameras.contains(where: { $0.id == cameraID }) { cameraID = cameras.first?.id ?? "" }
        if !mics.contains(where: { $0.id == micID }) { micID = AVCaptureDevice.default(for: .audio)?.uniqueID ?? mics.first?.id ?? "" }
    }

    var cameraName: String { cameras.first { $0.id == cameraID }?.name ?? "Camera" }

    /// The destination for the mode the bar is in (a recording can't live only on the clipboard).
    var destination: Destination {
        get { mode == .screenshot ? shotDestination : (videoDestination == .clipboard ? .library : videoDestination) }
        set { if mode == .screenshot { shotDestination = newValue } else { videoDestination = newValue } }
    }
    var folder: String {
        get { mode == .screenshot ? shotFolder : videoFolder }
        set { if mode == .screenshot { shotFolder = newValue } else { videoFolder = newValue } }
    }
    var destinationName: String {
        switch destination {
        case .library: return "Library"
        case .desktop: return "Desktop"
        case .clipboard: return "Clipboard"
        case .folder: return folder.isEmpty ? "Folder" : URL(fileURLWithPath: folder).lastPathComponent
        }
    }
    /// The bubble's width and height in points.
    var bubbleFrameSize: CGSize {
        let h = bubbleSize
        let ratio = bubbleShape == .circle ? 1 : bubbleAspect.ratio
        return CGSize(width: (h * ratio).rounded(), height: h.rounded())
    }
    /// Corner radius as a share of the shorter side.
    var bubbleCorner: Double { bubbleShape == .circle ? 0.5 : bubbleShape == .square ? 0 : bubbleRoundness }
    var micName: String { mics.first { $0.id == micID }?.name ?? "Microphone" }

    /// The microphone goes with the camera when it's on (so your voice stays in step with your face);
    /// without the camera it's recorded with the screen, which needs macOS 15.
    var micWithScreenSupported: Bool {
        if #available(macOS 15.0, *) { return true }
        return false
    }
    var micAvailable: Bool { !mics.isEmpty && (cameraOn || micWithScreenSupported) }
}

/// Where captures go. In the library: `raw` for screenshots and `recordings` for videos (each with
/// a poster frame and notes beside it), so the Studio lists them. Elsewhere (the Desktop, a folder):
/// just the file, named as macOS names its own, with its poster and parts kept out of the way.
struct CaptureFiles {
    let library: URL
    var destination: CaptureModel.Destination = .library
    var folder: String = ""

    var inLibrary: Bool { destination == .library }

    /// Out-of-the-way storage: a clipboard-only screenshot's file, a Desktop recording's poster and parts.
    static var support: URL {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Screenshotter/Captures", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func outside(_ prefix: String, _ ext: String) throws -> URL {
        let dir: URL
        switch destination {
        case .desktop: dir = FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask)[0]
        case .folder where !folder.isEmpty: dir = URL(fileURLWithPath: folder, isDirectory: true)
        default: dir = CaptureFiles.support
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        var url = dir.appendingPathComponent("\(prefix) \(f.string(from: Date())).\(ext)")
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent("\(prefix) \(f.string(from: Date())) \(n).\(ext)")
            n += 1
        }
        return url
    }

    /// Where the HUD says it went. The library's by the name the Studio lists it under
    /// (Screenshots or Recordings), never its folder's.
    func placeName(video: Bool) -> String {
        switch destination {
        case .library: return video ? "in Recordings" : "in Screenshots"
        case .desktop: return "on your Desktop"
        case .clipboard: return "on the clipboard"
        case .folder: return "in \(URL(fileURLWithPath: folder).lastPathComponent)"
        }
    }

    static func stamp(_ date: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss-SSS"
        return f.string(from: date)
    }

    static func slug(_ s: String) -> String {
        let lowered = s.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }
        let joined = String(lowered).split(separator: "-").joined(separator: "-")
        return joined.isEmpty ? "capture" : String(joined.prefix(40))
    }

    private func folder(_ name: String) throws -> URL {
        let url = library.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    func newScreenshot(named name: String) throws -> URL {
        guard inLibrary else { return try outside("Screenshot", "png") }
        return try folder("raw").appendingPathComponent("mac-\(CaptureFiles.slug(name))-\(CaptureFiles.stamp()).png")
    }

    func newRecording(named name: String) throws -> URL {
        guard inLibrary else { return try outside("Screen Recording", "mp4") }
        return try folder("recordings").appendingPathComponent("mac-\(CaptureFiles.slug(name))-\(CaptureFiles.stamp()).mp4")
    }

    /// A recording's parts (the screen and camera tracks before they're put together), kept for
    /// editing: beside it in the library, out of the way otherwise.
    func parts(for recording: URL) throws -> URL {
        let url = CaptureFiles.partsFolder(for: recording)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Whether a capture is one of the library's (named and placed as the bar names them there).
    static func isInLibrary(_ url: URL) -> Bool {
        let folder = url.deletingLastPathComponent().lastPathComponent
        return url.lastPathComponent.hasPrefix("mac-") && (folder == "raw" || folder == "recordings")
    }

    /// The recording's poster frame: next to it in the library (the Studio shows it), out of the way elsewhere.
    static func poster(for recording: URL) -> URL {
        let beside = recording.deletingPathExtension().appendingPathExtension("png")
        if isInLibrary(recording) { return beside }
        return support.appendingPathComponent("posters", isDirectory: true).appendingPathComponent(beside.lastPathComponent)
    }

    /// Clears out clipboard-only screenshots (and their notes) once they're over a week old, in the
    /// background: the picture went to the clipboard, and its file only backed the corner card.
    /// Posters and parts of recordings stay, wherever the recording was saved: a design made from
    /// one refers to them by path.
    static func tidy() {
        let root = support
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            let cutoff = Date().addingTimeInterval(-7 * 24 * 3600)
            func old(_ url: URL) -> Bool {
                ((try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantFuture) < cutoff
            }
            func items(_ dir: URL) -> [URL] {
                (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
            }
            for url in items(root) where url.pathExtension.lowercased() == "png" && old(url) {
                try? fm.removeItem(at: url)
                try? fm.removeItem(at: URL(fileURLWithPath: url.path + ".json"))
            }
        }
    }

    /// Where a recording's parts are (see `parts(for:)`).
    static func partsFolder(for recording: URL) -> URL {
        let stem = recording.deletingPathExtension().lastPathComponent
        let base = isInLibrary(recording) ? recording.deletingLastPathComponent().appendingPathComponent(".parts", isDirectory: true) : support.appendingPathComponent("parts", isDirectory: true)
        return base.appendingPathComponent(stem, isDirectory: true)
    }

    /// What the engine reads to frame a capture: a Mac window or screen goes in a MacBook.
    static func writeNotes(for file: URL, kind: String?, app: String?, scale: CGFloat, size: CGSize) {
        var notes: [String: Any] = ["scale": scale, "width": Int(size.width), "height": Int(size.height), "capturedAt": ISO8601DateFormatter().string(from: Date()), "source": "capture-bar"]
        if let kind { notes["kind"] = kind }
        if let app { notes["app"] = app }
        if let data = try? JSONSerialization.data(withJSONObject: notes, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: file.path + ".json"))
        }
    }
}

/// Screen Recording, Camera and Microphone permissions: asked for when first needed, with a way to
/// System Settings when one was turned down.
@MainActor enum Permissions {
    static func screen() -> Bool {
        if CGPreflightScreenCaptureAccess() { return true }
        // Asks once; after that macOS only offers System Settings.
        if CGRequestScreenCaptureAccess() { return true }
        explain(
            "Screenshotter needs Screen Recording permission",
            "Turn on Screenshotter in System Settings › Privacy & Security › Screen & System Audio Recording, then try again. You may need to quit and reopen Screenshotter.",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        return false
    }

    static func media(_ type: AVMediaType) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized: return true
        case .notDetermined:
            if await AVCaptureDevice.requestAccess(for: type) { return true }
            explainMedia(type)
            return false
        default:
            explainMedia(type)
            return false
        }
    }

    /// Turned down: say where to turn it back on.
    static func explainMedia(_ type: AVMediaType) {
            let camera = type == .video
            explain(
                "Screenshotter needs \(camera ? "Camera" : "Microphone") permission",
                "Turn on Screenshotter in System Settings › Privacy & Security › \(camera ? "Camera" : "Microphone"), then try again.",
                "x-apple.systempreferences:com.apple.preference.security?\(camera ? "Privacy_Camera" : "Privacy_Microphone")")
    }

    static func explain(_ title: String, _ text: String, _ settings: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn, let url = URL(string: settings) { NSWorkspace.shared.open(url) }
    }
}
