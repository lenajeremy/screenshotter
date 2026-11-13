import Combine
import AppKit
import AVFoundation
import SwiftUI

/// The camera as you'll appear: a live preview that floats over everything. Drag it anywhere; hover
/// for its style (shape, roundness, proportions, size, mirror, border) and to turn the camera off.
/// Its place and look become the bubble's in the finished recording.
@MainActor final class CameraBubble: NSPanel {
    private let preview: AVCaptureVideoPreviewLayer
    private let container = BubbleContainer()
    private let controls: NSHostingView<BubbleControls>
    private let model: CaptureModel
    private var watch: AnyCancellable?
    private var stylePanel: BubbleStylePanel?
    /// What's being recorded, once a recording starts: the corners it snaps to. Before, the screen's.
    var area: CGRect?

    /// `spot`: where it was last left (its bottom left corner), if that's still on a screen.
    init(session: AVCaptureSession, model: CaptureModel, near region: CGRect, at spot: CGPoint? = nil, onCameraOff: @escaping () -> Void) {
        self.model = model
        preview = AVCaptureVideoPreviewLayer(session: session)
        let hover = BubbleControls.State()
        controls = NSHostingView(rootView: BubbleControls(state: hover, onStyle: {}, onOff: onCameraOff))
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .statusBar
        isFloatingPanel = true
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        preview.videoGravity = .resizeAspectFill
        container.wantsLayer = true
        container.layer?.addSublayer(preview)
        container.onHover = { on in hover.visible = on }
        container.onRightClick = { [weak self] in self?.showStyle() }
        controls.rootView = BubbleControls(state: hover, onStyle: { [weak self] in self?.showStyle() }, onOff: onCameraOff)
        container.addSubview(controls)
        contentView = container
        let size = model.bubbleFrameSize
        // Where it was left, or the bottom left of `region`, a little in from the corner.
        var origin = CGPoint(x: region.minX + 28, y: region.minY + 28)
        if let spot, NSScreen.screens.contains(where: { $0.frame.contains(CGPoint(x: spot.x + size.width / 2, y: spot.y + size.height / 2)) }) { origin = spot }
        setFrame(CGRect(origin: origin, size: size), display: false)
        apply()
        // Changes in the style panel show straight away.
        watch = model.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.apply() }
        }
    }

    override var canBecomeKey: Bool { false }

    /// Lets go of the camera (once it has stopped) and closes.
    func detach() {
        stylePanel?.dismiss()
        orderOut(nil)
        preview.session = nil
        watch = nil
    }

    /// Size, outline, mirror and rim from the model, keeping the bubble's centre where it is (or,
    /// sitting in a corner, keeping it in that corner).
    private func apply() {
        let size = model.bubbleFrameSize
        let c = CGPoint(x: frame.midX, y: frame.midY)
        if abs(frame.width - size.width) > 0.5 || abs(frame.height - size.height) > 0.5 {
            var f = CGRect(x: c.x - size.width / 2, y: c.y - size.height / 2, width: size.width, height: size.height)
            if let corner { f.origin = origin(in: corner, size: size) }
            setFrame(f, display: true)
            stylePanel?.spot.corner = corner
        }
        let bounds = CGRect(origin: .zero, size: size)
        container.frame = bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        preview.frame = bounds
        let radius = min(size.width, size.height) * model.bubbleCorner
        container.layer?.cornerRadius = radius
        container.layer?.masksToBounds = true
        container.layer?.borderWidth = model.bubbleBorder ? max(2, size.height * 0.018) : 0
        container.layer?.borderColor = NSColor.white.withAlphaComponent(0.92).cgColor
        CATransaction.commit()
        if let c = preview.connection, c.isVideoMirroringSupported {
            c.automaticallyAdjustsVideoMirroring = false
            c.isVideoMirrored = model.bubbleMirrored
        }
        controls.frame = bounds
        invalidateShadow()
    }

    private func showStyle() {
        if let stylePanel, stylePanel.isVisible { return stylePanel.dismiss() }
        let panel = stylePanel ?? BubbleStylePanel(model: model, onCorner: { [weak self] in
            self?.move(to: $0)
            self?.stylePanel?.place(beside: self?.frame ?? .zero)
        })
        stylePanel = panel
        panel.spot.corner = corner
        panel.place(beside: frame)
        panel.orderFrontRegardless()
        panel.watchOutside()
    }

    override func setFrameOrigin(_ point: NSPoint) {
        super.setFrameOrigin(point)
        stylePanel?.spot.corner = corner
        if let stylePanel, stylePanel.isVisible { stylePanel.place(beside: frame) }
    }

    enum Corner: CaseIterable { case topLeft, topRight, bottomLeft, bottomRight }

    /// Into a corner of what's being recorded (before recording, of its screen).
    func move(to corner: Corner) {
        setFrameOrigin(origin(in: corner, size: frame.size))
    }

    /// Where a bubble of `size` sits in `corner`: a little in from it.
    private func origin(in corner: Corner, size: CGSize) -> CGPoint {
        let box = area ?? (screen ?? NSScreen.main)?.visibleFrame ?? frame
        let inset: CGFloat = 28
        let x = corner == .topLeft || corner == .bottomLeft ? box.minX + inset : box.maxX - inset - size.width
        let y = corner == .bottomLeft || corner == .bottomRight ? box.minY + inset : box.maxY - inset - size.height
        return CGPoint(x: x, y: y)
    }

    /// The corner it's sitting in, if it's where `move(to:)` leaves it (the style panel lights it).
    private var corner: Corner? {
        Corner.allCases.first { c in
            let o = origin(in: c, size: frame.size)
            return abs(o.x - frame.minX) < 2 && abs(o.y - frame.minY) < 2
        }
    }

    /// As a recording starts: if it's off what's recorded, into its bottom left corner, so what you
    /// see is what the video gets.
    func keepOver(_ region: CGRect) {
        area = region
        if !region.intersects(frame) { move(to: .bottomLeft) }
    }

    /// Where it sits in the recording of `region`, and how it looks. Off the recorded part, it goes
    /// in the bottom left corner.
    func placement(in region: CGRect) -> BubblePlacement {
        var f = frame
        if !region.intersects(f) { f.origin = CGPoint(x: region.minX + 28, y: region.minY + 28) }
        return BubblePlacement(
            x: Double((f.midX - region.minX) / region.width),
            y: Double((region.maxY - f.midY) / region.height),
            diameter: Double(f.height / region.height),
            mirrored: model.bubbleMirrored,
            shape: model.bubbleShape.rawValue,
            aspect: Double(f.width / f.height),
            corner: model.bubbleCorner,
            border: model.bubbleBorder)
    }
}

