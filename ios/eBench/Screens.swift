import SwiftUI
import VisionKit

// The screens from the Lagreton eBench design canvas, page "iPhone companion".

// MARK: Pair

struct PairView: View {
    @Environment(Remote.self) private var remote
    @State private var note: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("eBench").font(.dot(46))
                    Text("A remote for the boards on your Mac.").foregroundStyle(Color.muted)
                }
                ZStack(alignment: .bottom) {
                    if DataScannerViewController.isSupported {
                        Scanner { note = remote.pair($0) }
                    } else {
                        Color.black.opacity(0.4)
                    }
                    Text(DataScannerViewController.isSupported ? "Point at the code on your Mac" : "This iPhone can't scan codes. Paste one instead.")
                        .font(.footnote).foregroundStyle(Color.muted)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(.black.opacity(0.4), in: Capsule())
                        .padding(.bottom, 14)
                }
                .frame(height: 280)
                .clipShape(RoundedRectangle(cornerRadius: 24))
                .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(.white.opacity(0.14)))

                VStack(alignment: .leading, spacing: 14) {
                    step(1, "Open eBench on your Mac.")
                    step(2, "Click **Phones**, then **Show a code**.")
                    step(3, "Hold this iPhone up to the code.")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glass()

                PasteButton(payloadType: String.self) { pasted in
                    Task { @MainActor in note = pasted.first.flatMap { remote.pair($0) } }
                }
                .buttonBorderShape(.capsule)
                .labelStyle(.titleAndIcon)
                .tint(.white.opacity(0.15))
                .frame(maxWidth: .infinity)

                if let message = note ?? (remote.link == .removed ? "This Mac removed this phone, or its code ran out. On the Mac, click Phones and show a new code." : nil) {
                    Text(message).font(.subheadline).foregroundStyle(Color.warn)
                }

                VStack(spacing: 4) {
                    Text("Away from home? Put Tailscale on this iPhone and the Mac.")
                    Link("How to set it up", destination: URL(string: "https://github.com/LagretonSoftware/lagreton-ebench#iphone")!)
                        .underline()
                }
                .font(.footnote).foregroundStyle(Color.faint)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 24)
        }
        .background(Graphite())
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text("\(n)").font(.dot(22)).frame(width: 18).accessibilityHidden(true)
            Text(text)
        }
    }
}

/// The camera, looking for a QR code.
struct Scanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
                                                isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning { try? scanner.startScanning() }
    }

    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void

        init(found: @escaping (String) -> Void) { self.found = found }

        func dataScanner(_ scanner: DataScannerViewController, didAdd added: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in added {
                if let text = code.payloadStringValue { return found(text) }
            }
        }
    }
}

// MARK: Boards

struct BoardsView: View {
    @Environment(Remote.self) private var remote
    @State private var showMac = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Boards").font(.dot(40))
                    Spacer()
                    Button { showMac = true } label: {
                        Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44)
                            .background(.white.opacity(0.10), in: Circle())
                            .overlay(Circle().strokeBorder(.white.opacity(0.18)))
                    }
                    .accessibilityLabel("Mac and pairing")
                }
                MacPill()
                if remote.link == .unreachable { Offline() }
                if remote.boards.isEmpty {
                    Text(remote.online ? "No boards yet. Plug one into the Mac and eBench reads it." : "Connecting to \(remote.mac?.name ?? "your Mac")…")
                        .foregroundStyle(Color.muted)
                        .padding(.vertical, 40)
                        .frame(maxWidth: .infinity)
                }
                ForEach(remote.boards) { b in
                    NavigationLink(value: b.id) { BoardCard(board: b) }.buttonStyle(.plain)
                }
                if !remote.boards.isEmpty {
                    let here = remote.boards.filter { $0.port != nil }.count
                    Text("\(here) on the hub · \(remote.boards.count - here) unplugged")
                        .font(.caption).foregroundStyle(Color.faint)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 4)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .background(Graphite())
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: String.self) { BoardView(id: $0) }
        .sheet(isPresented: $showMac) { MacSheet() }
        .refreshable {
            remote.stop()
            remote.start()
        }
    }
}

struct MacPill: View {
    @Environment(Remote.self) private var remote

