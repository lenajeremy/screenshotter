import AppKit
import AVFoundation
import Carbon.HIToolbox
import Combine

/// Runs the capture bar's flows: choose what to capture, take the screenshot or the recording
/// (with the camera bubble and the countdown), put it together, save it where you chose (the
/// library, the Desktop, a folder, the clipboard), and offer it in the corner with Edit in
/// Screenshotter. Also the camera's preview, the menu bar icon and the ⌘⇧2 shortcut.
@MainActor final class CaptureCoordinator {
    let model = CaptureModel()
    private let library: () -> URL
    private let openStudio: () -> Void
    private let editInStudio: (URL, URL?, CGSize?) -> Void
    private let openRecording: ([String: Any]) -> Void
    private var bar: CaptureBarPanel?
    private var hud: CaptureHUD?
    private var statusItem: NSStatusItem?
    private var hotKey: EventHotKeyRef?
    private var recording: Recording?
    /// The camera's preview while the bar is set to record with it (a recording takes it over).
    private var preview: (camera: CameraRecorder, bubble: CameraBubble)?
    /// Between Capture and the recording starting (picking an area, say): the preview stays up.
    private var capturing = false
    /// Where the bubble was last left.
    private var bubbleSpot: CGPoint?
    private var asking = false
    private var watch: AnyCancellable?
    /// Captures from outside the library already copied in for the canvas.
    private var libraryCopies: [URL: URL] = [:]

