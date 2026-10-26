import AppKit
import SwiftUI

/// After a capture: its thumbnail in the corner of the screen, already saved to Screenshotter's
/// library, with Edit in Screenshotter, Copy, Save to…, Show in Finder and Delete, and a close
/// button. It goes away on its own after a while unless the pointer is over it. Drag the
/// thumbnail anywhere a file goes.
@MainActor final class CaptureHUD: NSPanel {
    final class State: ObservableObject {
        @Published var image: NSImage?
        @Published var title = "Saving…"
        @Published var detail = ""
        @Published var file: URL?
        @Published var working = true
        @Published var isVideo = false
        @Published var failed = false
    }
    struct Actions {
        var edit: (URL) -> Void
        var copy: (URL) -> Void
        var saveAs: (URL) -> Void
        var reveal: (URL) -> Void
        var delete: (URL) -> Void
    }

    let state = State()
    /// The screen whose corner it sits in.
    private let home: NSScreen
    private var hideTimer: Timer?
    private var hovering = false
    /// Closed with its ×: a save that finishes afterwards doesn't bring it back.
    private var closed = false

    init(on screen: NSScreen, actions: Actions) {
        home = screen
        super.init(contentRect: CGRect(x: 0, y: 0, width: 300, height: 260), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .floating
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        var a = actions
        let close: () -> Void = { [weak self] in
            self?.closed = true
            self?.dismiss()
        }
        // Editing or deleting it is the end of the panel.
        let edit = actions.edit
        let delete = actions.delete
        a.edit = { edit($0); close() }
        a.delete = { delete($0); close() }
        // The window follows its content's size as that changes (saving, then the capture and
        // its buttons, or a failure): measured as drawn, since a size asked for straight after a
        // change is the one before it.
        let view = CaptureHUDView(state: state, actions: a, close: close, hover: { [weak self] in self?.setHover($0) })
            .background(GeometryReader { Color.clear.preference(key: ContentSize.self, value: $0.size) })
            .onPreferenceChange(ContentSize.self) { [weak self] size in DispatchQueue.main.async { self?.fit(size) } }
        let host = NSHostingView(rootView: view)
        host.sizingOptions = [.intrinsicContentSize]
        contentView = host
        fit(host.fittingSize)
    }

    /// Its content's size, in the bottom-right corner of its screen (growing upwards).
    private func fit(_ size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        let v = home.visibleFrame
        let frame = CGRect(x: v.maxX - size.width - 20, y: v.minY + 20, width: size.width, height: size.height)
        guard frame != self.frame else { return }
        setFrame(frame, display: true)
        invalidateShadow()
    }

    func show(saving title: String) {
        state.title = title
        state.working = true
        state.failed = false
        orderFrontRegardless()
    }

    func ready(file: URL, image: NSImage?, title: String, detail: String, isVideo: Bool) {
        state.file = file
        state.image = image
        state.title = title
        state.detail = detail
        state.isVideo = isVideo
        state.working = false
        state.failed = false
        guard !closed else { return }
        // Shown once it has drawn the capture, at the size that takes.
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.closed else { return }
            if let size = self.contentView?.fittingSize { self.fit(size) }
            self.orderFrontRegardless()
            self.scheduleHide()
        }
    }

    func failed(_ message: String) {
        state.working = false
        state.failed = true
        state.title = "Couldn't save it"
        state.detail = message
        scheduleHide(after: 8)
    }

    private func setHover(_ on: Bool) {
        hovering = on
        if on { hideTimer?.invalidate() } else { scheduleHide(after: 4) }
    }

    private func scheduleHide(after seconds: TimeInterval = 9) {
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.hovering else { return }
                self.dismiss()
            }
        }
    }

    func dismiss() {
        hideTimer?.invalidate()
        orderOut(nil)
    }
}

