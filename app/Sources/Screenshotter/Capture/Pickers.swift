import AppKit

/// What was picked to capture: an area of one screen, a window, or a whole screen. Frames are in
/// AppKit's global coordinates (origin at the bottom left of the main screen).
enum CaptureRegion {
    case area(NSScreen, CGRect)
    case window(CGWindowID, CGRect, String, NSScreen)
    case screen(NSScreen)

    var screen: NSScreen {
        switch self {
        case .area(let s, _), .window(_, _, _, let s), .screen(let s): return s
        }
    }
    /// The part of the screen it covers, in global AppKit coordinates.
    var frame: CGRect {
        switch self {
        case .area(_, let r), .window(_, let r, _, _): return r
        case .screen(let s): return s.frame
        }
    }
    var name: String {
        switch self {
        case .area: return "area"
        case .window(_, _, let app, _): return app
        case .screen: return "screen"
        }
    }
}

/// The on-screen windows of other apps, front to back, with their frames in AppKit coordinates.
struct OnScreenWindow {
    let id: CGWindowID
    let frame: CGRect
    let app: String

    static func list() -> [OnScreenWindow] {
        guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        let mainHeight = NSScreen.screens.first?.frame.height ?? 0
        let me = ProcessInfo.processInfo.processIdentifier
        return raw.compactMap { w in
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  (w[kCGWindowOwnerPID as String] as? Int32) != me,
                  (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.05,
                  let id = w[kCGWindowNumber as String] as? CGWindowID,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"],
                  width > 60, height > 40 else { return nil }
            // Quartz measures from the top left of the main screen; AppKit from its bottom left.
            let frame = CGRect(x: x, y: mainHeight - y - height, width: width, height: height)
            return OnScreenWindow(id: id, frame: frame, app: w[kCGWindowOwnerName as String] as? String ?? "Window")
        }
    }
}

/// A see-through layer over every screen for choosing what to capture: drag out an area, or point
/// at a window and click it. Esc lets go.
@MainActor final class RegionPicker {
    enum Kind { case area, window }
    private var overlays: [PickerWindow] = []
    private var done: ((CaptureRegion?) -> Void)?
    private var monitor: Any?
    private static var current: RegionPicker?

    static func pick(_ kind: Kind, _ done: @escaping (CaptureRegion?) -> Void) {
        current?.finish(nil)
        let picker = RegionPicker()
        current = picker
        picker.start(kind, done)
    }

    private func start(_ kind: Kind, _ done: @escaping (CaptureRegion?) -> Void) {
        self.done = done
        let windows = kind == .window ? OnScreenWindow.list() : []
        for screen in NSScreen.screens {
            let w = PickerWindow(screen: screen, kind: kind, windows: windows) { [weak self] result in self?.finish(result) }
            overlays.append(w)
            w.orderFrontRegardless()
        }
        let mouse = NSEvent.mouseLocation
        (overlays.first { $0.frame.contains(mouse) } ?? overlays.first)?.makeKey()
        NSCursor.crosshair.push()
        // Esc anywhere cancels, whichever overlay has the keyboard.
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == 53 {
                self?.finish(nil)
                return nil
            }
            return e
        }
    }

    private func finish(_ result: CaptureRegion?) {
        guard let done else { return }
        self.done = nil
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        NSCursor.pop()
        overlays.forEach { $0.orderOut(nil) }
        overlays = []
        if RegionPicker.current === self { RegionPicker.current = nil }
        // Let the overlays leave the screen before anything is captured.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { done(result) }
    }
}

/// A panel that never makes Screenshotter the active app: activating it would pull you out of a
/// full-screen app to the Space where Screenshotter's own window is (the desktop, usually).
final class PickerWindow: NSPanel {
    init(screen: NSScreen, kind: RegionPicker.Kind, windows: [OnScreenWindow], done: @escaping (CaptureRegion?) -> Void) {
        super.init(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isFloatingPanel = true
        becomesKeyOnlyIfNeeded = false
        hidesOnDeactivate = false
        isOpaque = false
        backgroundColor = .clear
        level = .screenSaver
        hasShadow = false
        ignoresMouseEvents = false
        acceptsMouseMovedEvents = true
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        setFrame(screen.frame, display: false)
        contentView = PickerView(screen: screen, kind: kind, windows: windows, done: done)
    }
    override var canBecomeKey: Bool { true }
}

final class PickerView: NSView {
    private let screen: NSScreen
    private let kind: RegionPicker.Kind
    private let windows: [OnScreenWindow]
    private let done: (CaptureRegion?) -> Void
    // Not private: the UI snapshots set a selection to draw.
    var start: CGPoint?
    var current: CGPoint?
    var hovered: OnScreenWindow?