/// The bubble's style, in a panel of its own beside it: like a popover, but it never makes
/// Screenshotter the active app (which would pull you out of a full-screen app mid-recording).
/// A click anywhere else closes it.
@MainActor final class BubbleStylePanel: NSPanel {
    /// The corner the bubble's in, if any.
    final class Spot: ObservableObject { @Published var corner: CameraBubble.Corner? }
    let spot = Spot()
    private var outside: Any?

    init(model: CaptureModel, onCorner: @escaping (CameraBubble.Corner) -> Void) {
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        isFloatingPanel = true
        becomesKeyOnlyIfNeeded = true
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let host = FirstClickHostingView(rootView: BubbleStyleView(model: model, spot: spot, onCorner: onCorner))
        host.sizingOptions = [.intrinsicContentSize]
        contentView = host
    }

    /// Above the bubble (below it when there's no room), kept on its screen.
    func place(beside bubble: CGRect) {
        contentView?.layoutSubtreeIfNeeded()
        let size = contentView?.fittingSize ?? CGSize(width: 260, height: 300)
        let visible = (NSScreen.screens.first { $0.frame.intersects(bubble) } ?? NSScreen.main)?.visibleFrame ?? bubble
        var y = bubble.maxY + 10
        if y + size.height > visible.maxY { y = bubble.minY - 10 - size.height }
        let x = min(max(bubble.midX - size.width / 2, visible.minX + 8), visible.maxX - size.width - 8)
        setFrame(CGRect(x: x, y: max(visible.minY + 8, y), width: size.width, height: size.height), display: true)
    }