private struct ContentSize: PreferenceKey {
    static var defaultValue: CGSize { .zero }
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

private let lime = Color(red: 0.82, green: 1, blue: 0.3)
private let ink = Color(red: 0.09, green: 0.11, blue: 0.02)

/// What was captured and where it went, with a close button; the capture; then Edit and the
/// smaller things to do with it, as icons.
struct CaptureHUDView: View {
    @ObservedObject var state: CaptureHUD.State
    let actions: CaptureHUD.Actions
    let close: () -> Void
    let hover: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if state.image != nil { thumb }
            if let file = state.file, !state.working, !state.failed {
                HStack(spacing: 6) {
                    Button { actions.edit(file) } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "wand.and.stars").font(.system(size: 11.5, weight: .semibold))
                            Text("Edit").font(.system(size: 12.5, weight: .semibold))
                        }
                        .foregroundStyle(ink)
                        .frame(maxWidth: .infinity).frame(height: 30)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(lime))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help("Edit in Screenshotter")
                    HUDButton(symbol: "doc.on.doc", title: "Copy", done: "Copied") { actions.copy(file) }
                    HUDButton(symbol: "square.and.arrow.down", title: "Save to…") { actions.saveAs(file) }
                    HUDButton(symbol: "folder", title: "Show in Finder") { actions.reveal(file) }
                    HUDButton(symbol: "trash", title: "Delete", danger: true) { actions.delete(file) }
                }
            }
        }
        .padding(12)
        .frame(width: 300)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(red: 0.07, green: 0.07, blue: 0.08).opacity(0.97)))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.white.opacity(0.1)))
        .onHover(perform: hover)
        .environment(\.colorScheme, .dark)
        .fixedSize()
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            if state.working {
                ProgressView().controlSize(.small).frame(width: 14, height: 14).padding(.top, 1)
            } else if state.failed {
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 12)).foregroundStyle(Color(red: 1, green: 0.62, blue: 0.25)).padding(.top, 2)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(state.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                if !state.detail.isEmpty {
                    Text(state.detail).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5))
                        .lineLimit(state.failed ? 3 : 1)
                }
            }
            Spacer(minLength: 4)
            CloseButton(action: close)
        }
    }

    @ViewBuilder private var thumb: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        ZStack {
            shape.fill(Color.white.opacity(0.05))
            if let image = state.image {
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fit).clipShape(shape)
                if state.isVideo {
                    Image(systemName: "play.fill").font(.system(size: 13)).foregroundStyle(.white)
                        .frame(width: 34, height: 34).background(Circle().fill(Color.black.opacity(0.5)))
                }
            }
        }
        .frame(width: 276, height: 156)
        .onDrag { state.file.map { NSItemProvider(contentsOf: $0) ?? NSItemProvider() } ?? NSItemProvider() }
        .help("Drag it into Finder, Slack, Figma…")
    }
}

/// Closes the panel there and then.
private struct CloseButton: View {
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.system(size: 9.5, weight: .bold)).foregroundStyle(.white.opacity(hover ? 1 : 0.7))
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.white.opacity(hover ? 0.18 : 0.09)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help("Close")
        .accessibilityLabel("Close")
    }
}

/// One of the smaller actions, as an icon with its name in the tooltip. With `done`, it shows a
/// tick for a moment once pressed (Copy has nothing else to show it worked).
struct HUDButton: View {
    let symbol: String
    let title: String
    var done: String?
    var danger = false
    let action: () -> Void
    @State private var hover = false
    @State private var didIt = false

    var body: some View {
        Button {
            action()
            guard done != nil else { return }
            didIt = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { didIt = false }
        } label: {
            Image(systemName: didIt ? "checkmark" : symbol).font(.system(size: 12, weight: .semibold))
                .foregroundStyle(didIt ? lime : danger && hover ? Color(red: 1, green: 0.45, blue: 0.42) : .white.opacity(hover ? 1 : 0.8))
                .frame(width: 30, height: 30)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(hover ? 0.13 : 0.06)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help(didIt ? done ?? title : title)
        .accessibilityLabel(title)
    }
}