    var body: some View {
        let (dot, state): (Color, String) = switch remote.link {
        case .connected: (.live, "connected")
        case .unreachable: (.warn, "not reachable")
        default: (.faint, "connecting…")
        }
        HStack(spacing: 10) {
            Circle().fill(dot).frame(width: 8, height: 8).shadow(color: dot, radius: remote.online ? 5 : 0)
            Text(remote.mac?.name ?? "Mac").font(.subheadline.weight(.semibold)).lineLimit(1)
            Text(state).font(.subheadline).foregroundStyle(Color.faint)
            Spacer()
            if case .connected(let via) = remote.link {
                Label(via.hasPrefix("100.") ? "Tailscale" : "Wi-Fi", systemImage: via.hasPrefix("100.") ? "network" : "wifi")
                    .font(.caption).foregroundStyle(Color.muted)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .background(.black.opacity(0.26), in: Capsule())
        .overlay(Capsule().strokeBorder(.white.opacity(0.14)))
        .accessibilityElement(children: .combine)
    }
}

struct Offline: View {
    @Environment(Remote.self) private var remote

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Circle().fill(Color.warn).frame(width: 8, height: 8)
                Text("Can't reach \(remote.mac?.name ?? "the Mac")").font(.headline)
            }
            Text(remote.updated.map { "These are the boards as it last saw them, at \($0.formatted(date: .omitted, time: .shortened)). Buttons come back when the Mac does." }
                 ?? "Buttons come back when the Mac does.")
                .font(.subheadline).foregroundStyle(Color.muted)
            VStack(alignment: .leading, spacing: 6) {
                Text("· Is eBench open, and the Mac awake?")
                Text("· Away from home? Turn on Tailscale on this iPhone.")
            }
            .font(.footnote).foregroundStyle(Color.muted)
            Button("Try again") {
                remote.stop()
                remote.start()
            }
            .buttonStyle(Primary())
        }
        .padding(16)
        .background(.black.opacity(0.26), in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.warn.opacity(0.35)))
    }
}

/// What a board is up to, as one chip: red while the Mac works on it, green when it's on the hub.
struct Status: View {
    @Environment(Remote.self) private var remote
    let board: Board

    var body: some View {
        if let job = board.job, remote.online {
            Chip(text: job.label, dot: .busy)
        } else if !remote.online, board.port != nil, let at = remote.updated {
            Chip(text: "on the hub at \(at.formatted(date: .omitted, time: .shortened))")
        } else if board.isNew {
            Chip(text: "New · name it on the Mac")
        } else {
            switch board.status {
            case "ready": Chip(text: "On the hub", dot: .live)
            case "reading": Chip(text: "Reading…")
            case "error": Chip(text: "Can't read it", dot: .warn)
            default: Chip(text: "Unplugged")
            }
        }
    }
}

struct BoardCard: View {
    let board: Board

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(board.title).font(.dot(26)).lineLimit(1).minimumScaleFactor(0.6)
                Spacer(minLength: 4)
                if board.share { Chip(text: "Port shared") }
                Status(board: board)
            }
            Text([board.model.isEmpty ? board.chip : board.model, board.flash > 0 ? board.flash.bytes : ""].filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.subheadline).foregroundStyle(Color.muted)
            if let job = board.job {
                Progress(job: job).well()
            } else if let error = board.error {
                Text(error).font(.subheadline).foregroundStyle(Color.warn)
            } else if let fw = board.running {
                HStack(spacing: 10) {
                    Text(fw.project).font(.subheadline.weight(.semibold))
                    Text(fw.version).font(.mono).foregroundStyle(Color.faint)
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.faint)
                }
                .well()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass(padding: 14)
        .opacity(board.port == nil ? 0.8 : 1)
        .contentShape(Rectangle())
    }
}

struct Progress: View {
    let job: Job

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Text(job.label).font(.subheadline)
                Spacer()
                Text("\(job.pct)%").font(.mono).foregroundStyle(Color.muted)
            }
            ProgressView(value: Double(job.pct), total: 100).tint(.busy)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: One board

/// A destructive step that waits for a yes.
private struct Ask: Identifiable {
    let id = UUID()
    let title: String
    let button: String
    let path: String
    var leave = false
}

struct BoardView: View {
    @Environment(Remote.self) private var remote
    @Environment(\.dismiss) private var dismiss
    let id: String
    @State private var note: String?
    @State private var switching = false
    @State private var ask: Ask?

    var body: some View {
        if let b = remote.boards.first(where: { $0.id == id }) {
            page(b)
        } else {
            Text("This board is gone from the Mac.").foregroundStyle(Color.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(Graphite())
        }
    }

    private func page(_ b: Board) -> some View {
        let canAct = remote.online && b.ready && b.job == nil
        return ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(b.title).font(.dot(40)).lineLimit(1).minimumScaleFactor(0.5)
                        Spacer()
                        Status(board: b)
                    }
                    let about = [b.model, b.notes].filter { !$0.isEmpty }.joined(separator: " · ")
                    if !about.isEmpty { Text(about).foregroundStyle(Color.muted) }
                    FlowChips(items: [b.chip.isEmpty ? "" : "\(b.chip) \(b.rev)", b.flash > 0 ? "\(b.flash.bytes) flash" : "",
                                      b.psram.isEmpty ? "" : "\(b.psram) PSRAM"].filter { !$0.isEmpty }, mac: b.mac)
                        .padding(.top, 6)
                }