    /// Closes on a click in another app (clicks on Screenshotter's own windows are theirs).
    func watchOutside() {
        if outside != nil { return }
        outside = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            DispatchQueue.main.async { self?.dismiss() }
        }
    }

    func dismiss() {
        if let outside { NSEvent.removeMonitor(outside) }
        outside = nil
        orderOut(nil)
    }

    override func cancelOperation(_ sender: Any?) { dismiss() }
}

/// Takes the first click even in a window that isn't key (a panel over another app).
final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The bubble's surface: drags the window (any screen), and says when the pointer is over it.
final class BubbleContainer: NSView {
    var onHover: ((Bool) -> Void)?
    var onRightClick: (() -> Void)?
    override func rightMouseDown(with event: NSEvent) { onRightClick?() }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Over the bubble: dragging anywhere moves it (right-click for its style); while the pointer is
/// on it, buttons for its style and to turn the camera off.
struct BubbleControls: View {
    final class State: ObservableObject { @Published var visible = false }
    @ObservedObject var state: State
    let onStyle: () -> Void
    let onOff: () -> Void

    var body: some View {
        ZStack {
            WindowGrip(onRightClick: onStyle)
            VStack {
                Spacer()
                HStack(spacing: 8) {
                    BubbleButton(symbol: "slider.horizontal.3", help: "Shape, size and look", action: onStyle)
                    BubbleButton(symbol: "video.slash.fill", help: "Turn the camera off", action: onOff)
                }
                .padding(.bottom, 12)
            }
            .opacity(state.visible ? 1 : 0)
            .allowsHitTesting(state.visible)
            .animation(.easeOut(duration: 0.15), value: state.visible)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct BubbleButton: View {
    let symbol: String
    let help: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                .frame(width: 30, height: 30).background(Circle().fill(Color.black.opacity(0.6)))
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

private let lime = Color(red: 0.82, green: 1, blue: 0.3)
private let ink = Color(red: 0.09, green: 0.11, blue: 0.02)

/// The bubble's look: where it sits, shape, roundness, proportions, size, mirror and rim. Drawn
/// like the other HUDs (the after-capture panel, the pill), with controls of its own: native ones
/// go grey in a panel that's never the active window, as this one never is.
struct BubbleStyleView: View {
    @ObservedObject var model: CaptureModel
    @ObservedObject var spot: BubbleStylePanel.Spot
    var onCorner: (CameraBubble.Corner) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Camera").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                Text("Drag it anywhere, or pick a corner.").font(.system(size: 11)).foregroundStyle(.white.opacity(0.5))
            }
            row("Corner") {
                HStack(spacing: 6) {
                    ForEach(CameraBubble.Corner.allCases, id: \.self) { c in
                        CornerButton(corner: c, on: spot.corner == c) { onCorner(c) }
                    }
                }
            }
            row("Shape") {
                HUDPicker(selection: $model.bubbleShape, items: [(.circle, "Circle"), (.rounded, "Rounded"), (.square, "Square")])
            }
            if model.bubbleShape == .rounded {
                row("Roundness") { HUDSlider(value: $model.bubbleRoundness, range: 0.04...0.5, label: "Roundness") }
            }
            if model.bubbleShape != .circle {
                row("Proportions") {
                    HUDPicker(selection: $model.bubbleAspect, items: [(.square, "1:1"), (.landscape, "4:3"), (.portrait, "3:4")])
                }
            }
            row("Size") { HUDSlider(value: $model.bubbleSize, range: 110...440, label: "Size") }
            Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1)
            Toggle("Mirror", isOn: $model.bubbleMirrored).toggleStyle(HUDSwitch())
            Toggle("White ring", isOn: $model.bubbleBorder).toggleStyle(HUDSwitch())
        }
        .font(.system(size: 12))
        .foregroundStyle(.white.opacity(0.85))
        .padding(14)
        .frame(width: 280)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(red: 0.07, green: 0.07, blue: 0.08).opacity(0.97)))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.white.opacity(0.1)))
        .environment(\.colorScheme, .dark)
    }

    private func row<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 8) {
            Text(title).frame(width: 78, alignment: .leading)
            content().frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 24)
    }
}

/// A small screen with the bubble in one of its corners; lime when that's where the bubble is.
struct CornerButton: View {
    let corner: CameraBubble.Corner
    let on: Bool
    let action: () -> Void
    @State private var hover = false

