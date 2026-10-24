import Foundation
import WatchConnectivity
import Security

/// Native relay: Watch → paired iPhone → the authenticated James server.
/// Credentials remain in the iPhone Keychain and are never sent to the Watch.
final class WatchRelay: NSObject, WCSessionDelegate {
  static let shared = WatchRelay()
  private let queue = DispatchQueue(label: "dev.void.jarvis.watch")
  private var socket: URLSessionWebSocketTask?
  private var generation = 0
  private var pairing: String?
  private var wakeTarget = UserDefaults.standard.dictionary(forKey: "JamesWatchWake") as? [String: String]
  private var last: [String: Any] = ["t": "availability", "ready": false]
  private var audio = Data()
  private var audioInFlight = 0
  private var heartbeat: DispatchSourceTimer?
  private var lastHeard = Date()
  private let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "dev.void.jarvis.watch-relay", kSecAttrAccount as String: "pairing"]

  override init() {
    super.init()
    var query = key
    query[kSecReturnData as String] = true
    var value: CFTypeRef?
    if SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess,
       let data = value as? Data { pairing = String(data: data, encoding: .utf8) }
    if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
  }

  func configure(_ link: String?) throws {
    if let link { _ = try socketURL(link) }
    if pairing == link { return }
    if let link {
      var item = key
      item[kSecValueData as String] = Data(link.utf8)
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let updates: [String: Any] = [kSecValueData as String: Data(link.utf8)]
      let updated = SecItemUpdate(key as CFDictionary, updates as CFDictionary)
      let saved = updated == errSecItemNotFound ? SecItemAdd(item as CFDictionary, nil) : updated
      guard saved == errSecSuccess else {
        throw NSError(domain: "JamesWatch", code: 1, userInfo: [NSLocalizedDescriptionKey: "Watch-Kopplung konnte nicht sicher gespeichert werden."])
      }
    } else { SecItemDelete(key as CFDictionary) }
    UserDefaults.standard.removeObject(forKey: "JamesWatchWake")
    queue.async {
      self.pairing = link
      self.wakeTarget = nil
      self.disconnect()
      if WCSession.default.isReachable { self.ensureConnection() }
    }
  }

  func status() -> [String: Any] {
    guard WCSession.isSupported() else { return ["supported": false] }
    let session = WCSession.default
    return ["supported": true, "paired": session.isPaired, "installed": session.isWatchAppInstalled,
      "reachable": session.isReachable, "configured": pairing != nil]
  }

  private func socketURL(_ link: String) throws -> URL {
    guard var parts = URLComponents(string: link), parts.scheme == "https", parts.host != nil,
          parts.user == nil, parts.password == nil,
          let fragment = parts.fragment,
          let params = URLComponents(string: "https://pair.invalid/?" + fragment)?.queryItems,
          let token = params.first(where: { $0.name == "token" })?.value, !token.isEmpty,
          let host = params.first(where: { $0.name == "host" })?.value,
          host.lowercased() == (parts.host! + (parts.port.map { ":\($0)" } ?? "")).lowercased() else {
      throw NSError(domain: "JamesWatch", code: 2, userInfo: [NSLocalizedDescriptionKey: "Für die Watch zuerst einen gültigen HTTPS-Kopplungscode scannen."])
    }
    parts.scheme = "wss"; parts.path = "/ws/phone"; parts.fragment = nil
    parts.queryItems = [URLQueryItem(name: "token", value: token)]
    guard let url = parts.url else { throw URLError(.badURL) }
    return url
  }

  private func disconnect() {
    generation += 1
    heartbeat?.cancel(); heartbeat = nil
    socket?.cancel(with: .goingAway, reason: nil); socket = nil
    audio.removeAll(); audioInFlight = 0
    publish(["t": "availability", "ready": false])
  }

  private func ensureConnection() {
    guard socket == nil else { return }
    guard let pairing, let url = try? socketURL(pairing) else {
      publish(["t": "error", "message": "James auf dem iPhone öffnen und den Rechner koppeln."])
      return
    }
    let task = URLSession.shared.webSocketTask(with: url)
    socket = task; lastHeard = Date(); task.resume()
    let current = generation
    receive(task, current)
    send(["t": "hello", "name": "Apple Watch"])
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 15, repeating: 15)
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      if Date().timeIntervalSince(self.lastHeard) > 45 { self.disconnect(); self.ensureConnection() }
      else { self.send(["t": "ping"]) }
    }
    heartbeat = timer; timer.resume()
  }

  private func send(_ message: [String: Any], completion: ((Error?) -> Void)? = nil) {
    guard let task = socket, let data = try? JSONSerialization.data(withJSONObject: message), let text = String(data: data, encoding: .utf8) else {
      completion?(URLError(.notConnectedToInternet)); return
    }
    task.send(.string(text)) { error in completion?(error) }
  }

  private func receive(_ task: URLSessionWebSocketTask, _ current: Int) {
    task.receive { result in self.queue.async {
      guard self.socket === task, self.generation == current else { return }
      switch result {
      case .failure:
        self.disconnect()
        self.publish(["t": "error", "message": "Rechner nicht erreichbar. WLAN und Zertifikat auf dem iPhone prüfen."])
      case .success(let message):
        self.lastHeard = Date()
        switch message {
        case .string(let text):
          if let data = text.data(using: .utf8), let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            if value["t"] as? String == "wake" {
              self.wakeTarget = ["mac": value["mac"] as? String ?? "", "broadcast": value["broadcast"] as? String ?? "", "address": value["address"] as? String ?? ""]
              UserDefaults.standard.set(self.wakeTarget, forKey: "JamesWatchWake")
            } else if value["t"] as? String != "pong" {
              if value["t"] as? String == "state", value["state"] as? String != "speaking" { self.flushAudio(current) }
              self.publish(value)
            }
          }
        case .data(let bytes):
          if bytes.first == 2, bytes.count % 2 == 1 {
            self.audio.append(bytes.dropFirst())
            if self.audio.count >= 9600 { self.flushAudio(current) }
          }
        @unknown default: break
        }
        self.receive(task, current)
      }
    } }
  }

  private func flushAudio(_ current: Int) {
    guard WCSession.default.isReachable else { audio.removeAll(); return }
    // Small, bounded packets; never queue a whole spoken answer in WCSession.
    while !audio.isEmpty && audioInFlight < 6 {
      let count = min(12000, audio.count)
      var packet = Data([2]); packet.append(audio.prefix(count)); audio.removeFirst(count)
      audioInFlight += 1
      WCSession.default.sendMessageData(packet, replyHandler: { _ in self.queue.async {
        guard self.generation == current else { return }
        self.audioInFlight -= 1; self.flushAudio(current)
      } }, errorHandler: { _ in self.queue.async {
        guard self.generation == current else { return }
        self.audioInFlight -= 1; self.audio.removeAll()
      } })
    }
    if audio.count > 24000 * 2 * 8 { audio.removeAll(); publish(["t": "error", "message": "Watch-Ton konnte nicht schnell genug übertragen werden."]) }
  }

  private func publish(_ value: [String: Any]) {
    let session = WCSession.default
    guard session.activationState == .activated else { return }
    if value["t"] as? String == "state" {
      last = value
      try? session.updateApplicationContext(last)
    } else if value["t"] as? String == "availability", value["ready"] as? Bool != true {
      last = ["t": "state", "state": "offline", "paused": false]
      try? session.updateApplicationContext(last)
    }
    if session.isReachable { session.sendMessage(value, replyHandler: nil, errorHandler: { _ in }) }
  }

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    queue.async { if session.isReachable { self.ensureConnection() } }
  }
  func sessionDidBecomeInactive(_ session: WCSession) { queue.async { self.disconnect() } }
  func sessionDidDeactivate(_ session: WCSession) { session.activate() }
  func sessionReachabilityDidChange(_ session: WCSession) {
    queue.async { if session.isReachable { self.ensureConnection() } else { self.disconnect() } }
  }
  func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    queue.async {
      let type = message["t"] as? String ?? ""
      if type == "status" { self.ensureConnection(); replyHandler(self.last); return }
      if type == "wake" {
        guard let target = self.wakeTarget, let packet = try? magicPacket(mac: target["mac"] ?? "") else {
          replyHandler(["t": "error", "message": "Zum Wecken zuerst einmal mit dem Rechner verbinden."]); return
        }
        var delivered = false
        for address in [target["broadcast"], target["address"]].compactMap({ $0 }) {
          if (try? sendWakePacket(packet, to: address)) != nil { delivered = true }
        }
        replyHandler(["t": "note", "text": delivered ? "Weckpaket gesendet. Verbinde gleich erneut." : "Wecken fehlgeschlagen."]); return
      }
      guard type == "text" || type == "press" || type == "pause" else { replyHandler(["t": "error", "message": "Unbekannter Befehl."]); return }
      var command: [String: Any] = ["t": type]
      if type == "text" {
        guard let text = message["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 8000 else {
          replyHandler(["t": "error", "message": "Nachricht ist leer oder zu lang."]); return
        }
        command["text"] = text; command["requestId"] = message["requestId"] as? String ?? UUID().uuidString
      }
      if type == "pause" { guard let paused = message["paused"] as? Bool else { replyHandler(["t": "error", "message": "Ungültige Pause."]); return }; command["paused"] = paused }
      self.ensureConnection()
      self.send(command) { error in replyHandler(error == nil ? ["t": "note", "text": "An James übergeben …"] : ["t": "error", "message": "Senden fehlgeschlagen. Erneut versuchen."]) }
    }
  }
}
