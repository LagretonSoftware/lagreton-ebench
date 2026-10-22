import CryptoKit
import Foundation
import Observation
import Security

// The phone's link to eBench on the Mac (ebench/remote.py is the other end). A pairing code gives
// the Mac's addresses, a token for this phone, and the pin: the SHA-256 of the Mac's own certificate.
// Every request goes over HTTPS to whichever address answers first, and only to a Mac with that pin.

/// The Mac this phone is paired with. Its token is in the Keychain, not in here.
struct Mac: Codable, Equatable {
    var name: String
    var hosts: [String]
    var port: Int
    var pin: String
}

private struct Offer: Decodable {
    let v: Int
    let name: String
    let hosts: [String]
    let port: Int
    let token: String
    let pin: String
}

private struct Hello: Decodable {
    let name: String
    let hosts: [String]
    let port: Int
}

enum Connection: Equatable {
    case connecting, connected(via: String), unreachable, removed
}

private struct Removed: Error {}

@MainActor @Observable
final class Remote {
    private(set) var mac: Mac? = Store.mac
    private(set) var link: Connection = .connecting
    private(set) var boards: [Board] = []
    private(set) var logs: [String: [LogLine]] = [:]  // by port
    private(set) var updated: Date?  // when the boards on screen came from the Mac

    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var session: URLSession?
    @ObservationIgnored private var base: URL?
    @ObservationIgnored private var cachedAt = Date.distantPast

    nonisolated(unsafe) static var device = "iPhone"  // how the Mac's Phones list names this phone

    init() {
        if let cache = Store.cache {
            boards = cache.boards
            updated = cache.at
        }
    }

    var online: Bool {
        if case .connected = link { return true }
        return false
    }

