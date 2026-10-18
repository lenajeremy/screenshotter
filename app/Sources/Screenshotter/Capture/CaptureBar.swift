import AppKit
import SwiftUI

/// The capture bar: what opening Screenshotter shows first. A floating bar on the screen you're
/// using, like ⌘⇧5: a screenshot or a recording, of an area, a window or the whole screen, with
/// the camera and microphone for recordings, and a way into Screenshotter itself.
@MainActor final class CaptureBarPanel: NSPanel {
    private let onEscape: () -> Void

    init(model: CaptureModel, actions: CaptureBarActions) {
        onEscape = actions.close
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .floating
        isFloatingPanel = true
        hidesOnDeactivate = false
        isMovableByWindowBackground = true
        becomesKeyOnlyIfNeeded = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let host = NSHostingView(rootView: CaptureBarView(model: model, actions: actions))
        host.sizingOptions = [.intrinsicContentSize]
        contentView = host
    }

    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { onEscape() }

    /// Shows the bar near the bottom of the screen the pointer is on.
    func present() {
        contentView?.layoutSubtreeIfNeeded()
        let size = contentView?.fittingSize ?? CGSize(width: 760, height: 64)
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main ?? NSScreen.screens[0]
        let v = screen.visibleFrame
        setFrame(CGRect(x: v.midX - size.width / 2, y: v.minY + 64, width: size.width, height: size.height), display: true)
        makeKeyAndOrderFront(nil)
        orderFrontRegardless()
    }

    /// Keeps it centred when it grows or shrinks (the recording options come and go).
    func recentre() {
        guard isVisible, let size = contentView?.fittingSize else { return }
        let center = frame.midX
        setFrame(CGRect(x: center - size.width / 2, y: frame.minY, width: size.width, height: size.height), display: true)
    }
}

struct CaptureBarActions {
    var capture: () -> Void
    var openStudio: () -> Void
    var close: () -> Void
    var resized: () -> Void
    var chooseFolder: () -> Void
}

private let lime = Color(red: 0.82, green: 1, blue: 0.3)
private let ink = Color(red: 0.09, green: 0.11, blue: 0.02)

/// Icons, not words: each says what it is when you point at it. The camera and microphone pick
/// from a small menu; the options (⋯) come last.
struct CaptureBarView: View {
    @ObservedObject var model: CaptureModel
    let actions: CaptureBarActions

    private var line: some View { Rectangle().fill(Color.white.opacity(0.1)).frame(width: 1, height: 20) }

    var body: some View {
        HStack(spacing: 6) {
            IconButton(symbol: "xmark", help: "Close (Esc)", action: actions.close)
            line
            Segmented(selection: $model.mode, items: [(.screenshot, "camera.viewfinder", "Screenshot"), (.record, "record.circle", "Record")])
            line
            Segmented(selection: $model.target, items: [(.area, "rectangle.dashed", "An area"), (.window, "macwindow", "A window"), (.screen, "display", "The whole screen")])
            if model.mode == .record {
                line
                DeviceMenu(
                    on: $model.cameraOn, onSymbol: "video.fill", offSymbol: "video.slash.fill",
                    help: model.cameraOn ? "Camera: \(model.cameraName)" : "Camera off", devices: model.cameras, selected: $model.cameraID,
                    offTitle: "No camera", empty: "No camera connected")
                DeviceMenu(
                    on: Binding(get: { model.micOn && model.micAvailable }, set: { model.micOn = $0 }), onSymbol: "mic.fill", offSymbol: "mic.slash.fill",
                    help: model.micOn && model.micAvailable ? "Microphone: \(model.micName)" : "Microphone off", devices: model.micAvailable ? model.mics : [], selected: $model.micID,
                    offTitle: "No microphone", empty: model.mics.isEmpty ? "No microphone connected" : "Needs the camera on, or macOS 15")
                ToggleChip(on: $model.systemAudio, onSymbol: "speaker.wave.2.fill", offSymbol: "speaker.slash.fill", help: model.systemAudio ? "Recording the Mac's sound" : "Not recording the Mac's sound")
                if model.afterRecording == .edit {
                    ToggleChip(on: $model.cursorEffects, onSymbol: "cursorarrow.motionlines", offSymbol: "cursorarrow",
                               help: model.cursorEffects ? "Cursor effects on: a smooth cursor, click ripples and auto zoom to edit afterwards" : "Cursor effects off: the cursor is recorded as it is")
                }
            }
            line
            SaveToMenu(model: model, chooseFolder: actions.chooseFolder)
            Button(action: actions.openStudio) {
                Image(systemName: "arrow.up.forward.app").font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.8))
                    .frame(width: 32, height: 32)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(0.06)))
            }
            .buttonStyle(.plain)
            .help("Open Screenshotter, to design with your captures")
            .accessibilityLabel("Open Screenshotter")
            Button(action: actions.capture) {
                Group {
                    if model.mode == .record {
                        Circle().fill(Color(red: 0.95, green: 0.2, blue: 0.2)).frame(width: 13, height: 13)
                            .overlay(Circle().strokeBorder(ink.opacity(0.25), lineWidth: 1))
                    } else {
                        Image(systemName: "camera.fill").font(.system(size: 14, weight: .semibold)).foregroundStyle(ink)
                    }
                }
                .frame(width: 48, height: 32)
                .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(lime))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.defaultAction)
            .disabled(model.busy)
            .opacity(model.busy ? 0.5 : 1)
            .help(model.mode == .record ? "Start recording (↩)" : "Take the screenshot (↩)")
            .accessibilityLabel(model.mode == .record ? "Record" : "Capture")
            Menu {
                Toggle("Count down from 3", isOn: $model.countdown)
                Toggle("Countdown sound", isOn: $model.countdownSound).disabled(!model.countdown)
                Picker("After recording", selection: $model.afterRecording) {
                    Text("Open in Screenshotter to edit").tag(CaptureModel.AfterRecording.edit)
                    Text("Save the video right away").tag(CaptureModel.AfterRecording.save)
                }
                Divider()
                Button("Refresh cameras and microphones") { model.refreshDevices() }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 13, weight: .bold)).foregroundStyle(.white.opacity(0.8)).frame(width: 24, height: 32)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Options")
        }
        .padding(.horizontal, 8)
        .frame(height: 46)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(red: 0.07, green: 0.07, blue: 0.08).opacity(0.96)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.white.opacity(0.1)))
        .fixedSize()
        .onChange(of: model.mode) { _, _ in DispatchQueue.main.async { actions.resized() } }
        .onChange(of: model.cameraOn) { _, _ in DispatchQueue.main.async { actions.resized() } }
        .onChange(of: model.micOn) { _, _ in DispatchQueue.main.async { actions.resized() } }
        .onChange(of: model.afterRecording) { _, _ in DispatchQueue.main.async { actions.resized() } }
        .environment(\.colorScheme, .dark)
    }
}

