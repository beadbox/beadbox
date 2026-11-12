// Native smoke-only activation: no Apple Events or unattended consent prompts.
import AppKit
import CoreGraphics

func windows() -> [[String: Any]] {
    return CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
}

func diagnose() {
    if let app = NSWorkspace.shared.frontmostApplication {
        print("frontmost: \(app.localizedName ?? "unknown") (pid \(app.processIdentifier))")
    } else {
        print("frontmost: unavailable (no active GUI session?)")
    }
    print("display asleep: \(CGDisplayIsAsleep(CGMainDisplayID()) != 0)")
    for window in windows() {
        print("window: \(window)")
    }
}

let args = CommandLine.arguments
if args.count == 2 && args[1] == "diagnose" {
    diagnose()
} else if args.count == 3 && args[1] == "front", let pid = Int32(args[2]), pid > 0 {
    guard let app = NSRunningApplication(processIdentifier: pid) else {
        print("window not visible: launched PID \(pid) no longer exists")
        exit(1)
    }
    app.unhide()
    _ = app.activate(options: [.activateAllWindows])
    let deadline = Date().addingTimeInterval(10)
    repeat {
        let hasWindow = windows().contains { window in
            (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
                && (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
        }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid && hasWindow
            && CGDisplayIsAsleep(CGMainDisplayID()) == 0 {
            print("display: smoke app PID \(pid) frontmost with an on-screen window; display awake")
            exit(0)
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    } while Date() < deadline && !app.isTerminated
    print("window not visible: PID \(pid) is not frontmost with an on-screen window and awake display after 10s")
    exit(1)
} else {
    fputs("usage: packaged-smoke-window.swift front <pid> | diagnose\n", stderr)
    exit(2)
}