                if let note { Text(note).font(.subheadline).foregroundStyle(Color.warn) }

                VStack(alignment: .leading, spacing: 14) {
                    if let job = b.job {
                        Progress(job: job)
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            Label("On the board", systemImage: "circle.fill")
                                .labelStyle(DotLabel(color: b.running == nil ? .faint : .live))
                                .font(.caption2.weight(.medium)).textCase(.uppercase).foregroundStyle(Color.faint)
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Text(b.running?.project ?? "Nothing recognisable").font(.title3.weight(.semibold))
                                Text(b.running?.version ?? "").font(.mono).foregroundStyle(Color.faint)
                            }
                        }
                        if let last = b.lastJob, !last.ok, !last.msg.isEmpty {
                            Text(last.msg).font(.footnote).foregroundStyle(Color.warn)
                        }
                        Button { switching = true } label: { Label("Switch firmware", systemImage: "arrow.left.arrow.right") }
                            .buttonStyle(Primary())
                            .disabled(!canAct)
                            .opacity(canAct ? 1 : 0.5)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .glass()

                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
                    action("Back up", "arrow.down.to.line", "backup/\(b.port ?? "")", canAct)
                    action("Save settings", "bookmark", "save-settings/\(b.port ?? "")", canAct)
                    action("Restart", "arrow.clockwise", "restart/\(b.port ?? "")", canAct)
                    action("Read again", "magnifyingglass", "read/\(b.port ?? "")", canAct)
                }

                Toggle(isOn: Binding(get: { b.share }, set: { on in run("share/\(b.mac)?on=\(on ? 1 : 0)") })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Share port").font(.body.weight(.medium))
                        Text("Leave the port free for another app on the Mac").font(.caption).foregroundStyle(Color.faint)
                    }
                }
                .tint(.live)
                .disabled(!remote.online || b.mac.isEmpty)
                .well(16)

                if let port = b.port { LogPanel(lines: remote.logs[port] ?? []) }

                SavesPanel(board: b, canRestore: canAct, online: remote.online) { ask = $0 }

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Label("Security", systemImage: "lock").font(.subheadline.weight(.semibold))
                        Spacer()
                        Label(b.unsafe.isEmpty ? "All four switches safe" : "Not safe: \(b.unsafe.joined(separator: ", "))", systemImage: "circle.fill")
                            .labelStyle(DotLabel(color: b.unsafe.isEmpty ? .live : .warn))
                            .font(.caption).foregroundStyle(Color.muted)
                    }
                    Text("Lock open is only on the Mac, because it can't be undone.").font(.footnote).foregroundStyle(Color.faint)
                }
                .well(20)

                if !b.mac.isEmpty {
                    Button("Forget this board") {
                        ask = Ask(title: "Forget \(b.title)? Its saves on the Mac are deleted too. The board itself isn't touched.",
                                  button: "Forget and delete saves", path: "forget/\(b.mac)", leave: true)
                    }
                    .buttonStyle(Quiet(height: 48))
                    .disabled(!remote.online || b.job != nil)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .background(Graphite())
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .sheet(isPresented: $switching) { SwitchSheet(id: id) }
        .confirmationDialog(ask?.title ?? "", isPresented: Binding(get: { ask != nil }, set: { if !$0 { ask = nil } }),
                            titleVisibility: .visible, presenting: ask) { a in
            Button(a.button, role: .destructive) {
                run(a.path) { if a.leave { dismiss() } }
            }
        }
    }

    private func action(_ title: String, _ icon: String, _ path: String, _ enabled: Bool) -> some View {
        Button { run(path) } label: { Label(title, systemImage: icon) }
            .buttonStyle(Quiet(height: 56))
            .disabled(!enabled)
            .opacity(enabled ? 1 : 0.5)
    }

    private func run(_ path: String, done: @escaping () -> Void = {}) {
        Task {
            note = await remote.act(path)
            if note == nil { done() }
        }
    }
}

struct DotLabel: LabelStyle {
    let color: Color

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 6, height: 6)
            configuration.title
        }
    }
}