/// A row of icon choices, one of them on; each names itself when pointed at.
struct Segmented<T: Hashable>: View {
    @Binding var selection: T
    let items: [(T, String, String)]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items, id: \.0) { item in
                let on = item.0 == selection
                Button { selection = item.0 } label: {
                    Image(systemName: item.1).font(.system(size: 15, weight: .medium))
                        .foregroundStyle(on ? Color.white : Color.white.opacity(0.5))
                        .frame(width: 36, height: 32)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(on ? Color.white.opacity(0.15) : .clear))
                }
                .buttonStyle(.plain)
                .help(item.2)
                .accessibilityLabel(item.2)
            }
        }
    }
}

/// Where this kind of capture goes: Screenshotter's library, the Desktop, the clipboard
/// (screenshots), or a folder of your choosing. Screenshots and recordings each remember theirs.
struct SaveToMenu: View {
    @ObservedObject var model: CaptureModel
    let chooseFolder: () -> Void

    private var symbol: String {
        switch model.destination {
        case .library: return "square.stack"
        case .desktop: return "menubar.dock.rectangle"
        case .clipboard: return "doc.on.clipboard"
        case .folder: return "folder"
        }
    }

    var body: some View {
        Menu {
            Section(model.mode == .screenshot ? "Save screenshots to" : "Save recordings to") {
                choice("Screenshotter Library", "square.stack", .library)
                choice("Desktop", "menubar.dock.rectangle", .desktop)
                if model.mode == .screenshot { choice("Clipboard", "doc.on.clipboard", .clipboard) }
                if !model.folder.isEmpty { choice(URL(fileURLWithPath: model.folder).lastPathComponent, "folder", .folder) }
            }
            Divider()
            Button("Choose Folder…", action: chooseFolder)
        } label: {
            ChevronIcon(symbol: symbol, tint: .white.opacity(0.8), lit: false)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("\(model.mode == .screenshot ? "Screenshots" : "Recordings") go to: \(model.destinationName)")
        .accessibilityLabel("Save to \(model.destinationName)")
    }

    private func choice(_ title: String, _ icon: String, _ d: CaptureModel.Destination) -> some View {
        Button { model.destination = d } label: {
            if model.destination == d { Label(title, systemImage: "checkmark") } else { Label(title, systemImage: icon) }
        }
    }
}

/// An icon with a small arrow beside it: a button that opens a menu.
private struct ChevronIcon: View {
    let symbol: String
    let tint: Color
    let lit: Bool

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: 13, weight: .semibold)).foregroundStyle(tint)
            Image(systemName: "chevron.down").font(.system(size: 7, weight: .bold)).foregroundStyle(.white.opacity(0.4))
        }
        .padding(.horizontal, 8).frame(height: 32)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(lit ? 0.1 : 0.05)))
    }
}

/// A camera or microphone: off, or one of the connected ones. Its name shows when pointed at.
struct DeviceMenu: View {
    @Binding var on: Bool
    let onSymbol: String
    let offSymbol: String
    let help: String
    let devices: [CaptureModel.Device]
    @Binding var selected: String
    let offTitle: String
    let empty: String

    var body: some View {
        Menu {
            Button { on = false } label: { Label(offTitle, systemImage: offSymbol) }
            if devices.isEmpty { Text(empty) }
            ForEach(devices) { d in
                Button {
                    selected = d.id
                    on = true
                } label: {
                    if on && d.id == selected { Label(d.name, systemImage: "checkmark") } else { Text(d.name) }
                }
            }
        } label: {
            ChevronIcon(symbol: on ? onSymbol : offSymbol, tint: on ? lime : Color.white.opacity(0.5), lit: on)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(help)
        .accessibilityLabel(help)
    }
}

struct ToggleChip: View {
    @Binding var on: Bool
    let onSymbol: String
    let offSymbol: String
    let help: String

    var body: some View {
        Button { on.toggle() } label: {
            Image(systemName: on ? onSymbol : offSymbol).font(.system(size: 13, weight: .semibold))
                .foregroundStyle(on ? lime : Color.white.opacity(0.5))
                .frame(width: 32, height: 32)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(on ? 0.1 : 0.05)))
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
    }
}

struct IconButton: View {
    let symbol: String
    let help: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.7))
                .frame(width: 24, height: 24)
                .background(Circle().fill(Color.white.opacity(hover ? 0.14 : 0.06)))
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
        .onHover { hover = $0 }
    }
}
