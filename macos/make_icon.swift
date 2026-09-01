// AppIcon.icns 用の iconset PNG を生成する（main.swift の makeIcon と同じデザイン）。
// 使い方: swift make_icon.swift <output.iconset>
import AppKit

let args = CommandLine.arguments
guard args.count == 2 else {
    FileHandle.standardError.write("usage: swift make_icon.swift <output.iconset>\n".data(using: .utf8)!)
    exit(1)
}
let outDir = URL(fileURLWithPath: args[1])
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

func drawIcon(px: Int) -> Data {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .calibratedRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px) / 512.0
    let bg = NSBezierPath(
        roundedRect: NSRect(x: 32 * s, y: 32 * s, width: 448 * s, height: 448 * s),
        xRadius: 96 * s, yRadius: 96 * s
    )
    NSColor(calibratedRed: 0.31, green: 0.43, blue: 0.97, alpha: 1).setFill()
    bg.fill()
    NSColor.white.withAlphaComponent(0.92).setFill()
    let heights: [CGFloat] = [220, 300, 150]
    for (i, h) in heights.enumerated() {
        let x = (96 + CGFloat(i) * 116) * s
        let bar = NSBezierPath(
            roundedRect: NSRect(x: x, y: (392 - h) * s, width: 88 * s, height: h * s),
            xRadius: 20 * s, yRadius: 20 * s
        )
        bar.fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

// iconset の標準構成 (base サイズと @2x)
let entries: [(String, Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]
for (name, px) in entries {
    try drawIcon(px: px).write(to: outDir.appendingPathComponent(name))
}
print("iconset written: \(outDir.path)")