    private var name: String {
        switch corner {
        case .topLeft: return "top left"
        case .topRight: return "top right"
        case .bottomLeft: return "bottom left"
        case .bottomRight: return "bottom right"
        }
    }

    var body: some View {
        let screen = RoundedRectangle(cornerRadius: 5, style: .continuous)
        let alignment: Alignment = corner == .topLeft ? .topLeading : corner == .topRight ? .topTrailing : corner == .bottomLeft ? .bottomLeading : .bottomTrailing
        Button(action: action) {
            ZStack(alignment: alignment) {
                screen.fill(on ? lime.opacity(0.14) : Color.white.opacity(hover ? 0.1 : 0.05))
                screen.strokeBorder(on ? lime : Color.white.opacity(hover ? 0.45 : 0.22), lineWidth: 1.2)
                Circle().fill(on ? lime : Color.white.opacity(hover ? 0.95 : 0.7)).frame(width: 7, height: 7).padding(4)
            }
            .frame(width: 34, height: 23)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help(on ? "In the \(name) corner" : "Move to the \(name) corner")
        .accessibilityLabel("\(name.prefix(1).uppercased() + name.dropFirst()) corner")
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// Choices in a row, drawn as the capture bar draws its own (the chosen one lit), with words.
struct HUDPicker<T: Hashable>: View {
    @Binding var selection: T
    let items: [(T, String)]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items, id: \.0) { item in
                let on = item.0 == selection
                Button { selection = item.0 } label: {
                    Text(item.1).font(.system(size: 11.5, weight: on ? .semibold : .medium))
                        .foregroundStyle(on ? Color.white : Color.white.opacity(0.55))
                        .frame(maxWidth: .infinity).frame(height: 24)
                        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(on ? Color.white.opacity(0.15) : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(0.05)))
    }
}

/// A slider: a lime track filled up to a white knob. Drag or click anywhere along it.
struct HUDSlider: View {
    @Binding var value: Double
    let range: ClosedRange<Double>
    let label: String
    private let knob: CGFloat = 14

    private var share: Double { min(max((value - range.lowerBound) / (range.upperBound - range.lowerBound), 0), 1) }

    var body: some View {
        GeometryReader { g in
            let x = knob / 2 + CGFloat(share) * (g.size.width - knob)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.14)).frame(height: 4)
                Capsule().fill(lime).frame(width: x, height: 4)
                Circle().fill(Color.white).frame(width: knob, height: knob)
                    .shadow(color: .black.opacity(0.4), radius: 2, y: 1)
                    .offset(x: x - knob / 2)
            }
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { drag in
                let t = min(max((drag.location.x - knob / 2) / max(1, g.size.width - knob), 0), 1)
                value = range.lowerBound + Double(t) * (range.upperBound - range.lowerBound)
            })
        }
        .frame(height: 20)
        .accessibilityElement()
        .accessibilityLabel(label)
        .accessibilityValue("\(Int((share * 100).rounded())) percent")
        .accessibilityAdjustableAction { direction in
            let step = (range.upperBound - range.lowerBound) / 20
            switch direction {
            case .increment: value = min(range.upperBound, value + step)
            case .decrement: value = max(range.lowerBound, value - step)
            @unknown default: break
            }
        }
    }
}

/// An on/off switch with its label before it: lime when on.
struct HUDSwitch: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack {
                configuration.label
                Spacer(minLength: 8)
                ZStack(alignment: configuration.isOn ? .trailing : .leading) {
                    Capsule().fill(configuration.isOn ? lime : Color.white.opacity(0.16))
                    Circle().fill(configuration.isOn ? ink : Color.white).frame(width: 14, height: 14).padding(2)
                        .shadow(color: .black.opacity(0.25), radius: 1, y: 0.5)
                }
                .frame(width: 32, height: 18)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.15), value: configuration.isOn)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(configuration.isOn ? "On" : "Off")
    }
}

