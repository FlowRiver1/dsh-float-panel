// DSH Float Panel — a tiny always-on-top window.
//
// The DSH desktop app is Electron, and an Electron renderer cannot create a
// floating window (and window.open is denied by the main process). So the
// always-on-top surface is this native panel instead; it is a thin WebKit
// shell around the page served by the dsh-float-panel host plugin.
//
// Usage: dsh-float-panel <url> <state-dir>

import Cocoa
import WebKit

// Small on purpose: the panel is a glance, not a second app window. The page
// measures itself and asks for a height; these are just the starting point and
// the hard limits (a six-card list is still under 300pt).
let DEFAULT_SIZE = NSSize(width: 320, height: 64)
let MIN_HEIGHT: CGFloat = 46
let MAX_HEIGHT: CGFloat = 420
let DRAG_STRIP_HEIGHT: CGFloat = 22
let DRAG_STRIP_INSET: CGFloat = 26   // leave the close button clickable

/// A transparent strip along the top edge that moves the window.
final class DragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

final class PanelController: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var panel: NSPanel!
    private var webView: WKWebView!
    private var url: URL!
    private var defaults: UserDefaults!
    private var failures = 0
    private var loadedOnce = false

    private let frameKey = "panelAnchor2"

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        guard args.count >= 2, let target = URL(string: args[1]) else {
            FileHandle.standardError.write(Data("usage: dsh-float-panel <url> [state-dir]\n".utf8))
            NSApp.terminate(nil)
            return
        }
        url = target
        if args.count >= 3 {
            defaults = UserDefaults(suiteName: "local.dsh.float-panel") ?? .standard
        } else {
            defaults = .standard
        }

        buildWindow()
        load()
        panel.orderFrontRegardless()
    }

    private func buildWindow() {
        panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: DEFAULT_SIZE),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "任务浮窗"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.animationBehavior = .utilityWindow

        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = false
        let controller = WKUserContentController()
        controller.add(self, name: "dsh")
        config.userContentController = controller

        webView = WKWebView(frame: NSRect(origin: .zero, size: DEFAULT_SIZE), configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 12.0, *) {
            webView.underPageBackgroundColor = .clear
        }
        webView.allowsMagnification = false

        let content = NSView(frame: NSRect(origin: .zero, size: DEFAULT_SIZE))
        content.autoresizingMask = [.width, .height]
        content.addSubview(webView)

        let strip = DragStrip(frame: NSRect(x: 0, y: DEFAULT_SIZE.height - DRAG_STRIP_HEIGHT,
                                           width: DEFAULT_SIZE.width - DRAG_STRIP_INSET,
                                           height: DRAG_STRIP_HEIGHT))
        strip.autoresizingMask = [.width, .minYMargin]
        content.addSubview(strip)

        panel.contentView = content
        panel.setFrame(restoredFrame(), display: false)
    }

    /// The saved anchor is the bottom-left corner, so the panel grows upward from
    /// the bottom edge instead of pushing down past the Dock.
    private func restoredFrame() -> NSRect {
        let size = DEFAULT_SIZE
        if let raw = defaults.string(forKey: frameKey) {
            let parts = raw.split(separator: ",").compactMap { Double($0) }
            if parts.count == 2 {
                let origin = NSPoint(x: parts[0], y: parts[1])
                let proposed = NSRect(origin: origin, size: size)
                if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(proposed) }) {
                    return proposed
                }
            }
        }
        guard let screen = NSScreen.main else { return NSRect(origin: .zero, size: size) }
        let visible = screen.visibleFrame
        return NSRect(x: visible.maxX - size.width - 18,
                      y: visible.minY + 18,
                      width: size.width, height: size.height)
    }

    private func saveFrame() {
        guard let panel else { return }
        let frame = panel.frame
        defaults.set("\(frame.minX),\(frame.minY)", forKey: frameKey)
    }

    /// Fit the window to the content the page measured, keeping the bottom edge.
    private func resize(to height: CGFloat) {
        guard let panel else { return }
        let target = min(max(height, MIN_HEIGHT), MAX_HEIGHT)
        var frame = panel.frame
        guard abs(frame.height - target) > 0.5 else { return }
        let bottom = frame.minY
        frame.size.height = target
        frame.origin.y = bottom
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            context.allowsImplicitAnimation = true
            panel.animator().setFrame(frame, display: true)
        }
    }

    private func load() {
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))
    }

    // ── WKNavigationDelegate ──

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        failures = 0
        loadedOnce = true
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        retry()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retry()
    }

    private func retry() {
        failures += 1
        if failures > 40 {
            NSApp.terminate(nil)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.load()
        }
    }

    // ── page → shell messages ──

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        switch type {
        case "activate":
            activateDSH()
        case "resize":
            if let height = body["height"] as? Double {
                resize(to: CGFloat(height))
            }
        case "retire":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    private func activateDSH() {
        if let url = URL(string: "dsh://open") {
            NSWorkspace.shared.open(url)
        }
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.deepseek.dsh")
        if let app = apps.first {
            app.activate(options: [])
        }
    }

    // ── window lifecycle ──

    func applicationWillTerminate(_ notification: Notification) {
        saveFrame()
    }

    func applicationDidResignActive(_ notification: Notification) {
        saveFrame()
    }
}

let delegate = PanelController()
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
