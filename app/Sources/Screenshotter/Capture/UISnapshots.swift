import AppKit
import SwiftUI

/// `Screenshotter --ui-snapshots <folder>`: draws the capture bar, the recording pill and the
/// after-capture panel to PNGs and quits, so their look can be checked without capturing anything.
@MainActor enum UISnapshots {
    static func render(to folder: URL, sample: URL?) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let scratch = UserDefaults(suiteName: "screenshotter.ui-snapshots")!
        scratch.removePersistentDomain(forName: "screenshotter.ui-snapshots")
        let model = CaptureModel(defaults: scratch)
        let noop = CaptureBarActions(capture: {}, openStudio: {}, close: {}, resized: {}, chooseFolder: {})

        model.mode = .screenshot
        model.target = .area
        save(CaptureBarView(model: model, actions: noop), "1-bar-screenshot", folder)

        model.mode = .record
        model.target = .screen
        model.cameraOn = !model.cameras.isEmpty
        model.micOn = true
        model.systemAudio = true
        save(CaptureBarView(model: model, actions: noop), "2-bar-record", folder)

        let pill = RecordingPill.State()
        pill.elapsed = 42
        pill.camera = true
        save(RecordingPillView(state: pill, onPause: {}, onStop: {}, onDiscard: {}, setSmall: { _ in }), "3-recording-pill", folder)
        pill.small = true
        save(RecordingPillView(state: pill, onPause: {}, onStop: {}, onDiscard: {}, setSmall: { _ in }), "3b-recording-pill-small", folder)

        // Discard pressed once: the pill asks before throwing the recording away.
        pill.small = false
        pill.confirmingDiscard = true
        save(RecordingPillView(state: pill, onPause: {}, onStop: {}, onDiscard: {}, setSmall: { _ in }), "3c-recording-pill-discard", folder)
        pill.camera = false
        pill.confirmingDiscard = false
        save(RecordingPillView(state: pill, onPause: {}, onStop: {}, onDiscard: {}, setSmall: { _ in }), "3d-recording-pill-no-camera", folder)

        // Where they went, worded as the coordinator words it.
        let library = CaptureFiles(library: URL(fileURLWithPath: "/tmp"))
        let image = sample.flatMap { NSImage(contentsOf: $0) }
        let actions = CaptureHUD.Actions(edit: { _ in }, copy: { _ in }, saveAs: { _ in }, reveal: { _ in }, delete: { _ in })
        let shot = CaptureHUD.State()
        shot.image = image
        shot.title = "Screenshot saved"
        shot.detail = "2560 × 1600 · \(library.placeName(video: false))"
        shot.file = URL(fileURLWithPath: "/tmp/x.png")
        shot.working = false
        save(CaptureHUDView(state: shot, actions: actions, close: {}, hover: { _ in }), "4-after-screenshot", folder)

        let rec = CaptureHUD.State()
        rec.image = image
        rec.title = "Recording saved · 0:42"
        rec.detail = "With your camera · \(library.placeName(video: true))"
        rec.file = URL(fileURLWithPath: "/tmp/x.mp4")
        rec.working = false
        rec.isVideo = true
        save(CaptureHUDView(state: rec, actions: actions, close: {}, hover: { _ in }), "5-after-recording", folder)

        // Saved to a folder with a long name: the line wraps rather than being cut off.
        let folderRec = CaptureHUD.State()
        folderRec.image = image
        folderRec.title = "Recording saved · 12:05"
        folderRec.detail = "With your camera · \(CaptureFiles(library: library.library, destination: .folder, folder: "/Users/me/Movies/Client launch videos 2026").placeName(video: true))"
        folderRec.file = URL(fileURLWithPath: "/tmp/x.mp4")
        folderRec.working = false
        folderRec.isVideo = true
        save(CaptureHUDView(state: folderRec, actions: actions, close: {}, hover: { _ in }), "5d-after-recording-folder", folder)

        let saving = CaptureHUD.State()
        saving.title = "Saving your recording…"
        save(CaptureHUDView(state: saving, actions: actions, close: {}, hover: { _ in }), "5b-saving", folder)

        let failed = CaptureHUD.State()
        failed.working = false
        failed.failed = true
        failed.title = "Couldn't save it"
        failed.detail = "Nothing was recorded. Try again."
        save(CaptureHUDView(state: failed, actions: actions, close: {}, hover: { _ in }), "5c-failed", folder)

        // The countdown, a second in.
        let count = Countdown.State()
        count.count = 2
        count.done = 0.42
        save(CountdownView(state: count), "9-countdown", folder)

        // Saving to the Desktop; the camera's style panel.
        model.mode = .screenshot
        model.shotDestination = .desktop
        save(CaptureBarView(model: model, actions: noop), "7-bar-save-to-desktop", folder)
        model.bubbleShape = .rounded
        model.bubbleAspect = .landscape
        let spot = BubbleStylePanel.Spot()
        spot.corner = .bottomLeft
        save(BubbleStyleView(model: model, spot: spot), "8-camera-style", folder)
        model.bubbleShape = .circle
        spot.corner = nil
        save(BubbleStyleView(model: model, spot: spot), "8b-camera-style-circle", folder)

        // The area picker over a screen, mid-drag.
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let view = PickerView(screen: screen, kind: .area, windows: []) { _ in }
        view.start = CGPoint(x: screen.frame.width * 0.3, y: screen.frame.height * 0.28)
        view.current = CGPoint(x: screen.frame.width * 0.72, y: screen.frame.height * 0.74)
        saveView(view, "6-area-picker", folder)
    }

    private static func save<V: View>(_ view: V, _ name: String, _ folder: URL) {
        let host = NSHostingView(rootView: view)
        host.layoutSubtreeIfNeeded()
        host.frame = CGRect(origin: .zero, size: host.fittingSize)
        saveView(host, name, folder)
    }

    private static func saveView(_ view: NSView, _ name: String, _ folder: URL) {
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = view
        window.appearance = NSAppearance(named: .darkAqua)
        view.layoutSubtreeIfNeeded()
        view.display()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: folder.appendingPathComponent("\(name).png"))
    }
}