struct FlowChips: View {
    let items: [String]
    let mac: String

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { chips }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) { ForEach(items, id: \.self) { Chip(text: $0) } }
                if !mac.isEmpty { Chip(text: mac, mono: true) }
            }
        }
    }

    @ViewBuilder private var chips: some View {
        ForEach(items, id: \.self) { Chip(text: $0) }
        if !mac.isEmpty { Chip(text: mac, mono: true) }
    }
}

struct LogPanel: View {
    let lines: [LogLine]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Log").font(.headline)
                Spacer()
                Label("Live", systemImage: "circle.fill").labelStyle(DotLabel(color: .live)).font(.caption).foregroundStyle(Color.faint)
            }
            VStack(alignment: .leading, spacing: 3) {
                if lines.isEmpty { Text("Nothing yet.").foregroundStyle(Color.faint) }
                ForEach(lines.suffix(14)) { l in
                    Text("\(l.t)  \(l.tag): \(l.msg)")
                        .foregroundStyle(l.lvl == "W" || l.lvl == "E" ? Color.warn : Color.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .font(.system(size: 11.5, design: .monospaced))
            .textSelection(.enabled)
            .padding(12)
            .background(.black.opacity(0.30), in: RoundedRectangle(cornerRadius: 16))
        }
    }
}

private struct SavesPanel: View {
    let board: Board
    let canRestore: Bool
    let online: Bool
    let ask: (Ask) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Saves").font(.headline)
                Spacer()
                Text("Kept on the Mac").font(.caption).foregroundStyle(Color.faint)
            }
            if board.saves.isEmpty {
                Text("No saves yet. Back up to keep an exact copy on the Mac.").font(.subheadline).foregroundStyle(Color.faint)
            }
            VStack(spacing: 0) {
                ForEach(Array(board.saves.enumerated()), id: \.element.id) { i, s in
                    HStack(spacing: 6) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(s.title).font(.subheadline.weight(.medium)).lineLimit(1)
                            Text("\(s.size.bytes) · \(s.created.stamp)").font(.caption).foregroundStyle(Color.faint)
                        }
                        Spacer()
                        Button("Restore") {
                            ask(Ask(title: "Restore \(s.title) to \(board.title)? It rewrites the board with this save.",
                                    button: "Restore", path: "restore/\(board.port ?? "")?id=\(s.id.query)"))
                        }
                        .buttonStyle(.bordered).buttonBorderShape(.capsule)
                        .disabled(!canRestore)
                        Menu {
                            Button("Delete this save", role: .destructive) {
                                ask(Ask(title: "Delete \(s.title) from the Mac? It can't be brought back.", button: "Delete",
                                        path: "delete-save/\(board.mac)?id=\(s.id.query)"))
                            }
                        } label: {
                            Image(systemName: "ellipsis").frame(width: 44, height: 44)
                        }
                        .disabled(!online)
                        .accessibilityLabel("More for \(s.title)")
                    }
                    .padding(.leading, 16).padding(.trailing, 4).padding(.vertical, 6)
                    .overlay(alignment: .top) { if i > 0 { Divider().overlay(.white.opacity(0.10)) } }
                }
            }
            .background(LinearGradient(colors: [.white.opacity(0.13), .white.opacity(0.05)], startPoint: .top, endPoint: .bottom),
                        in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(.white.opacity(0.16)))
        }
    }
}

// MARK: Switch firmware

struct SwitchSheet: View {
    @Environment(Remote.self) private var remote
    @Environment(\.dismiss) private var dismiss
    let id: String
    @State private var picked: String?
    @State private var sent = false
    @State private var note: String?

    private static let steps = [("save", "Save the current settings"), ("scan", "Scan for lockout switches"),
                                ("flash", "Write the new firmware"), ("check", "Check the switches")]

