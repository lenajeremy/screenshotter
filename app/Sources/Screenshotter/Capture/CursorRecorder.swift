import AppKit
import CoreMedia

/// Where the camera bubble was while recording (30 times a second, read from the window server so
/// a drag in progress counts), so the video's bubble moves and resizes as it did on screen.
@MainActor final class BubbleTracker {
    private weak var bubble: NSWindow?
    private var timer: Timer?
    private(set) var log: [(CMTime, CGRect)] = []

    init(bubble: NSWindow) { self.bubble = bubble }

    /// The bubble's frame in AppKit's global coordinates, as the window server has it right now.
    private func frameNow() -> CGRect? {
        guard let w = bubble, w.isVisible else { return nil }
        guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(w.windowNumber)) as? [[String: Any]])?.first,
              let b = info[kCGWindowBounds as String] as? [String: CGFloat],
              let x = b["X"], let y = b["Y"], let width = b["Width"], let height = b["Height"] else { return w.frame }
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        return CGRect(x: x, y: top - y - height, width: width, height: height)
    }

    func start() {
        sample()
        let t = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func sample() {
        guard let f = frameNow() else { return }
        if log.last?.1 != f { log.append((CMClockGetTime(CMClockGetHostTimeClock()), f)) }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// The path as the recording has it: [seconds, centre x, centre y, height], shares of `region`
    /// (from its top left), times from `start` with the pauses taken out.
    func path(in region: CGRect, start: CMTime, clock: PauseClock) -> [[Double]] {
        guard let origin = clock.shifted(start) else { return [] }
        let r4 = { (v: Double) in (v * 10000).rounded() / 10000 }
        var out: [[Double]] = []
        for (at, f) in log {
            guard let t = clock.shifted(at) else { continue }
            let p = [max(0, (t - origin).seconds), Double((f.midX - region.minX) / region.width), Double((region.maxY - f.midY) / region.height), Double(f.height / region.height)].map(r4)
            // Moves before the recording began: only where it was when it did.
            if p[0] == 0, !out.isEmpty { out[out.count - 1] = p } else { out.append(p) }
        }
        return out
    }
}

/// The cursor, logged beside a recording instead of drawn into it: where it is (60 times a second),
/// every click, and which cursor macOS shows (the arrow, the text I-beam, the pointing hand). The
/// editor draws it from this log, smoothed or not, with click ripples, and zooms and follows it.
@MainActor final class CursorRecorder {
    private let region: CGRect
    private var timer: Timer?
    private var monitor: Any?
    private var samples: [(CMTime, CGPoint)] = []
    private var clicks: [(CMTime, CGPoint, String)] = []
    private var kinds: [(CMTime, String)] = []
    private var last: CGPoint?
    private var tick = 0
    private let shapes: [(String, CGPoint)]

    /// `region`: what's being recorded, in AppKit's global coordinates.
    init(region: CGRect) {
        self.region = region
        // macOS's own cursors, known by where their hot spot sits in their picture.
        shapes = [("text", NSCursor.iBeam), ("hand", NSCursor.pointingHand), ("grab", NSCursor.openHand), ("grabbing", NSCursor.closedHand), ("arrow", NSCursor.arrow)]
            .map { ($0.0, CursorRecorder.signature($0.1)) }
    }

    private static func now() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

    /// A cursor's hot spot as a share of its picture: the same at any cursor size.
    private static func signature(_ c: NSCursor) -> CGPoint {
        let s = c.image.size
        guard s.width > 0, s.height > 0 else { return .zero }
        return CGPoint(x: c.hotSpot.x / s.width, y: c.hotSpot.y / s.height)
    }

    func start() {
        record(force: true)
        let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.record(force: false) }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        // Clicks anywhere (in other apps: clicks on Screenshotter's own panels aren't part of it).
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .rightMouseDown]) { [weak self] e in
            let at = CursorRecorder.now()
            let p = NSEvent.mouseLocation
            let kind = e.type == .leftMouseDown ? (e.clickCount > 1 ? "double" : "down") : e.type == .leftMouseUp ? "up" : "right"
            MainActor.assumeIsolated { self?.clicks.append((at, p, kind)) }
        }
    }

    private func record(force: Bool) {
        let p = NSEvent.mouseLocation
        let at = CursorRecorder.now()
        if force || p != last {
            samples.append((at, p))
            last = p
        }
        // Which cursor, a few times a second (asking is slower than asking where).
        tick += 1
        if force || tick % 6 == 0, let current = NSCursor.currentSystem {
            let sig = CursorRecorder.signature(current)
            let kind = shapes.min { hypot($0.1.x - sig.x, $0.1.y - sig.y) < hypot($1.1.x - sig.x, $1.1.y - sig.y) }
            let name = kind.map { hypot($0.1.x - sig.x, $0.1.y - sig.y) < 0.08 ? $0.0 : "arrow" } ?? "arrow"
            if kinds.last?.1 != name { kinds.append((at, name)) }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    /// The log, written beside the recording's parts: times in seconds of the finished recording
    /// (from `start`, pauses taken out), places as shares of what was recorded (from its top left).
    func write(to url: URL, start: CMTime, clock: PauseClock) {
        guard let origin = clock.shifted(start) else { return }
        let r = region
        func at(_ t: CMTime) -> Double? { clock.shifted(t).map { max(0, ($0 - origin).seconds) } }
        func fx(_ p: CGPoint) -> Double { Double((p.x - r.minX) / r.width) }
        func fy(_ p: CGPoint) -> Double { Double((r.maxY - p.y) / r.height) }
        let round4 = { (v: Double) in (v * 10000).rounded() / 10000 }
        var out: [String: Any] = ["version": 1, "width": Int(r.width), "height": Int(r.height)]
        out["samples"] = samples.compactMap { s in at(s.0).map { [round4($0), round4(fx(s.1)), round4(fy(s.1))] } }
        out["clicks"] = clicks.compactMap { c in at(c.0).map { [round4($0), round4(fx(c.1)), round4(fy(c.1)), c.2] as [Any] } }
        out["kinds"] = kinds.compactMap { k in at(k.0).map { [round4($0), k.1] as [Any] } }
        if let data = try? JSONSerialization.data(withJSONObject: out) { try? data.write(to: url) }
    }
}
