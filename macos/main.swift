import Cocoa
import WebKit

@main
class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate {

    // メモ内リンク (target="_blank") は既定ブラウザで開く
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // JavaScript の confirm() / alert() をネイティブのダイアログで出す。
    // WKWebView は実装が無いと confirm() が常に false を返し、確認ダイアログが
    // 「キャンセル」扱いになる (全自動モードの確認やグループ削除の確認が通らない)。
    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "キャンセル")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    var window: NSWindow!
    var webView: WKWebView!
    var serverProcess: Process?
    let port = ProcessInfo.processInfo.environment["TASKDECK_PORT"] ?? "4747"
    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    // 配布版は Contents/Resources/app にソースと node_modules を同梱している。
    // 開発版 (macos/build.sh) は build 時に焼き込んだリポジトリパスを使う。
    var appRoot: String {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("app").path,
           FileManager.default.fileExists(atPath: bundled + "/src/server.js") {
            return bundled
        }
        return repoPath
    }
    // 配布版に同梱した Node.js (scripts/package.mjs が app/node/bin/node に置く)
    var bundledNode: String? {
        let p = appRoot + "/node/bin/node"
        return FileManager.default.isExecutableFile(atPath: p) ? p : nil
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.applicationIconImage = makeIcon()
        buildMenu()

        let rect = NSRect(x: 0, y: 0, width: 1100, height: 720)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = "taskdeck"
        window.minSize = NSSize(width: 720, height: 420)
        window.setFrameAutosaveName("TaskdeckMain")
        window.center()

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: rect, configuration: config)
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        ensureServerThenLoad()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
    }

    // MARK: - Server lifecycle

    func ensureServerThenLoad() {
        ping { alive in
            if alive {
                DispatchQueue.main.async { self.webView.load(URLRequest(url: self.baseURL)) }
            } else {
                self.spawnServer()
                self.waitForServer(retries: 40)
            }
        }
    }

    func ping(_ completion: @escaping (Bool) -> Void) {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/projects"))
        req.timeoutInterval = 0.5
        URLSession.shared.dataTask(with: req) { _, res, _ in
            completion((res as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    func waitForServer(retries: Int) {
        ping { alive in
            DispatchQueue.main.async {
                if alive {
                    self.webView.load(URLRequest(url: self.baseURL))
                } else if retries > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        self.waitForServer(retries: retries - 1)
                    }
                } else {
                    self.showError("サーバーを起動できませんでした。\nnode と \(self.appRoot)/src/server.js を確認してください。")
                }
            }
        }
    }

    func spawnServer() {
        guard let node = findNode() else {
            showError("node が見つかりませんでした。Node.js をインストールしてください。")
            return
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [appRoot + "/src/server.js"]
        proc.currentDirectoryURL = URL(fileURLWithPath: appRoot)
        var env = ProcessInfo.processInfo.environment
        env["TASKDECK_PORT"] = port
        proc.environment = env
        do {
            try proc.run()
            serverProcess = proc
        } catch {
            showError("サーバー起動に失敗: \(error.localizedDescription)")
        }
    }

    func findNode() -> String? {
        if let env = ProcessInfo.processInfo.environment["TASKDECK_NODE"],
           FileManager.default.isExecutableFile(atPath: env) { return env }
        if let bundled = bundledNode { return bundled }
        let home = NSHomeDirectory()
        let candidates = [
            home + "/.nodebrew/current/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        // Fall back to the login shell's PATH
        let sh = Process()
        sh.executableURL = URL(fileURLWithPath: "/bin/zsh")
        sh.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        sh.standardOutput = pipe
        try? sh.run()
        sh.waitUntilExit()
        let out = String(
            data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8
        )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return out.isEmpty ? nil : out
    }

    func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "taskdeck"
        alert.informativeText = message
        alert.runModal()
    }

    // MARK: - Menu (Cmd+Q / Cmd+W / Cmd+R / copy-paste)

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "taskdeck を終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "編集")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "取り消す", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "やり直す", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "カット", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "コピー", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "ペースト", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "すべて選択", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "表示")
        viewItem.submenu = viewMenu
        viewMenu.addItem(withTitle: "再読み込み", action: #selector(reload), keyEquivalent: "r")

        let claudeItem = NSMenuItem()
        main.addItem(claudeItem)
        let claudeMenu = NSMenu(title: "Claude")
        claudeItem.submenu = claudeMenu
        claudeMenu.addItem(withTitle: "Claude Code に MCP を登録…", action: #selector(registerMcp), keyEquivalent: "")
        claudeMenu.addItem(withTitle: "MCP 登録コマンドをコピー", action: #selector(copyMcpCommand), keyEquivalent: "")

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "ウインドウ")
        windowItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "閉じる", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "しまう", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")

        NSApp.mainMenu = main
    }

    @objc func reload() {
        webView.load(URLRequest(url: baseURL))
    }

    // MARK: - MCP registration (配布版はターミナルで npm run mcp:register できないのでメニューから)

    func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    var mcpCommand: String {
        let node = bundledNode ?? findNode() ?? "node"
        let mcp = appRoot + "/src/mcp.js"
        return "claude mcp add --scope user taskdeck -- \(shellQuote(node)) \(shellQuote(mcp))"
    }

    func copyToPasteboard(_ s: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(s, forType: .string)
    }

    @objc func copyMcpCommand() {
        copyToPasteboard(mcpCommand)
        let alert = NSAlert()
        alert.messageText = "MCP 登録コマンドをコピーしました"
        alert.informativeText = "ターミナルに貼り付けて実行してください:\n\n\(mcpCommand)"
        alert.runModal()
    }

    @objc func registerMcp() {
        // ログインシェル経由で claude CLI を探す (.app は素の PATH しか持たない)
        let sh = Process()
        sh.executableURL = URL(fileURLWithPath: "/bin/zsh")
        sh.arguments = ["-lc", mcpCommand]
        let pipe = Pipe()
        sh.standardOutput = pipe
        sh.standardError = pipe
        do { try sh.run() } catch {
            copyToPasteboard(mcpCommand)
            showError("シェルを起動できませんでした。コマンドをクリップボードにコピーしたので、ターミナルで実行してください:\n\n\(mcpCommand)")
            return
        }
        sh.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let alert = NSAlert()
        alert.messageText = "taskdeck"
        if sh.terminationStatus == 0 {
            alert.informativeText = "Claude Code に MCP を登録しました。\n\n\(out)\n\n確認: claude mcp list"
        } else {
            copyToPasteboard(mcpCommand)
            alert.informativeText =
                "登録に失敗しました (claude CLI が見つからない可能性があります)。\n\n\(out)\n\n" +
                "コマンドをクリップボードにコピーしたので、ターミナルで実行してください:\n\(mcpCommand)"
        }
        alert.runModal()
    }

    // MARK: - Dock icon (drawn at runtime, no asset pipeline)

    func makeIcon() -> NSImage {
        let size = NSSize(width: 512, height: 512)
        let image = NSImage(size: size)
        image.lockFocus()
        let bg = NSBezierPath(
            roundedRect: NSRect(x: 32, y: 32, width: 448, height: 448), xRadius: 96, yRadius: 96)
        NSColor(calibratedRed: 0.31, green: 0.43, blue: 0.97, alpha: 1).setFill()
        bg.fill()
        NSColor.white.withAlphaComponent(0.92).setFill()
        let heights: [CGFloat] = [220, 300, 150]
        for (i, h) in heights.enumerated() {
            let x = 96 + CGFloat(i) * 116
            let bar = NSBezierPath(
                roundedRect: NSRect(x: x, y: 392 - h, width: 88, height: h), xRadius: 20, yRadius: 20)
            bar.fill()
        }
        image.unlockFocus()
        return image
    }
}
