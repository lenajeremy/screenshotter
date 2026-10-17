import AppKit
import SwiftUI

/// After a capture: its thumbnail in the corner of the screen, already saved to Screenshotter's
/// library, with Edit in Screenshotter, Copy, Save to…, Show in Finder and Delete. It goes away
/// on its own after a while unless the pointer is over it. Drag the thumbnail anywhere a file goes.
@MainActor final class CaptureHUD: NSPanel {
    final class State: ObservableObject {
        @Published var image: NSImage?
        @Published var title = "Saving…"
        @Published var detail = ""
        @Published var file: URL?
        @Published var working = true
        @Published var isVideo = false
    }
    struct Actions {
        var edit: (URL) -> Void
        var copy: (URL) -> Void
        var saveAs: (URL) -> Void
        var reveal: (URL) -> Void
        var delete: (URL) -> Void
    }

    let state = State()
    private var hideTimer: Timer?
    private var hovering = false

    init(on screen: NSScreen, actions: Actions) {
        super.init(contentRect: CGRect(x: 0, y: 0, width: 300, height: 260), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .floating
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        var a = actions
        let close: () -> Void = { [weak self] in self?.dismiss() }
        // Editing or deleting it is the end of the panel.
        let edit = actions.edit
        let delete = actions.delete
        a.edit = { edit($0); close() }
        a.delete = { delete($0); close() }
        let host = NSHostingView(rootView: CaptureHUDView(state: state, actions: a, close: close, hover: { [weak self] in self?.setHover($0) }))
        host.sizingOptions = [.intrinsicContentSize]
        contentView = host
        place(on: screen)
    }

    private func place(on screen: NSScreen) {
        let size = contentView?.fittingSize ?? CGSize(width: 300, height: 260)
        let v = screen.visibleFrame
        setFrame(CGRect(x: v.maxX - size.width - 20, y: v.minY + 20, width: size.width, height: size.height), display: true)
    }

    func show(saving title: String) {
        state.title = title
        state.working = true
        orderFrontRegardless()
    }

    func ready(file: URL, image: NSImage?, title: String, detail: String, isVideo: Bool) {
        state.file = file
        state.image = image
        state.title = title
        state.detail = detail
        state.isVideo = isVideo
        state.working = false
        if let screen { place(on: screen) }
        orderFrontRegardless()
        scheduleHide()
    }

    func failed(_ message: String) {
        state.working = false
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

private let lime = Color(red: 0.82, green: 1, blue: 0.3)

struct CaptureHUDView: View {
    @ObservedObject var state: CaptureHUD.State
    let actions: CaptureHUD.Actions
    let close: () -> Void
    let hover: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topTrailing) {
                thumb
                Button(action: close) {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 20, height: 20).background(Circle().fill(Color.black.opacity(0.55)))
                }
                .buttonStyle(.plain).padding(6).help("Close")
            }
            HStack(spacing: 6) {
                if state.working { ProgressView().controlSize(.small) } else { Image(systemName: "checkmark.circle.fill").foregroundStyle(lime) }
                VStack(alignment: .leading, spacing: 1) {
                    Text(state.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white)
                    if !state.detail.isEmpty { Text(state.detail).font(.system(size: 11)).foregroundStyle(.white.opacity(0.55)).lineLimit(2) }
                }
            }
            if let file = state.file, !state.working {
                Button { actions.edit(file) } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "wand.and.stars").font(.system(size: 12, weight: .semibold))
                        Text("Edit in Screenshotter").font(.system(size: 12.5, weight: .bold))
                    }
                    .foregroundStyle(Color(red: 0.09, green: 0.11, blue: 0.02))
                    .frame(maxWidth: .infinity).frame(height: 32)
                    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(lime))
                }
                .buttonStyle(.plain)
                HStack(spacing: 6) {
                    HUDButton(symbol: "doc.on.doc", title: "Copy") { actions.copy(file) }
                    HUDButton(symbol: "square.and.arrow.down", title: "Save to…") { actions.saveAs(file) }
                    HUDButton(symbol: "folder", title: "Show") { actions.reveal(file) }
                    HUDButton(symbol: "trash", title: "Delete", tint: Color(red: 1, green: 0.45, blue: 0.42)) { actions.delete(file) }
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

    @ViewBuilder private var thumb: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        ZStack {
            shape.fill(Color.white.opacity(0.05))
            if let image = state.image {
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fit).clipShape(shape)
                if state.isVideo {
                    Image(systemName: "play.fill").font(.system(size: 18)).foregroundStyle(.white)
                        .frame(width: 44, height: 44).background(Circle().fill(Color.black.opacity(0.5)))
                }
            } else if state.working {
                ProgressView()
            }
        }
        .frame(width: 276, height: 156)
        .onDrag { state.file.map { NSItemProvider(contentsOf: $0) ?? NSItemProvider() } ?? NSItemProvider() }
        .help("Drag it into Finder, Slack, Figma…")
    }
}

struct HUDButton: View {
    let symbol: String
    let title: String
    var tint: Color = .white
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: symbol).font(.system(size: 12, weight: .semibold))
                Text(title).font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(tint.opacity(0.9))
            .frame(maxWidth: .infinity).frame(height: 42)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(hover ? 0.12 : 0.06)))
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}