    init(library: @escaping () -> URL, openStudio: @escaping () -> Void, editInStudio: @escaping (URL, URL?, CGSize?) -> Void,
         openRecording: @escaping ([String: Any]) -> Void) {
        self.library = library
        self.openStudio = openStudio
        self.editInStudio = editInStudio
        self.openRecording = openRecording
        installStatusItem()
        installHotKey()
        watch = model.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.syncPreview() }
        }
    }

    // MARK: The bar

    func showBar(_ mode: CaptureModel.Mode? = nil) {
        if recording != nil { return }
        if let mode { model.mode = mode }
        model.refreshDevices()
        let bar = self.bar ?? CaptureBarPanel(model: model, actions: CaptureBarActions(
            capture: { [weak self] in self?.capture() },
            openStudio: { [weak self] in
                self?.hideBar()
                self?.openStudio()
            },
            close: { [weak self] in self?.hideBar() },
            resized: { [weak self] in self?.bar?.recentre() },
            chooseFolder: { [weak self] in self?.chooseFolder() },
            moved: { [weak self] in self?.bar?.moved() }))
        self.bar = bar
        // The bar takes the keyboard without making Screenshotter the active app, which would
        // switch you out of a full-screen app to the desktop.
        bar.present()
        syncPreview()
    }

    func hideBar() {
        bar?.orderOut(nil)
        syncPreview()
    }

    var barVisible: Bool { bar?.isVisible == true }

    /// Save to › Choose Folder…: where this kind of capture goes from now on.
    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Save Here"
        panel.message = model.mode == .screenshot ? "Choose where your screenshots go" : "Choose where your recordings go"
        if !model.folder.isEmpty { panel.directoryURL = URL(fileURLWithPath: model.folder, isDirectory: true) }
        // In front of everything: the bar doesn't make Screenshotter the active app, and the picker
        // otherwise opened behind other apps' windows, where it waited unseen.
        panel.level = .modalPanel
        NSApp.activate()
        if panel.runModal() == .OK, let url = panel.url {
            model.folder = url.path
            model.destination = .folder
        }
        bar?.makeKeyAndOrderFront(nil)
    }

    /// Where captures of `mode` go, as the bar's Save to says.
    private func files(for mode: CaptureModel.Mode) -> CaptureFiles {
        var destination = mode == .screenshot ? model.shotDestination : model.videoDestination
        let folder = mode == .screenshot ? model.shotFolder : model.videoFolder
        if destination == .folder, folder.isEmpty { destination = .library }
        if mode == .record, destination == .clipboard { destination = .library }
        return CaptureFiles(library: library(), destination: destination, folder: folder)
    }

    // MARK: The camera's preview

    /// The camera shows as soon as it's turned on in the bar (set to record), so you can place
    /// yourself and pick its look before recording; it goes when the bar does.
    private func syncPreview() {
        guard recording == nil, !previewStarting else { return }
        let wanted = (barVisible || capturing) && model.mode == .record && model.cameraOn && !model.cameras.isEmpty
        if !wanted { return stopPreview() }
        if let preview, preview.camera.cameraID == model.cameraID { return }
        stopPreview()
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            Task {
                await startPreview()
                // Things may have changed while the camera set up (the bar closed, say).
                syncPreview()
            }
        case .notDetermined:
            guard !asking else { return }
            asking = true
            Task {
                let ok = await AVCaptureDevice.requestAccess(for: .video)
                asking = false
                if !ok { model.cameraOn = false }
                syncPreview()
            }
        default:
            model.cameraOn = false
            Permissions.explainMedia(.video)
        }
    }

    /// A camera's preview on the way (its setup runs off the main thread).
    private var previewStarting = false

    @discardableResult private func startPreview() async -> Bool {
        if previewStarting { return false }
        previewStarting = true
        defer { previewStarting = false }
        do {
            let cam = try CameraRecorder(cameraID: model.cameraID)
            await cam.configure()
            let screen = bar?.screen ?? NSScreen.main ?? NSScreen.screens[0]
            // The preview attaches to the camera before it starts (never while it's starting).
            let bubble = CameraBubble(session: cam.session, model: model, near: screen.visibleFrame, at: bubbleSpot,
                                      onCameraOff: { [weak self] in self?.cameraOffPressed() })
            cam.run()
            bubble.orderFrontRegardless()
            preview = (cam, bubble)
            return true
        } catch {
            model.cameraOn = false
            fail("Couldn't turn the camera on", error)
            return false
        }
    }

    private func stopPreview() {
        guard let p = preview else { return }
        preview = nil
        bubbleSpot = p.bubble.frame.origin
        p.bubble.orderOut(nil)
        p.camera.shutDown { p.bubble.detach() }
    }

    /// The bubble's camera-off button: before recording, the camera's simply off; while recording,
    /// the camera stops there (the video keeps what it had) and your voice carries on.
    private func cameraOffPressed() {
        guard let rec = recording else {
            model.cameraOn = false
            return
        }
        guard let cam = rec.camera, let bubble = rec.bubble else { return }
        rec.bubblePlacement = bubble.placement(in: rec.region.frame)
        bubbleSpot = bubble.frame.origin
        rec.bubble = nil
        // Let go of the preview first: the session mustn't change while it's attached.
        rec.bubbleTracker?.stop()
        bubble.detach()
        cam.turnOffCamera()
        rec.cameraTurnedOff = true
        rec.pill?.cameraOff()
        updateStatusItem()
    }

    // MARK: Capturing

    private func capture() {
        guard !model.busy else { return }
        guard Permissions.screen() else { return }
        capturing = true
        bar?.orderOut(nil)
        if model.mode == .screenshot, model.shutterSound { ShutterSound.prepare() }
        let then: (CaptureRegion?) -> Void = { [weak self] region in
            guard let self else { return }
            guard let region else {
                self.capturing = false
                return self.showBar()
            }
            if self.model.mode == .screenshot {
                self.capturing = false
                self.syncPreview()
                self.screenshot(region)
            } else { self.record(region) }
        }
        switch model.target {
        case .area: RegionPicker.pick(.area, then)
        case .window: RegionPicker.pick(.window, then)
        case .screen:
            let mouse = NSEvent.mouseLocation
            let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main ?? NSScreen.screens[0]
            // Let the bar leave the screen first.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { then(.screen(screen)) }
        }
    }

    private func screenshot(_ region: CaptureRegion) {
        model.busy = true
        Task {
            defer { model.busy = false }
            do {
                let (image, scale) = try await ScreenShot.image(of: region)
                // The shutter, the moment the picture's taken (before it's saved).
                if model.shutterSound { ShutterSound.play() }
                let files = files(for: .screenshot)
                let url = try files.newScreenshot(named: region.name)
                try ScreenShot.writePNG(image, to: url, scale: scale)
                let size = CGSize(width: image.width, height: image.height)
                if files.inLibrary {
                    let kind: String? = { if case .area = region { return nil }; return "mac" }()
                    let app: String? = { if case .window(_, _, let a, _) = region { return a }; return nil }()
                    CaptureFiles.writeNotes(for: url, kind: kind, app: app, scale: scale, size: size)
                }
                if files.destination == .clipboard, let png = try? Data(contentsOf: url) {
                    let pb = NSPasteboard.general
                    pb.clearContents()
                    pb.declareTypes([.png, .tiff], owner: nil)
                    pb.setData(png, forType: .png)
                    if let tiff = NSImage(cgImage: image, size: CGSize(width: size.width / scale, height: size.height / scale)).tiffRepresentation { pb.setData(tiff, forType: .tiff) }
                }
                let hud = newHUD(on: region.screen)
                hud.ready(file: url, image: NSImage(cgImage: image, size: .zero), title: files.destination == .clipboard ? "Screenshot copied" : "Screenshot saved",
                          detail: "\(image.width) × \(image.height) · \(files.placeName(video: false))", isVideo: false)
            } catch {
                fail("Couldn't take the screenshot", error)
            }
        }
    }

    // MARK: Recording

    /// One recording under way: the screen, the camera (with the microphone) or the screen with it, the pill.
    private final class Recording {
        let region: CaptureRegion
        let clock = PauseClock()
        let files: CaptureFiles
        let output: URL
        let parts: URL
        var screen: ScreenRecorder?
        var camera: CameraRecorder?
        var bubble: CameraBubble?
        /// Where the bubble was, kept when the camera's turned off partway.
        var bubblePlacement: BubblePlacement?
        /// Where the bubble went while recording.
        var bubbleTracker: BubbleTracker?
        var cameraTurnedOff = false
        var pill: RecordingPill?
        /// When the recording actually began (after the setup and any countdown).
        var startedAt: CFTimeInterval?
        /// Opened in Screenshotter to edit when it stops (the files stay in the library, which the
        /// Studio works from), rather than saved as a finished video.
        var edit = false
        /// Where the bar's Save to sends the edited video's export (nil: the library).
        var saveTo: URL?
        /// The cursor, logged beside the recording (cursor effects on).
        var cursor: CursorRecorder?
        init(region: CaptureRegion, files: CaptureFiles, output: URL, parts: URL) {
            self.region = region
            self.files = files
            self.output = output
            self.parts = parts
        }
    }

    private func record(_ region: CaptureRegion) {
        model.busy = true
        Task {
            do {
                if model.cameraOn, !(await Permissions.media(.video)) { return notStarted() }
                let micOn = model.micOn && model.micAvailable
                if micOn, !(await Permissions.media(.audio)) { return notStarted() }
                let chosen = files(for: .record)
                let edit = model.afterRecording == .edit
                // To edit, the recording is kept in the library (the Studio works from there); the
                // Save to place gets the video when it's exported.
                let files = edit ? CaptureFiles(library: library()) : chosen
                let output = try files.newRecording(named: region.name)
                let rec = Recording(region: region, files: files, output: output, parts: try files.parts(for: output))
                rec.edit = edit
                if edit, !chosen.inLibrary { rec.saveTo = try chosen.newRecording(named: region.name).deletingLastPathComponent() }
                // The camera's preview carries on into the recording (started now if it wasn't up),
                // so you can see yourself (and move the bubble) during the countdown.
                if model.cameraOn {
                    // A preview still setting up: wait for it.
                    while previewStarting { try? await Task.sleep(nanoseconds: 50_000_000) }
                    if preview?.camera.cameraID != model.cameraID {
                        stopPreview()
                        guard await startPreview() else { return notStarted() }
                    }
                    guard let p = preview else { return notStarted() }
                    preview = nil
                    rec.camera = p.camera
                    rec.bubble = p.bubble
                    p.bubble.keepOver(region.frame)
                    // Your voice goes with the camera (and survives it being turned off).
                    if micOn, !(await p.camera.addMic(model.micID)) { NSLog("Screenshotter: the microphone couldn't join the camera") }
                    testLog?("step microphone joined")
                }
                recording = rec
                capturing = false
                let source = try await ScreenShot.source(for: region)
                let screenMic = micOn && !model.cameraOn ? model.micID : nil
                // Cursor effects: the cursor is logged and drawn by the editor, so it stays out of the picture.
                if edit, model.cursorEffects { rec.cursor = CursorRecorder(region: region.frame) }
                rec.screen = try timed("screen recorder") {
                    try ScreenRecorder(region: region, source: source, url: rec.parts.appendingPathComponent("screen.mp4"),
                                       systemAudio: model.systemAudio, micID: screenMic, clock: rec.clock, showsCursor: rec.cursor == nil)
                }
                // The screen stream and the cursor log warm up while the countdown runs (keeping
                // nothing yet), so the recording starts the moment it ends, without a stall.
                timed("cursor log") { rec.cursor?.start() }
                if model.countdown {
                    // The countdown runs while the stream starts; then wait for it to finish.
                    var outcome: Bool?
                    var waiting: CheckedContinuation<Bool, Never>?
                    Countdown(over: region.frame, sound: model.countdownSound).run { go in
                        if let waiting { waiting.resume(returning: go) } else { outcome = go }
                    }
                    try await rec.screen?.start(waiting: true)
                    let go = await withCheckedContinuation { done in
                        if let outcome { done.resume(returning: outcome) } else { waiting = done }
                    }
                    if !go { return discard() }
                } else {
                    try await rec.screen?.start(waiting: true)
                }
                // Stopped or thrown away during the countdown.
                guard recording === rec else { return }
                try timed("camera writer") { try rec.camera?.startRecording(to: rec.parts.appendingPathComponent("camera.mov"), clock: rec.clock) }
                rec.startedAt = CACurrentMediaTime()
                rec.screen?.begin()
                if let bubble = rec.bubble {
                    let tracker = BubbleTracker(bubble: bubble)
                    timed("bubble tracker") { tracker.start() }
                    rec.bubbleTracker = tracker
                }
                rec.screen?.onStop = { [weak self] error in
                    DispatchQueue.main.async { self?.fail("The recording stopped", error) }
                }
                let pill = timed("pill") {
                    RecordingPill(on: region.screen, camera: rec.bubble != nil,
                                  onPause: { [weak self] in self?.togglePause() },
                                  onStop: { [weak self] in self?.stop() },
                                  onDiscard: { [weak self] in self?.discard() },
                                  onCameraOff: { [weak self] in self?.cameraOffPressed() })
                }
                rec.pill = pill
                timed("pill shown") { pill.begin() }
                timed("menu bar") { updateStatusItem() }
            } catch {
                await tearDown(keepFiles: false)
                fail("Couldn't start recording", error)
            }
        }
    }

    /// A recording that didn't get going (permission turned down, the camera wouldn't start).
    private func notStarted() {
        capturing = false
        model.busy = false
        syncPreview()
    }

    func togglePause() {
        guard let rec = recording, let pill = rec.pill else { return }
        if rec.clock.isPaused { rec.clock.resume() } else { rec.clock.pause() }
        pill.setPaused(rec.clock.isPaused)
        updateStatusItem()
    }

    func stop() {
        guard let rec = recording else { return }
        recording = nil
        let elapsed = rec.pill?.elapsed ?? 0
        rec.pill?.end()
        rec.camera?.endNow()
        let bubblePlacement = rec.bubblePlacement ?? rec.bubble?.placement(in: rec.region.frame)
        rec.cursor?.stop()
        rec.bubbleTracker?.stop()
        if let bubble = rec.bubble { bubbleSpot = bubble.frame.origin }
        rec.bubble?.orderOut(nil)
        updateStatusItem()
        let hud = newHUD(on: rec.region.screen)
        hud.show(saving: rec.edit ? "Getting your recording ready to edit…" : "Saving your recording…")
        Task {
            defer { model.busy = false }
            if rec.clock.isPaused { rec.clock.resume() }
            // When each started, read before the files close.
            let cameraStart = rec.camera?.firstTime
            let screenOK = await rec.screen?.stop() ?? false
            var cameraURL: URL?
            if let cam = rec.camera {
                if await cam.stopRecording() { cameraURL = rec.parts.appendingPathComponent("camera.mov") }
                let bubble = rec.bubble
                cam.shutDown { bubble?.detach() }
            }
            guard screenOK, let screenWriter = rec.screen?.writer else {
                hud.failed("Nothing was recorded.")
                return
            }
            // The camera's first frame against the screen's: how far apart the two files start.
            var offset = 0.0
            if let a = screenWriter.firstTime, let b = cameraStart { offset = (b - a).seconds }
            // Where the bubble went: it starts where it was when recording began.
            let path = cameraURL == nil ? [] : (rec.bubbleTracker?.path(in: rec.region.frame, start: screenWriter.firstTime ?? .zero, clock: rec.clock) ?? [])
            var bubble = bubblePlacement
            if let first = path.first, first.count == 4 {
                bubble?.x = first[1]
                bubble?.y = first[2]
                bubble?.diameter = first[3]
            }
            var parts = RecordingParts(screen: "screen.mp4", camera: cameraURL == nil ? nil : "camera.mov", cameraOffset: offset,
                                       bubble: cameraURL == nil ? nil : bubble, systemAudio: model.systemAudio,
                                       microphone: model.micOn && model.micAvailable)
            if path.count > 1 { parts.bubblePath = path }
            if let data = try? JSONEncoder().encode(parts) { try? data.write(to: rec.parts.appendingPathComponent("parts.json")) }
            var cursorLog: URL?
            if let cursor = rec.cursor, let start = screenWriter.firstTime {
                let url = rec.parts.appendingPathComponent("cursor.json")
                cursor.write(to: url, start: start, clock: rec.clock)
                cursorLog = url
            }
            if rec.edit { return await openToEdit(rec, screen: screenWriter.url, camera: cameraURL, parts: parts, cursor: cursorLog, hud: hud) }
            do {
                try await Finisher.finish(screen: screenWriter.url, camera: cameraURL, parts: parts, to: rec.output)
                let posterURL = CaptureFiles.poster(for: rec.output)
                let poster = await Finisher.poster(for: rec.output, at: posterURL)
                let size = poster.map { CGSize(width: $0.width, height: $0.height) }
                if let size, rec.files.inLibrary {
                    let kind: String? = { if case .area = rec.region { return nil }; return "mac" }()
                    CaptureFiles.writeNotes(for: posterURL, kind: kind, app: nil, scale: 2, size: size)
                }
                let length = String(format: "%d:%02d", Int(elapsed) / 60, Int(elapsed) % 60)
                hud.ready(file: rec.output, image: poster.map { NSImage(cgImage: $0, size: .zero) }, title: "Recording saved · \(length)",
                          detail: "\(cameraURL != nil ? "With your camera · " : "")\(rec.files.placeName(video: true))", isVideo: true)
            } catch {
                hud.failed(error.localizedDescription)
            }
        }
    }

    /// Stopped to edit: the recording (its sounds mixed in) and the camera as a clip of its own,
    /// opened in Screenshotter's Animate as a design the size of the recording.
    private func openToEdit(_ rec: Recording, screen: URL, camera: URL?, parts: RecordingParts, cursor: URL?, hud: CaptureHUD) async {
        do {
            try await Finisher.editable(screen: screen, camera: camera, parts: parts, to: rec.output)
            let asset = AVURLAsset(url: rec.output)
            let duration = try await asset.load(.duration).seconds
            let size = try await asset.loadTracks(withMediaType: .video).first?.load(.naturalSize) ?? .zero
            let posterURL = CaptureFiles.poster(for: rec.output)
            if let poster = await Finisher.poster(for: rec.output, at: posterURL) {
                let kind: String? = { if case .area = rec.region { return nil }; return "mac" }()
                CaptureFiles.writeNotes(for: posterURL, kind: kind, app: nil, scale: 2, size: CGSize(width: poster.width, height: poster.height))
            }
            let stamp = Date()
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
            let t = DateFormatter()
            t.dateFormat = "HH:mm"
            var spec: [String: Any] = [
                "video": rec.output.path, "poster": posterURL.path,
                "width": Int(size.width), "height": Int(size.height), "duration": duration,
                "name": "Recording \(t.string(from: stamp))",
                "saveName": "Screen Recording \(f.string(from: stamp))",
            ]
            if let saveTo = rec.saveTo { spec["saveTo"] = saveTo.path }
            if let cursor { spec["cursor"] = cursor.path }
            if let camera, let b = parts.bubble {
                let clip = rec.parts.appendingPathComponent("camera-edit.mp4")
                do {
                    let ends = try await Finisher.cameraClip(camera: camera, parts: parts, length: CMTime(seconds: duration, preferredTimescale: 600), to: clip)
                    let clipPoster = rec.parts.appendingPathComponent("camera-edit.png")
                    _ = await Finisher.poster(for: clip, at: clipPoster)
                    var c: [String: Any] = ["video": clip.path, "poster": clipPoster.path, "x": b.x, "y": b.y, "height": b.diameter,
                                            "radius": b.corner, "ring": b.border, "endsAt": ends]
                    if let path = parts.bubblePath { c["path"] = path }
                    spec["camera"] = c
                } catch {
                    NSLog("Screenshotter: the camera clip didn't save: \(error)")
                }
            }
            hud.dismiss()
            openRecording(spec)
        } catch {
            hud.failed(error.localizedDescription)
        }
    }

    func discard() {
        guard recording != nil else { return }
        Task { await tearDown(keepFiles: false) }
    }

    private func tearDown(keepFiles: Bool) async {
        guard let rec = recording else {
            model.busy = false
            return
        }
        recording = nil
        rec.pill?.end()
        rec.cursor?.stop()
        rec.bubble?.orderOut(nil)
        await rec.screen?.cancel()
        rec.camera?.cancelRecording()
        let bubble = rec.bubble
        rec.camera?.shutDown { bubble?.detach() }
        if !keepFiles {
            try? FileManager.default.removeItem(at: rec.parts)
            try? FileManager.default.removeItem(at: rec.output)
        }
        model.busy = false
        updateStatusItem()
    }

    // MARK: After a capture

    private func newHUD(on screen: NSScreen) -> CaptureHUD {
        hud?.dismiss()
        let hud = CaptureHUD(on: screen, actions: CaptureHUD.Actions(
            edit: { [weak self] original in
                guard let self else { return }
                // A design of its own, the capture filling a canvas its size (no device frame).
                let url = self.libraryCopy(of: original)
                let video = url.pathExtension.lowercased() == "mp4"
                let poster = video ? CaptureFiles.poster(for: url) : nil
                let rep = NSImage(contentsOf: poster ?? url)?.representations.first
                let t = DateFormatter()
                t.dateFormat = "HH:mm"
                var spec: [String: Any] = ["width": rep?.pixelsWide ?? 1920, "height": rep?.pixelsHigh ?? 1080]
                if video {
                    Task {
                        spec["video"] = url.path
                        spec["poster"] = poster?.path
                        spec["duration"] = (try? await AVURLAsset(url: url).load(.duration).seconds) ?? 6
                        spec["name"] = "Recording \(t.string(from: Date()))"
                        self.openRecording(spec)
                    }
                } else {
                    spec["image"] = url.path
                    spec["name"] = "Screenshot \(t.string(from: Date()))"
                    self.openRecording(spec)
                }
            },
            copy: { url in
                let pb = NSPasteboard.general
                pb.clearContents()
                var items: [NSPasteboardWriting] = [url as NSURL]
                if url.pathExtension.lowercased() == "png", let image = NSImage(contentsOf: url) { items.insert(image, at: 0) }
                pb.writeObjects(items)
            },
            saveAs: { url in
                let panel = NSSavePanel()
                panel.nameFieldStringValue = url.lastPathComponent
                panel.directoryURL = FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask).first
                NSApp.activate(ignoringOtherApps: true)
                if panel.runModal() == .OK, let dest = panel.url {
                    try? FileManager.default.removeItem(at: dest)
                    try? FileManager.default.copyItem(at: url, to: dest)
                }
            },
            reveal: { url in NSWorkspace.shared.activateFileViewerSelecting([url]) },
            delete: { url in
                let fm = FileManager.default
                try? fm.removeItem(at: url)
                try? fm.removeItem(at: URL(fileURLWithPath: url.path + ".json"))
                if url.pathExtension.lowercased() == "mp4" {
                    let poster = CaptureFiles.poster(for: url)
                    try? fm.removeItem(at: poster)
                    try? fm.removeItem(at: URL(fileURLWithPath: poster.path + ".json"))
                    try? fm.removeItem(at: CaptureFiles.partsFolder(for: url))
                }
            }))
        self.hud = hud
        return hud
    }

    /// A capture kept outside the library (the Desktop, a folder, the clipboard), copied into it so
    /// the canvas and its Screenshots panel have it; library captures are used as they are.
    private func libraryCopy(of url: URL) -> URL {
        if CaptureFiles.isInLibrary(url) { return url }
        if let copy = libraryCopies[url], FileManager.default.fileExists(atPath: copy.path) { return copy }
        let files = CaptureFiles(library: library())
        let video = url.pathExtension.lowercased() == "mp4"
        guard let dest = try? (video ? files.newRecording(named: "screen") : files.newScreenshot(named: "screenshot")),
              (try? FileManager.default.copyItem(at: url, to: dest)) != nil else { return url }
        let picture = video ? CaptureFiles.poster(for: dest) : dest
        if video { try? FileManager.default.copyItem(at: CaptureFiles.poster(for: url), to: picture) }
        if let rep = NSImage(contentsOf: picture)?.representations.first {
            CaptureFiles.writeNotes(for: picture, kind: nil, app: nil, scale: 2, size: CGSize(width: rep.pixelsWide, height: rep.pixelsHigh))
        }
        libraryCopies[url] = dest
        return dest
    }

    /// During the self-test, problems go to its log instead of an alert.
    private var testLog: ((String) -> Void)?

    /// In the self-test: how long a step held the main thread.
    private func timed<T>(_ step: String, _ work: () throws -> T) rethrows -> T {
        guard let testLog else { return try work() }
        let t0 = CACurrentMediaTime()
        defer { testLog(String(format: "step %@: %.0f ms", step, (CACurrentMediaTime() - t0) * 1000)) }
        return try work()
    }

    private func fail(_ title: String, _ error: Error?) {
        model.busy = false
        if let testLog { return testLog("\(title): \(error?.localizedDescription ?? "no detail")") }
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = error?.localizedDescription ?? "Something went wrong."
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    // MARK: Self-test

    /// `SCREENSHOTTER_CAPTURE_SELFTEST=<log>`: a screenshot of the main screen, then a 3-second
    /// recording of it (no camera, microphone or sound), each written down in the log, then quit.
    func selfTest(log: URL) {
        var lines: [String] = []
        func note(_ s: String) {
            lines.append(s)
            try? lines.joined(separator: "\n").write(to: log, atomically: true, encoding: .utf8)
        }
        let screen = NSScreen.main ?? NSScreen.screens[0]
        testLog = { note($0) }
        Task {
            note("permission: screen \(CGPreflightScreenCaptureAccess()), camera \(AVCaptureDevice.authorizationStatus(for: .video).rawValue), microphone \(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)")
            do {
                let (image, scale) = try await ScreenShot.image(of: .screen(screen))
                let url = try CaptureFiles(library: library()).newScreenshot(named: "selftest")
                try ScreenShot.writePNG(image, to: url, scale: scale)
                note("screenshot: \(url.path) \(image.width)x\(image.height) @\(scale)x")
            } catch { note("screenshot failed: \(error.localizedDescription)") }
            // SCREENSHOTTER_CAPTURE_SELFTEST_CAMERA=1 records the camera too, _MIC=1 the microphone,
            // and _CAMERA_OFF=1 turns the camera off halfway.
            let env = ProcessInfo.processInfo.environment
            let withCamera = env["SCREENSHOTTER_CAPTURE_SELFTEST_CAMERA"] == "1"
            let saved = (model.cameraOn, model.micOn, model.systemAudio, model.countdown)
            model.cameraOn = withCamera && !model.cameras.isEmpty
            model.micOn = env["SCREENSHOTTER_CAPTURE_SELFTEST_MIC"] == "1" && model.micAvailable
            model.systemAudio = false
            model.countdown = env["SCREENSHOTTER_CAPTURE_SELFTEST_COUNTDOWN"] == "1"
            note("camera: \(model.cameraOn ? model.cameraName : "off"), microphone: \(model.micOn ? model.micName : "off")")
            record(.screen(screen))
            // Your own choices back before quitting (they're saved as they change).
            let restore = { (self.model.cameraOn, self.model.micOn, self.model.systemAudio, self.model.countdown) = saved }
            // SCREENSHOTTER_CAPTURE_SELFTEST_SECONDS: how long to record (4 by default); the main
            // thread's hiccups are timed meanwhile.
            let seconds = Double(env["SCREENSHOTTER_CAPTURE_SELFTEST_SECONDS"] ?? "") ?? 4
            let began = CACurrentMediaTime()
            var last = began
            var worst = 0.0
            var hitches: [String] = []
            let beat = Timer(timeInterval: 1.0 / 60, repeats: true) { _ in
                let now = CACurrentMediaTime()
                let gap = now - last
                last = now
                worst = max(worst, gap)
                if gap > 0.05 { hitches.append(String(format: "%.0f ms at %.1f s", gap * 1000, now - began)) }
            }
            RunLoop.main.add(beat, forMode: .common)
            if env["SCREENSHOTTER_CAPTURE_SELFTEST_CAMERA_OFF"] == "1" {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                cameraOffPressed()
                note("camera turned off")
                try? await Task.sleep(nanoseconds: 2_500_000_000)
            } else {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            }
            beat.invalidate()
            note(String(format: "main thread: longest gap %.0f ms; over 50 ms: ", worst * 1000) + hitches.joined(separator: ", "))
            guard let rec = recording else {
                note("recording didn't start")
                restore()
                return NSApp.terminate(nil)
            }
            if let started = rec.startedAt { note(String(format: "recording began at %.1f s", started - began)) }
            let output = rec.output
            stop()
            for _ in 0..<60 where !FileManager.default.fileExists(atPath: CaptureFiles.poster(for: output).path) {
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            let duration = (try? await AVURLAsset(url: output).load(.duration).seconds) ?? 0
            let size = (try? await AVURLAsset(url: output).loadTracks(withMediaType: .video).first?.load(.naturalSize)) ?? .zero
            note("recording: \(output.path) \(String(format: "%.2f", duration))s \(Int(size.width))x\(Int(size.height)) poster: \(FileManager.default.fileExists(atPath: CaptureFiles.poster(for: output).path))")
            let partsFile = output.deletingLastPathComponent().appendingPathComponent(".parts").appendingPathComponent(output.deletingPathExtension().lastPathComponent).appendingPathComponent("parts.json")
            note("parts: \((try? String(contentsOf: partsFile, encoding: .utf8)) ?? "none")")
            let cursorFile = partsFile.deletingLastPathComponent().appendingPathComponent("cursor.json")
            if let data = try? Data(contentsOf: cursorFile), let log = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                note("cursor log: \((log["samples"] as? [Any])?.count ?? 0) points, \((log["clicks"] as? [Any])?.count ?? 0) clicks, cursors \(log["kinds"] ?? [])")
            } else { note("cursor log: none") }
            if let w = rec.screen?.writer { note("screen frames: \(w.written[.video] ?? 0) written, \(w.dropped[.video] ?? 0) dropped (writer behind); sound: \(w.written[.audio1] ?? 0)/\(w.written[.audio2] ?? 0) written, \((w.dropped[.audio1] ?? 0) + (w.dropped[.audio2] ?? 0)) dropped") }
            for (name, w) in [("screen", rec.screen?.writer), ("camera", rec.camera?.lastWriter)] {
                guard let w else { continue }
                if let p = w.pictureSpan { note(String(format: "%@ picture spans %.3f s", name, (p.end - p.start).seconds)) }
                for (track, span) in w.soundSpan {
                    let held = w.soundHeld[track] ?? 0
                    let d = w.soundDelay[track].map { $0.total / Double(max(1, $0.count)) } ?? 0
                    note(String(format: "%@ sound %@: spans %.3f s by its timestamps, holds %.3f s of sound (%.2f%% short); arrives %.0f ms after its moment",
                                name, "\(track)", (span.end - span.start).seconds, held, (1 - held / max(0.001, (span.end - span.start).seconds)) * 100, d * 1000))
                }
            }
            if let mic = AVCaptureDevice(uniqueID: model.micID) ?? AVCaptureDevice.default(for: .audio) { note("microphone: \(mic.localizedName)") }
            if let cam = rec.camera, let w = cam.lastWriter { note("camera frames: \(w.written[.video] ?? 0) written, \(w.dropped[.video] ?? 0) dropped (writer behind), \(cam.lateFrames) late; mic: \(w.written[.audio1] ?? 0) written, \(w.dropped[.audio1] ?? 0) dropped, \(String(format: "%.3f", w.gaps[.audio1] ?? 0)) s missing as it arrived, \(String(format: "%.3f", w.filled[.audio1] ?? 0)) s of silence put in") }
            note("done")
            restore()
            NSApp.terminate(nil)
        }
    }

    // MARK: Menu bar and shortcut

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item
        updateStatusItem()
    }

    private func updateStatusItem() {
        guard let item = statusItem, let button = item.button else { return }
        let menu = NSMenu()
        if let rec = recording {
            let paused = rec.clock.isPaused
            button.image = NSImage(systemSymbolName: paused ? "pause.circle.fill" : "record.circle.fill", accessibilityDescription: "Recording")
            button.contentTintColor = paused ? .systemOrange : .systemRed
            menu.addItem(entry("Stop and Save Recording", #selector(MenuTarget.menuStop)))
            menu.addItem(entry(paused ? "Resume" : "Pause", #selector(MenuTarget.menuPause)))
            if rec.bubble != nil { menu.addItem(entry("Turn Camera Off", #selector(MenuTarget.menuCameraOff))) }
            menu.addItem(entry("Discard Recording", #selector(MenuTarget.menuDiscard)))
        } else {
            button.image = NSImage(systemSymbolName: "camera.viewfinder", accessibilityDescription: "Screenshotter")
            button.contentTintColor = nil
            menu.addItem(entry("Take a Screenshot…", #selector(MenuTarget.menuScreenshot), key: "2"))
            menu.addItem(entry("Record the Screen…", #selector(MenuTarget.menuRecord)))
            menu.addItem(.separator())
            menu.addItem(entry("Open Screenshotter", #selector(MenuTarget.menuOpen)))
            menu.addItem(.separator())
            menu.addItem(entry("Quit Screenshotter", #selector(NSApplication.terminate(_:)), target: NSApp))
        }
        item.menu = menu
    }

    private func entry(_ title: String, _ action: Selector, key: String = "", target: AnyObject? = nil) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        if !key.isEmpty { i.keyEquivalentModifierMask = [.command, .shift] }
        i.target = target ?? MenuTarget.shared
        MenuTarget.shared.owner = self
        return i
    }

    func menuScreenshot() { showBar(.screenshot) }
    func menuRecord() { showBar(.record) }
    func menuOpen() { openStudio() }
    func menuStop() { stop() }
    func menuPause() { togglePause() }
    func menuDiscard() { discard() }
    func menuCameraOff() { cameraOffPressed() }

    /// ⌘⇧2 anywhere: the capture bar (or, while recording, stop).
    private func installHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { MenuTarget.shared.owner?.hotKeyPressed() }
            return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x5353_4854), id: 1)
        RegisterEventHotKey(UInt32(kVK_ANSI_2), UInt32(cmdKey | shiftKey), id, GetApplicationEventTarget(), 0, &hotKey)
    }

    func hotKeyPressed() {
        if recording != nil { return stop() }
        if barVisible { hideBar() } else { showBar() }
    }
}

/// The menu bar menu's target (menu items need an Objective-C object to call).
@MainActor final class MenuTarget: NSObject {
    static let shared = MenuTarget()
    weak var owner: CaptureCoordinator?
    @objc func menuScreenshot() { owner?.menuScreenshot() }
    @objc func menuRecord() { owner?.menuRecord() }
    @objc func menuOpen() { owner?.menuOpen() }
    @objc func menuStop() { owner?.menuStop() }
    @objc func menuPause() { owner?.menuPause() }
    @objc func menuDiscard() { owner?.menuDiscard() }
    @objc func menuCameraOff() { owner?.menuCameraOff() }
}