/// While recording: a small bar with the time, pause, stop and discard. Screenshotter's own windows
/// are never in the recording, so it can sit anywhere.
@MainActor final class RecordingPill: NSPanel {
    @MainActor final class State: ObservableObject {
        @Published var elapsed: TimeInterval = 0
        @Published var paused = false
        /// Shrunk to a dot and the time, out of the way.
        @Published var small = false
        /// The recording has the camera on (the pill offers to turn it off).
        @Published var camera = false
        /// Discard was pressed once: it asks "Discard?" for a few seconds, and only a second press
        /// throws the recording away (an alert mid-recording would get in the way of what's recorded).
        @Published var confirmingDiscard = false
        private var armedAt: Date?

        /// The first press: ask, and stop asking after a while.
        func askToDiscard() {
            let at = Date()
            armedAt = at
            confirmingDiscard = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                guard let self, self.armedAt == at else { return }
                self.cancelDiscard()
            }
        }

        /// The second press counts only once the question has been up a moment, so a double
        /// click on the bin doesn't answer it for you.
        var discardConfirmable: Bool { confirmingDiscard && (armedAt.map { Date().timeIntervalSince($0) > 0.4 } ?? false) }

        func cancelDiscard() {
            armedAt = nil
            confirmingDiscard = false
        }
    }
    let state = State()
    private var timer: Timer?
    private var started = Date()
    private var pausedTotal: TimeInterval = 0
    private var pausedAt: Date?
    /// Where it was last left (its top centre), for the next recording.
    private static var spot: CGPoint?
    static let fullSize = CGSize(width: 270, height: 48)
    static let fullSizeWithCamera = CGSize(width: 306, height: 48)
    private var full: CGSize { state.camera ? RecordingPill.fullSizeWithCamera : RecordingPill.fullSize }
    static let smallSize = CGSize(width: 86, height: 32)

    init(on screen: NSScreen, camera: Bool, onPause: @escaping () -> Void, onStop: @escaping () -> Void, onDiscard: @escaping () -> Void, onCameraOff: @escaping () -> Void) {
        state.camera = camera
        let full = camera ? RecordingPill.fullSizeWithCamera : RecordingPill.fullSize
        super.init(contentRect: CGRect(origin: .zero, size: full), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .statusBar
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let state = self.state
        contentView = NSHostingView(rootView: RecordingPillView(state: state, onPause: onPause, onStop: onStop, onDiscard: onDiscard,
                                                                onCameraOff: onCameraOff, setSmall: { [weak self] in self?.setSmall($0) }))
        let v = screen.visibleFrame
        var top = CGPoint(x: v.midX, y: v.maxY - 16)
        if let spot = RecordingPill.spot, NSScreen.screens.contains(where: { $0.frame.contains(CGPoint(x: spot.x, y: spot.y - 10)) }) { top = spot }
        setFrame(CGRect(x: top.x - full.width / 2, y: top.y - full.height, width: full.width, height: full.height), display: false)
    }

    /// The camera's gone off: no button for it any more.
    func cameraOff() {
        state.camera = false
        if !state.small { setSmall(false) }
    }

    /// Full or shrunk, keeping its top centre where it is.
    func setSmall(_ small: Bool) {
        let size = small ? RecordingPill.smallSize : full
        let top = CGPoint(x: frame.midX, y: frame.maxY)
        state.cancelDiscard()
        state.small = small
        setFrame(CGRect(x: top.x - size.width / 2, y: top.y - size.height, width: size.width, height: size.height), display: true, animate: false)
        invalidateShadow()
    }

    func begin() {
        started = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        orderFrontRegardless()
    }

    func setPaused(_ paused: Bool) {
        if paused { pausedAt = Date() } else if let at = pausedAt {
            pausedTotal += Date().timeIntervalSince(at)
            pausedAt = nil
        }
        state.paused = paused
    }

    var elapsed: TimeInterval { Date().timeIntervalSince(started) - pausedTotal - (pausedAt.map { Date().timeIntervalSince($0) } ?? 0) }

    private func tick() { state.elapsed = elapsed }

    func end() {
        RecordingPill.spot = CGPoint(x: frame.midX, y: frame.maxY)
        timer?.invalidate()
        timer = nil
        orderOut(nil)
    }
}

struct RecordingPillView: View {
    @ObservedObject var state: RecordingPill.State
    let onPause: () -> Void
    let onStop: () -> Void
    let onDiscard: () -> Void
    var onCameraOff: () -> Void = {}
    let setSmall: (Bool) -> Void

