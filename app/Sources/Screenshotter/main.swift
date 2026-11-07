import AppKit
import AVFoundation

MainActor.assumeIsolated {
    let args = CommandLine.arguments
    // `mcp`: become the engine's MCP server (on stdin/stdout, with the Node the app carries), so an
    // agent needs one command: `claude mcp add screenshotter -- /Applications/Screenshotter.app/Contents/MacOS/Screenshotter mcp`
    if args.count > 1, args[1] == "mcp" {
        let contents = Bundle.main.bundleURL.appendingPathComponent("Contents")
        let node = contents.appendingPathComponent("Helpers/node").path
        let server = contents.appendingPathComponent("Resources/engine/dist/index.js").path
        var argv: [UnsafeMutablePointer<CChar>?] = ([node, server] + args.dropFirst(2)).map { strdup($0) } + [nil]
        execv(node, &argv)
        FileHandle.standardError.write(Data("Screenshotter couldn't start its MCP server: \(node): \(String(cString: strerror(errno)))\n".utf8))
        exit(1)
    }
    // `--ui-snapshots <folder> [sample.png]`: draw the capture UI to PNGs and quit.
    if let i = args.firstIndex(of: "--ui-snapshots"), i + 1 < args.count {
        _ = NSApplication.shared
        UISnapshots.render(to: URL(fileURLWithPath: args[i + 1]), sample: i + 2 < args.count ? URL(fileURLWithPath: args[i + 2]) : nil)
        exit(0)
    }
    // `--finish-test <screen.mp4> <camera.mov> <out.mp4>`: put a recording together (camera bubble,
    // sounds mixed) without recording anything, to check the result.
    if let i = args.firstIndex(of: "--finish-test"), i + 3 < args.count {
        // SCREENSHOTTER_FINISH_BUBBLE: the bubble as JSON (a BubblePlacement), to try other looks.
        let bubble = ProcessInfo.processInfo.environment["SCREENSHOTTER_FINISH_BUBBLE"].flatMap { try? JSONDecoder().decode(BubblePlacement.self, from: Data($0.utf8)) }
        let parts = RecordingParts(screen: args[i + 1], camera: args[i + 2], cameraOffset: 0.4,
                                   bubble: bubble ?? BubblePlacement(x: 0.12, y: 0.82, diameter: 0.26), systemAudio: true, microphone: true)
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            do {
                try await Finisher.finish(screen: URL(fileURLWithPath: args[i + 1]), camera: URL(fileURLWithPath: args[i + 2]), parts: parts, to: URL(fileURLWithPath: args[i + 3]))
                print("finished")
            } catch { print("failed: \(error)") }
            done.signal()
        }
        while done.wait(timeout: .now()) == .timedOut { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        exit(0)
    }
    // `--sync-test <folder>`: check a recording's sound keeps time with its picture through gaps.
    if let i = args.firstIndex(of: "--sync-test"), i + 1 < args.count {
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var ok = false
        Task.detached {
            ok = await SyncTest.run(in: URL(fileURLWithPath: args[i + 1]))
            done.signal()
        }
        while done.wait(timeout: .now()) == .timedOut { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        exit(ok ? 0 : 1)
    }
    // `--render-recording <spec.json>`: draw a recording's video for the engine's export (on the GPU).
    if let i = args.firstIndex(of: "--render-recording"), i + 1 < args.count {
        exit(RecordingRenderer.run(URL(fileURLWithPath: args[i + 1])))
    }
    // `--edit-test <parts folder> <out folder>`: get a recording's parts ready to edit (its sounds
    // mixed, the camera as a clip) as stopping does, and print what the Studio is given.
    if let i = args.firstIndex(of: "--edit-test"), i + 2 < args.count {
        let partsDir = URL(fileURLWithPath: args[i + 1])
        let out = URL(fileURLWithPath: args[i + 2])
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            do {
                let parts = try JSONDecoder().decode(RecordingParts.self, from: Data(contentsOf: partsDir.appendingPathComponent("parts.json")))
                let camera = parts.camera.map { partsDir.appendingPathComponent($0) }
                let video = out.appendingPathComponent("recording.mp4")
                let t0 = Date()
                try await Finisher.editable(screen: partsDir.appendingPathComponent(parts.screen), camera: camera, parts: parts, to: video)
                let t1 = Date()
                let duration = try await AVURLAsset(url: video).load(.duration).seconds
                var ends = 0.0
                if let camera { ends = try await Finisher.cameraClip(camera: camera, parts: parts, length: CMTime(seconds: duration, preferredTimescale: 600), to: out.appendingPathComponent("camera-edit.mp4")) }
                print(String(format: "editable %.1fs, camera clip %.1fs; duration %.2f, camera ends %.2f", t1.timeIntervalSince(t0), Date().timeIntervalSince(t1), duration, ends))
            } catch { print("failed: \(error)") }
            done.signal()
        }
        while done.wait(timeout: .now()) == .timedOut { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        exit(0)
    }
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    withExtendedLifetime(delegate) { app.run() }
}