    /// Pair with a scanned or pasted code. Returns what to tell the user when the code can't be used.
    func pair(_ code: String) -> String? {
        guard let parts = URLComponents(string: code.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme == "ebench", parts.host == "pair",
              let raw = parts.queryItems?.first(where: { $0.name == "d" })?.value,
              let data = Data(base64URL: raw),
              let offer = try? JSONDecoder().decode(Offer.self, from: data), offer.v == 1
        else { return "That isn't an eBench pairing code. On the Mac, click Phones and show a new one." }
        stop()
        Store.token = offer.token
        Store.cache = nil
        mac = Mac(name: offer.name, hosts: offer.hosts, port: offer.port, pin: offer.pin)
        Store.mac = mac
        boards = []
        logs = [:]
        updated = nil
        link = .connecting
        start()
        return nil
    }

    func unpair() {
        stop()
        Store.token = nil
        Store.mac = nil
        Store.cache = nil
        mac = nil
        boards = []
        logs = [:]
        updated = nil
        link = .connecting
    }

    func start() {
        guard task == nil, let mac, let token = Store.token else { return }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30  // the Mac sends at least a ping every 15 s
        let session = URLSession(configuration: config, delegate: Pinned(pin: mac.pin), delegateQueue: nil)
        self.session = session
        task = Task { await run(mac, token, session) }
    }

    func stop() {
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
        base = nil
    }

    /// Ask the Mac to do something, like "backup/usbmodem1101". Returns what went wrong, or nil.
    func act(_ path: String, body: [String: String]? = nil) async -> String? {
        guard online, let base, let session, let token = Store.token else { return "Not connected to the Mac." }
        var req = Self.request(base, path, token, post: true)
        if let body { req.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        guard let (data, resp) = try? await session.data(for: req) else { return "Couldn't reach the Mac." }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 200 { return nil }
        let said = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
        return said ?? (code == 403 ? "Only the Mac can do that." : "The Mac answered \(code).")
    }

    private func run(_ mac: Mac, _ token: String, _ session: URLSession) async {
        while !Task.isCancelled {
            if !online { link = .connecting }
            do {
                let (base, hello) = try await reach(mac, token, session)
                self.base = base
                if hello.hosts != mac.hosts || hello.name != mac.name {  // a new Wi-Fi address, say
                    self.mac = Mac(name: hello.name, hosts: hello.hosts, port: hello.port, pin: mac.pin)
                    Store.mac = self.mac
                }
                link = .connected(via: base.host() ?? "")
                try await listen(base, token, session)
            } catch is Removed {
                unpair()
                link = .removed
                return
            } catch {}
            if Task.isCancelled { return }
            base = nil
            link = .unreachable
            try? await Task.sleep(for: .seconds(3))
        }
    }

    /// Try every address at once; the first to answer wins.
    private func reach(_ mac: Mac, _ token: String, _ session: URLSession) async throws -> (URL, Hello) {
        let found = await withTaskGroup(of: (URL, Int, Data)?.self) { group -> (URL, Int, Data)? in
            for host in mac.hosts {
                var parts = URLComponents()
                parts.scheme = "https"
                parts.host = host
                parts.port = mac.port
                guard let base = parts.url else { continue }
                group.addTask {
                    var req = Remote.request(base, "hello", token)
                    req.timeoutInterval = 6
                    guard let (data, resp) = try? await session.data(for: req),
                          let code = (resp as? HTTPURLResponse)?.statusCode else { return nil }
                    return (base, code, data)
                }
            }
            for await answer in group {
                if let answer, answer.1 == 200 || answer.1 == 401 {
                    group.cancelAll()
                    return answer
                }
            }
            return nil
        }
        guard let found else { throw URLError(.cannotConnectToHost) }
        if found.1 == 401 { throw Removed() }
        let hello = (try? JSONDecoder().decode(Hello.self, from: found.2)) ?? Hello(name: mac.name, hosts: mac.hosts, port: mac.port)
        return (found.0, hello)
    }

    /// The Mac's server-sent events: the whole state whenever it changes, and new log lines.
    private func listen(_ base: URL, _ token: String, _ session: URLSession) async throws {
        let (bytes, resp) = try await session.bytes(for: Self.request(base, "events?phone=1", token))
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 { throw Removed() }
        guard code == 200 else { throw URLError(.badServerResponse) }
        var event = ""
        for try await line in bytes.lines {
            if line.hasPrefix("event: ") {
                event = String(line.dropFirst(7))
            } else if line.hasPrefix("data: "),
                      let json = try? JSONSerialization.jsonObject(with: Data(line.dropFirst(6).utf8)) as? [String: Any] {
                if event == "state" { take(state: json) } else if event == "log" { take(log: json) }
            }
        }
    }

    private func take(state: [String: Any]) {
        boards = Board.merge(profiles: state["profiles"] as? [[String: Any]] ?? [], live: state["boards"] as? [[String: Any]] ?? [])
        updated = Date()
        if updated! > cachedAt.addingTimeInterval(5) {  // ponytail: a job ticks state several times a second; save every 5 s at most
            Store.cache = Cache(at: updated!, boards: boards)
            cachedAt = updated!
        }
    }

    private func take(log: [String: Any]) {
        for (port, lines) in log {
            let have = logs[port] ?? []
            let last = have.last?.n ?? 0  // a reconnect resends the backlog
            let fresh = (lines as? [[String: Any]] ?? []).map(LogLine.init).filter { $0.n > last }
            logs[port] = Array((have + fresh).suffix(400))
        }
    }

    nonisolated static func request(_ base: URL, _ path: String, _ token: String, post: Bool = false) -> URLRequest {
        var req = URLRequest(url: URL(string: "/api/" + path, relativeTo: base)!.absoluteURL)
        req.httpMethod = post ? "POST" : "GET"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(device, forHTTPHeaderField: "X-eBench-Phone")
        return req
    }
}

/// Accepts the Mac only if its certificate's SHA-256 matches the pin from the pairing code.
final class Pinned: NSObject, URLSessionDelegate {
    let pin: String

    init(pin: String) { self.pin = pin }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            return completionHandler(.performDefaultHandling, nil)
        }
        let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
        let hash = leaf.map { SHA256.hash(data: SecCertificateCopyData($0) as Data).map { String(format: "%02x", $0) }.joined() }
        if hash == pin {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}

/// Where the pairing lives: the Mac in UserDefaults, the token in the Keychain (this device only,
/// never in backups), and the offline copy in a file that's locked while the phone is.
enum Store {
    static var mac: Mac? {
        get { UserDefaults.standard.data(forKey: "mac").flatMap { try? JSONDecoder().decode(Mac.self, from: $0) } }
        set { UserDefaults.standard.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "mac") }
    }

    private static let item: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: "mac-token"]

    static var token: String? {
        get {
            var out: CFTypeRef?
            let query = item.merging([kSecReturnData as String: true]) { $1 }
            guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            SecItemDelete(item as CFDictionary)
            guard let newValue else { return }
            let add = item.merging([kSecValueData as String: Data(newValue.utf8),
                                    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { $1 }
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    private static var cacheFile: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appending(path: "boards.json")
    }

    static var cache: Cache? {
        get { (try? Data(contentsOf: cacheFile)).flatMap { try? JSONDecoder().decode(Cache.self, from: $0) } }
        set {
            guard let newValue, let data = try? JSONEncoder().encode(newValue) else {
                try? FileManager.default.removeItem(at: cacheFile)
                return
            }
            try? data.write(to: cacheFile, options: [.atomic, .completeFileProtection])
        }
    }
}

extension Data {
    /// base64url without padding, as Python's urlsafe_b64encode(...).rstrip("=") makes it.
    init?(base64URL s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b += String(repeating: "=", count: (4 - b.count % 4) % 4)
        self.init(base64Encoded: b)
    }
}
