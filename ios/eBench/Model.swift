import Foundation

// What the Mac's /api/events stream sends, read leniently: a field the Mac leaves out or changes type
// becomes empty instead of failing the whole board. Codable only for the offline copy (Store.cache),
// which keeps none of a board's settings, so no Wi-Fi passwords land on the phone.

/// A board as the phone shows it: what the Mac remembers about it, plus its live state while it's plugged in.
struct Board: Codable, Identifiable, Equatable {
    var mac: String
    var name: String
    var model: String
    var notes: String
    var chip: String
    var rev: String
    var flash: Int
    var psram: String
    var running: Running?
    var saves: [Save]
    var port: String?  // only while it's plugged in
    var status: String  // "ready", "reading", "error" or "unplugged"
    var error: String?
    var job: Job?
    var lastJob: LastJob?
    var share: Bool
    var isNew: Bool
    var library: [Firmware]  // what the Mac's library holds, as this board sees it
    var unsafe: [String]  // labels of the security switches that aren't safe

    var id: String { mac.isEmpty ? (port ?? "?") : mac }
    var title: String { !name.isEmpty ? name : !chip.isEmpty ? chip : "ESP board" }
    var ready: Bool { port != nil && status == "ready" && !isNew }

    init(_ d: [String: Any]) {
        mac = d["mac"] as? String ?? ""
        name = d["name"] as? String ?? ""
        model = d["model"] as? String ?? ""
        notes = d["notes"] as? String ?? ""
        chip = d["chip"] as? String ?? ""
        rev = d["rev"] as? String ?? ""
        flash = (d["flash"] as? NSNumber)?.intValue ?? 0
        psram = d["psram"] as? String ?? ""
        running = (d["running"] as? [String: Any]).flatMap(Running.init)
        saves = (d["saves"] as? [[String: Any]] ?? []).compactMap(Save.init)
        port = d["port"] as? String
        status = d["status"] as? String ?? "unplugged"
        error = d["error"] as? String
        job = (d["job"] as? [String: Any]).map(Job.init)
        lastJob = (d["lastJob"] as? [String: Any]).map(LastJob.init)
        share = d["share"] as? Bool ?? false
        isNew = d["new"] as? Bool ?? false
        library = (d["library"] as? [[String: Any]] ?? []).compactMap(Firmware.init)
        unsafe = (d["switches"] as? [[String: Any]] ?? []).filter { !($0["safe"] as? Bool ?? true) }.compactMap { $0["label"] as? String }
    }

    /// Every board the Mac knows, live state laid over what it remembers, like the Mac's My boards.
    /// Boards it hasn't named yet, or can't read, come last.
    static func merge(profiles: [[String: Any]], live: [[String: Any]]) -> [Board] {
        let named = profiles.map { saved -> Board in
            let here = live.first { $0["mac"] as? String == saved["mac"] as? String && $0["status"] as? String == "ready" && !($0["new"] as? Bool ?? false) }
            if let here { return Board(saved.merging(here) { $1 }) }
            var b = Board(saved)
            b.port = nil
            b.status = "unplugged"
            b.job = nil
            return b
        }
        let macs = Set(named.map(\.mac))
        return named + live.filter { !macs.contains($0["mac"] as? String ?? "") }.map(Board.init)
    }
}

struct Running: Codable, Equatable {
    var project: String
    var version: String

    init?(_ d: [String: Any]) {
        guard let project = d["project"] as? String else { return nil }
        self.project = project
        version = d["version"] as? String ?? ""
    }
}

struct Save: Codable, Identifiable, Equatable {
    var id: String
    var kind: String  // "full" or "settings"
    var created: String
    var size: Int
    var firmware: Running?

    init?(_ d: [String: Any]) {
        guard let id = d["id"] as? String else { return nil }
        self.id = id
        kind = d["kind"] as? String ?? ""
        created = d["created"] as? String ?? ""
        size = (d["size"] as? NSNumber)?.intValue ?? 0
        firmware = (d["firmware"] as? [String: Any]).flatMap(Running.init)
    }

    var title: String { kind == "settings" ? "Settings · \(firmware?.project ?? "unknown firmware")" : "Full backup" }
}

struct Job: Codable, Equatable {
    var kind: String
    var label: String
    var pct: Int
    var phase: String?

    init(_ d: [String: Any]) {
        kind = d["kind"] as? String ?? ""
        label = d["label"] as? String ?? "Working"
        pct = (d["pct"] as? NSNumber)?.intValue ?? 0
        phase = d["phase"] as? String
    }
}

struct LastJob: Codable, Equatable {
    var ok: Bool
    var msg: String

    init(_ d: [String: Any]) {
        ok = d["ok"] as? Bool ?? false
        msg = d["msg"] as? String ?? ""
    }
}

/// A library entry as one board sees it: does it fit, and is it what's running.
struct Firmware: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var ver: String
    var onBoard: Bool
    var fits: Bool
    var why: String  // the first check it fails

    init?(_ d: [String: Any]) {
        guard let id = d["id"] as? String else { return nil }
        self.id = id
        name = d["name"] as? String ?? "Imported"
        ver = d["ver"] as? String ?? ""
        onBoard = d["onBoard"] as? Bool ?? false
        let failed = (d["checks"] as? [[String: Any]] ?? []).first { !($0["ok"] as? Bool ?? true) }
        fits = failed == nil
        why = failed?["detail"] as? String ?? ""
    }
}

struct LogLine: Identifiable, Equatable {
    var n: Int
    var t: String
    var lvl: String
    var tag: String
    var msg: String
    var id: Int { n }

    init(_ d: [String: Any]) {
        n = (d["n"] as? NSNumber)?.intValue ?? 0
        t = d["t"] as? String ?? ""
        lvl = d["lvl"] as? String ?? "I"
        tag = d["tag"] as? String ?? ""
        msg = d["msg"] as? String ?? ""
    }
}

/// The phone's offline copy: the boards as the Mac last showed them.
struct Cache: Codable {
    var at: Date
    var boards: [Board]
}