    var body: some View {
        let b = remote.boards.first { $0.id == id }
        let options = (b?.library ?? []).filter(\.fits)
        let choice = options.first { $0.id == picked } ?? options.first { !$0.onBoard }
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let b, sent {
                        progress(b)
                    } else if let b {
                        Text("From the library on your Mac. Only what fits \(b.title).").font(.subheadline).foregroundStyle(Color.faint)
                        if options.isEmpty {
                            Text("Nothing in the library fits this board. Import firmware on the Mac.").foregroundStyle(Color.muted)
                        }
                        ForEach(options) { f in
                            Button { picked = f.id } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: f.id == choice?.id ? "largecircle.fill.circle" : "circle")
                                        .font(.title3).foregroundStyle(f.onBoard ? Color.faint : .white)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("\(f.name) ").font(.body.weight(.medium)) + Text(f.ver).font(.mono).foregroundColor(.faint)
                                        Text(f.onBoard ? "On the board now" : "Fits").font(.caption).foregroundStyle(Color.faint)
                                    }
                                    Spacer()
                                }
                                .padding(.horizontal, 14).frame(minHeight: 56)
                                .background(.white.opacity(f.id == choice?.id ? 0.16 : 0.06), in: RoundedRectangle(cornerRadius: 16))
                                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(f.id == choice?.id ? 0.55 : 0.12)))
                            }
                            .buttonStyle(.plain)
                            .disabled(f.onBoard)
                            .accessibilityAddTraits(f.id == choice?.id ? .isSelected : [])
                        }
                        if let fw = b.running {
                            Text("First the \(fw.project) settings are saved. They come back when you switch back to it.")
                                .font(.footnote).foregroundStyle(Color.muted).well()
                        }
                        if let note { Text(note).font(.subheadline).foregroundStyle(Color.warn) }
                        if let choice, let port = b.port {
                            Button("Switch to \(choice.name)") {
                                Task {
                                    note = await remote.act("switch/\(port)?id=\(choice.id.query)")
                                    sent = note == nil
                                }
                            }
                            .buttonStyle(Primary())
                            .disabled(!remote.online || !b.ready || b.job != nil)
                        }
                    }
                }
                .padding(16)
            }
            .background(Graphite())
            .navigationTitle(sent ? "Switching \(b?.title ?? "")" : "Switch firmware")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(sent ? "Close" : "Cancel") { dismiss() } }
            }
        }
        .presentationBackground(Color.ground)
    }

    /// The Mac's four switch steps, live from the board's job.
    private func progress(_ b: Board) -> some View {
        let now = Self.steps.firstIndex { $0.0 == b.job?.phase } ?? (b.job == nil ? Self.steps.count : 0)
        return VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(Self.steps.enumerated()), id: \.offset) { i, step in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        if i < now {
                            Image(systemName: "checkmark").foregroundStyle(Color.live).accessibilityLabel("Done")
                        } else if i == now {
                            Circle().fill(Color.busy).frame(width: 9, height: 9).padding(.horizontal, 4).accessibilityLabel("Working")
                        } else {
                            Circle().strokeBorder(Color.faint, lineWidth: 1.5).frame(width: 9, height: 9).padding(.horizontal, 4)
                        }
                        Text(step.1).foregroundStyle(i > now ? Color.faint : .white)
                        Spacer()
                        if i == now, let job = b.job, step.0 == "flash" { Text("\(job.pct)%").font(.mono).foregroundStyle(Color.muted) }
                    }
                    if i == now, let job = b.job, step.0 == "flash" { ProgressView(value: Double(job.pct), total: 100).tint(.busy) }
                }
                .padding(12)
                .background(.white.opacity(i == now ? 0.10 : 0), in: RoundedRectangle(cornerRadius: 14))
            }
            if b.job == nil, let last = b.lastJob {
                Text(last.ok ? "Done. \(b.running.map { "\($0.project) \($0.version)" } ?? "The new firmware") is on the board." : last.msg)
                    .foregroundStyle(last.ok ? Color.live : Color.warn).padding(.top, 8)
            } else {
                Text("Keep the board plugged in. You can close this: the Mac carries on, and Boards shows the progress.")
                    .font(.footnote).foregroundStyle(Color.faint).padding(.top, 8)
            }
        }
    }
}

// MARK: Mac and pairing

struct MacSheet: View {
    @Environment(Remote.self) private var remote
    @Environment(\.dismiss) private var dismiss
    @State private var confirm = false

    var body: some View {
        NavigationStack {
            List {
                Section("Mac") {
                    LabeledContent("Name", value: remote.mac?.name ?? "")
                    LabeledContent("Connection", value: {
                        if case .connected(let via) = remote.link { return via }
                        return remote.link == .unreachable ? "Not reachable" : "Connecting…"
                    }())
                }
                Section {
                    ForEach(remote.mac?.hosts ?? [], id: \.self) { Text($0).font(.mono) }
                } header: {
                    Text("Addresses it tries")
                } footer: {
                    Text("Away from home, the 100.x address works through Tailscale.")
                }
                Section {
                    Button("Unpair this iPhone", role: .destructive) { confirm = true }
                } footer: {
                    Text("This forgets the Mac on this iPhone only. Remove the phone in the Mac's Phones list too, and scan a new code to pair again.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Graphite())
            .navigationTitle("Mac and pairing")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Unpair from \(remote.mac?.name ?? "this Mac")?", isPresented: $confirm, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    remote.unpair()
                    dismiss()
                }
            }
        }
    }
}