    var body: some View {
        Group {
            if state.small {
                // The dot and the time: drag it anywhere, click it for the controls again.
                ZStack {
                    HStack(spacing: 7) {
                        dot
                        Text(clock(state.elapsed)).font(.system(size: 12, weight: .semibold).monospacedDigit()).foregroundStyle(.white)
                    }
                    WindowGrip(onClick: { setSmall(false) })
                }
                .help("Click for the recording controls · drag to move")
                .frame(width: RecordingPill.smallSize.width, height: RecordingPill.smallSize.height)
                .background(Capsule().fill(Color(white: 0.09).opacity(0.94)))
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.1)))
            } else {
                HStack(spacing: 0) {
                    HStack(spacing: 6) {
                        // The grip: drag the pill anywhere.
                        ZStack {
                            Image(systemName: "line.3.horizontal").font(.system(size: 11, weight: .bold)).foregroundStyle(.white.opacity(0.35)).rotationEffect(.degrees(90))
                            WindowGrip()
                        }
                        .frame(width: 14, height: 30)
                        .help("Drag to move")
                        dot
                        Text(clock(state.elapsed)).font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(.white)
                            .frame(width: 46, alignment: .leading)
                    }
                    Spacer(minLength: 4)
                    HStack(spacing: 6) {
                        PillButton(symbol: state.paused ? "play.fill" : "pause.fill", help: state.paused ? "Resume" : "Pause", action: onPause)
                        PillButton(symbol: "stop.fill", help: "Stop", tint: .red, action: onStop)
                    }
                    // Discard sits at the far end, past a line and the camera and shrink buttons,
                    // so reaching for Stop can't land on it; asking, it takes their room.
                    line
                    if !state.confirmingDiscard {
                        HStack(spacing: 6) {
                            if state.camera { PillButton(symbol: "video.slash.fill", help: "Turn the camera off (your voice carries on)", action: onCameraOff) }
                            PillButton(symbol: "minus", help: "Shrink to a dot", action: { setSmall(true) })
                        }
                        line
                    }
                    DiscardButton(asking: state.confirmingDiscard) {
                        if !state.confirmingDiscard { state.askToDiscard() } else if state.discardConfirmable {
                            state.cancelDiscard()
                            onDiscard()
                        }
                    }
                }
                .animation(.easeOut(duration: 0.15), value: state.confirmingDiscard)
                .padding(.leading, 8)
                .padding(.trailing, 9)
                .frame(width: state.camera ? RecordingPill.fullSizeWithCamera.width : RecordingPill.fullSize.width, height: RecordingPill.fullSize.height)
                .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Color(white: 0.09).opacity(0.94)))
                .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Color.white.opacity(0.1)))
            }
        }
    }

    private var dot: some View {
        Circle().fill(state.paused ? Color.orange : Color.red).frame(width: 9, height: 9)
            .opacity(state.paused ? 1 : (Int(state.elapsed * 2) % 2 == 0 ? 1 : 0.35))
    }

    private var line: some View { Rectangle().fill(Color.white.opacity(0.12)).frame(width: 1, height: 18).padding(.horizontal, 8) }

    private func clock(_ t: TimeInterval) -> String {
        let s = max(0, Int(t))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// Moves its window when dragged; a click that doesn't move it calls `onClick`, a drag that does `onMoved`.
struct WindowGrip: NSViewRepresentable {
    var onClick: (() -> Void)?
    var onRightClick: (() -> Void)?
    var onMoved: (() -> Void)?
    func makeNSView(context: Context) -> GripView { GripView() }
    func updateNSView(_ view: GripView, context: Context) {
        view.onClick = onClick
        view.onRightClick = onRightClick
        view.onMoved = onMoved
    }

    final class GripView: NSView {
        var onClick: (() -> Void)?
        var onRightClick: (() -> Void)?
        var onMoved: (() -> Void)?
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func rightMouseDown(with event: NSEvent) { onRightClick?() }
        override func mouseDown(with event: NSEvent) {
            let before = window?.frame.origin
            window?.performDrag(with: event)
            if window?.frame.origin == before { onClick?() } else { onMoved?() }
        }
        override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    }
}

struct PillButton: View {
    let symbol: String
    let help: String
    var tint: Color = .white
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 12, weight: .bold)).foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Color.white.opacity(hover ? 0.16 : 0.08)))
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
        .onHover { hover = $0 }
    }
}