    init(screen: NSScreen, kind: RegionPicker.Kind, windows: [OnScreenWindow], done: @escaping (CaptureRegion?) -> Void) {
        self.screen = screen
        self.kind = kind
        self.windows = windows
        self.done = done
        super.init(frame: CGRect(origin: .zero, size: screen.frame.size))
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeAlways, .inVisibleRect, .cursorUpdate], owner: self))
    }
    required init?(coder: NSCoder) { fatalError() }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func cursorUpdate(with event: NSEvent) { NSCursor.crosshair.set() }

    /// A point in this view → global AppKit coordinates, and back.
    private func global(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x + screen.frame.minX, y: p.y + screen.frame.minY) }
    private func local(_ r: CGRect) -> CGRect { r.offsetBy(dx: -screen.frame.minX, dy: -screen.frame.minY) }

    private var selection: CGRect? {
        guard let a = start, let b = current else { return nil }
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y)).integral
    }

    override func mouseMoved(with event: NSEvent) {
        guard kind == .window else { return }
        let p = global(convert(event.locationInWindow, from: nil))
        let hit = windows.first { $0.frame.contains(p) }
        if hit?.id != hovered?.id {
            hovered = hit
            needsDisplay = true
        }
    }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if kind == .window {
            if let w = windows.first(where: { $0.frame.contains(global(p)) }) {
                done(.window(w.id, w.frame, w.app, NSScreen.screens.first { $0.frame.intersects(w.frame) } ?? screen))
            }
            return
        }
        start = p
        current = p
    }

    override func mouseDragged(with event: NSEvent) {
        guard kind == .area else { return }
        let p = convert(event.locationInWindow, from: nil)
        current = CGPoint(x: min(max(p.x, 0), bounds.width), y: min(max(p.y, 0), bounds.height))
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        guard kind == .area, let r = selection else { return }
        start = nil
        current = nil
        needsDisplay = true
        // A click without a drag takes the whole screen.
        if r.width < 6 || r.height < 6 { return done(.screen(screen)) }
        done(.area(screen, r.offsetBy(dx: screen.frame.minX, dy: screen.frame.minY)))
    }

    override func draw(_ dirty: NSRect) {
        let dim = NSColor.black.withAlphaComponent(0.32)
        let hole: CGRect? = kind == .area ? selection : hovered.map { local($0.frame).intersection(bounds) }
        dim.setFill()
        let path = NSBezierPath(rect: bounds)
        if let hole, !hole.isEmpty {
            path.append(NSBezierPath(roundedRect: hole, xRadius: kind == .window ? 10 : 0, yRadius: kind == .window ? 10 : 0))
            path.windingRule = .evenOdd
        }
        path.fill()

        if let hole, !hole.isEmpty {
            let edge = NSBezierPath(roundedRect: hole.insetBy(dx: -1, dy: -1), xRadius: kind == .window ? 11 : 0, yRadius: kind == .window ? 11 : 0)
            edge.lineWidth = kind == .window ? 3 : 1.5
            (kind == .window ? NSColor(red: 0.82, green: 1, blue: 0.3, alpha: 1) : NSColor.white).setStroke()
            edge.stroke()
            let label: String
            if kind == .window, let w = hovered { label = "\(w.app) · \(Int(w.frame.width)) × \(Int(w.frame.height))" } else { label = "\(Int(hole.width)) × \(Int(hole.height))" }
            pill(label, at: CGPoint(x: hole.midX, y: kind == .window ? hole.midY : hole.minY - 22))
        }
        if start == nil, hovered == nil {
            let hint = kind == .area ? "Drag to choose an area  ·  Click for the whole screen  ·  Esc to cancel" : "Click a window to capture it  ·  Esc to cancel"
            if screen.frame.contains(NSEvent.mouseLocation) { pill(hint, at: CGPoint(x: bounds.midX, y: bounds.maxY - 90)) }
        }
    }

    private func pill(_ text: String, at center: CGPoint) {
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13, weight: .semibold), .foregroundColor: NSColor.white]
        let size = (text as NSString).size(withAttributes: attrs)
        let box = CGRect(x: center.x - size.width / 2 - 12, y: center.y - size.height / 2 - 6, width: size.width + 24, height: size.height + 12)
        NSColor.black.withAlphaComponent(0.72).setFill()
        NSBezierPath(roundedRect: box, xRadius: box.height / 2, yRadius: box.height / 2).fill()
        (text as NSString).draw(at: CGPoint(x: box.minX + 12, y: box.minY + 6), withAttributes: attrs)
    }
}
