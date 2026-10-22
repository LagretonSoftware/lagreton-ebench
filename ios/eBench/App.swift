import SwiftUI
import UIKit

@main
struct EBenchApp: App {
    @State private var remote = Remote()
    @Environment(\.scenePhase) private var phase

    init() { Remote.device = UIDevice.current.model }

    var body: some Scene {
        WindowGroup {
            Root()
                .environment(remote)
                .preferredColorScheme(.dark)
                .onOpenURL { _ = remote.pair($0.absoluteString) }  // a code scanned with the Camera app
        }
        .onChange(of: phase) { _, now in
            // Only while the app is on screen: iOS would cut the stream in the background anyway.
            if now == .active { remote.start() } else if now == .background { remote.stop() }
        }
    }
}

struct Root: View {
    @Environment(Remote.self) private var remote

    var body: some View {
        Group {
            if remote.mac == nil {
                PairView()
            } else {
                NavigationStack { BoardsView() }
            }
        }
        .tint(.white)
        .task { remote.start() }
    }
}

// The Mac app's Graphite look: graphite glass on a dotted ground, green for connected or fine,
// red only while the Mac is working on a board.
extension Color {
    init(hex: UInt32) {
        self.init(red: Double(hex >> 16 & 0xFF) / 255, green: Double(hex >> 8 & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    static let live = Color(hex: 0x5BE3A5)
    static let busy = Color(hex: 0xFF5A47)
    static let warn = Color(hex: 0xFFC24D)
    static let muted = Color(hex: 0xD1D1D6)
    static let faint = Color(hex: 0xC7C7CC)
    static let ground = Color(hex: 0x1A1A1D)
}

extension Font {
    /// Stands in for the Mac app's Doto dot-matrix face, which ships only as a web font.
    static func dot(_ size: CGFloat) -> Font { .system(size: size, weight: .black, design: .monospaced) }
    static let mono = Font.system(size: 12, design: .monospaced)
}

struct Graphite: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: 0x3A3A40), Color(hex: 0x232327), Color(hex: 0x161618)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Canvas { ctx, size in
                for x in stride(from: 8.0, to: size.width, by: 16) {
                    for y in stride(from: 8.0, to: size.height, by: 16) {
                        ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 2, height: 2)), with: .color(.white.opacity(0.10)))
                    }
                }
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

extension View {
    /// A raised glass card.
    func glass(_ radius: CGFloat = 20, padding: CGFloat = 16) -> some View {
        self.padding(padding)
            .background(LinearGradient(colors: [.white.opacity(0.15), .white.opacity(0.06)], startPoint: .top, endPoint: .bottom),
                        in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(.white.opacity(0.18)))
    }

    /// A sunken well inside a card.
    func well(_ radius: CGFloat = 14) -> some View {
        self.padding(.horizontal, 12).padding(.vertical, 10)
            .background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: radius))
    }
}

struct Chip: View {
    let text: String
    var dot: Color?
    var mono = false

    var body: some View {
        HStack(spacing: 6) {
            if let dot { Circle().fill(dot).frame(width: 7, height: 7) }
            Text(text).font(mono ? .mono : .caption).lineLimit(1)
        }
        .foregroundStyle(Color.muted)
        .padding(.horizontal, 9)
        .frame(height: 24)
        .background(.white.opacity(0.10), in: Capsule())
    }
}

/// A full-width white button, the Mac app's primary.
struct Primary: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(Color.ground)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(.white.opacity(configuration.isPressed ? 0.8 : 1), in: Capsule())
    }
}

/// A quiet glass button.
struct Quiet: ButtonStyle {
    var height: CGFloat = 50

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: height)
            .background(.white.opacity(configuration.isPressed ? 0.2 : 0.10), in: RoundedRectangle(cornerRadius: height / 2.6))
            .overlay(RoundedRectangle(cornerRadius: height / 2.6).strokeBorder(.white.opacity(0.16)))
    }
}

extension Int {
    var bytes: String { ByteCountFormatter.string(fromByteCount: Int64(self), countStyle: .memory) }
}

extension String {
    /// "2026-10-22T09:15:00" as the Mac writes it, shown as "22 Oct, 09:15".
    var stamp: String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return f.date(from: self)?.formatted(.dateTime.day().month(.abbreviated).hour().minute()) ?? self
    }

    var query: String { addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? self }
}