/// The bin, which asks first: pressed once it widens (from its right edge, so it's still under
/// the pointer) into a red "Discard?", and a second press throws the recording away.
struct DiscardButton: View {
    let asking: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Group {
                if asking {
                    Text("Discard?").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 12).frame(height: 30)
                        .background(Capsule().fill(Color(red: 0.86, green: 0.2, blue: 0.19).opacity(hover ? 1 : 0.9)))
                } else {
                    Image(systemName: "trash").font(.system(size: 12, weight: .bold))
                        .foregroundStyle(hover ? Color(red: 1, green: 0.45, blue: 0.42) : .white)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(Color.white.opacity(hover ? 0.16 : 0.08)))
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .help(asking ? "Click again to throw this recording away" : "Discard this recording")
        .accessibilityLabel(asking ? "Confirm discarding this recording" : "Discard this recording")
        .onHover { hover = $0 }
    }
}

/// 3, 2, 1 in the middle of what's about to be recorded. A click or Esc calls it off.
@MainActor final class Countdown: NSPanel {
    final class State: ObservableObject {
        @Published var count = 3
        /// How much of the countdown has run, 0 to 1 (the ring fills with it).
        @Published var done: Double = 0
    }
    private let state = State()
    private let sound: Bool
    private var timer: Timer?
    private var finished: ((Bool) -> Void)?

    /// Over the middle of what's about to be recorded. `sound`: a tick for each number.
    init(over region: CGRect, sound: Bool = true) {
        self.sound = sound
        let size = CGSize(width: 260, height: 250)
        super.init(contentRect: CGRect(x: region.midX - size.width / 2, y: region.midY - size.height / 2, width: size.width, height: size.height),
                   styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .screenSaver
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let host = FirstClickHostingView(rootView: CountdownView(state: state))
        host.frame = CGRect(origin: .zero, size: size)
        contentView = host
    }

    override var canBecomeKey: Bool { true }

    func run(_ done: @escaping (Bool) -> Void) {
        finished = done
        makeKeyAndOrderFront(nil)
        tick()
        // The ring fills over the three seconds; the number steps down each second.
        let started = CACurrentMediaTime()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let t = CACurrentMediaTime() - started
                if t >= 3 { return self.finish(true) }
                self.state.done = t / 3
                let count = 3 - Int(t)
                if count != self.state.count {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { self.state.count = count }
                    self.tick()
                }
            }
        }
        RunLoop.main.add(timer!, forMode: .common)
    }

    /// A tick for each number (before the recording starts, so it's never in it).
    private func tick() {
        guard sound else { return }
        let s = NSSound(named: "Tink")
        s?.volume = 0.6
        s?.play()
    }

    override func mouseDown(with event: NSEvent) { finish(false) }
    override func cancelOperation(_ sender: Any?) { finish(false) }
    /// Called off from outside: the recording was stopped or thrown away while it ran.
    func cancel() { finish(false) }

    private func finish(_ go: Bool) {
        timer?.invalidate()
        timer = nil
        orderOut(nil)
        let d = finished
        finished = nil
        d?(go)
    }
}

/// The countdown: what's coming, the number in a ring that fills as it runs out, and how to call it off.
struct CountdownView: View {
    @ObservedObject var state: Countdown.State

    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 7) {
                Circle().fill(Color.red).frame(width: 9, height: 9)
                Text("Recording starts in").font(.system(size: 14, weight: .semibold)).foregroundStyle(.white.opacity(0.9))
            }
            ZStack {
                Circle().stroke(Color.white.opacity(0.14), lineWidth: 7)
                Circle().trim(from: 0, to: state.done)
                    .stroke(Color(red: 0.82, green: 1, blue: 0.3), style: StrokeStyle(lineWidth: 7, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(state.count)")
                    .font(.system(size: 66, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(.white)
                    .contentTransition(.numericText(countsDown: true))
            }
            .frame(width: 124, height: 124)
            Text("Click or press Esc to cancel").font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
        }
        .frame(width: 260, height: 250)
        .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Color(white: 0.07).opacity(0.9)))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Color.white.opacity(0.1)))
    }
}
