import SwiftUI
import WatchConnectivity
import WatchKit
import AVFoundation

@main
struct JamesWatchApp: App {
  @StateObject private var model = WatchModel()
  var body: some Scene { WindowGroup { JamesWatchView().environmentObject(model) } }
}

struct JamesWatchView: View {
  @EnvironmentObject var model: WatchModel
  @Environment(\.scenePhase) private var phase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var breathe = false
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 12) {
          Button { model.send(["t": "press"]) } label: {
            ZStack {
              Circle().fill(model.tint.opacity(0.12)).frame(width: 136, height: 136)
              Circle().fill(RadialGradient(colors: [.white.opacity(0.9), model.tint, .blue.opacity(0.15)], center: .topLeading, startRadius: 0, endRadius: 120))
                .frame(width: 108, height: 108)
                .shadow(color: model.tint.opacity(0.6), radius: 20)
                .scaleEffect(breathe && !reduceMotion && model.state == "speaking" ? 1.07 : 1)
            }
          }.buttonStyle(.plain).accessibilityLabel("James ansprechen oder unterbrechen")
          Text(model.label).font(.headline)
          if !model.note.isEmpty { Text(model.note).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center) }
          TextField("Sprechen oder schreiben", text: $model.draft)
            .onSubmit { model.submit() }
            .accessibilityLabel("Nachricht diktieren oder schreiben")
          Button(model.sending ? "Wird gesendet …" : "Senden") { model.submit() }
            .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.sending)
          HStack {
            Button { model.send(["t": "pause", "paused": !model.paused]) } label: { Image(systemName: model.paused ? "play.fill" : "pause.fill") }
              .accessibilityLabel(model.paused ? "James fortsetzen" : "James pausieren")
            Button { model.toggleAudio() } label: { Image(systemName: model.audio.enabled ? "speaker.wave.2.fill" : "speaker.slash.fill") }
              .accessibilityLabel(model.audio.enabled ? "Watch-Ton ausschalten" : "Watch-Ton einschalten")
          }
          NavigationLink("Gespräch") {
            List(model.lines) { line in VStack(alignment: .leading, spacing: 6) {
              Text(line.who == "user" ? "Du" : "James").font(.caption2).foregroundStyle(.secondary)
              Text(line.text).font(.caption)
            } }.navigationTitle("Gespräch")
          }
          Button("Neu verbinden") { model.refresh() }
          Button("Rechner wecken") { model.send(["t": "wake"]) }
          Text("Verbunden über dein iPhone").font(.system(size: 9)).foregroundStyle(.secondary)
        }.padding(.horizontal, 4)
      }.navigationTitle("James")
    }
    .onAppear { model.refresh(); withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { breathe = true } }
    .onChange(of: phase) { _, value in
      if value == .active { model.refresh() }
      else { model.audio.flush() }
    }
  }
}

struct WatchLine: Identifiable { let id: Int; let who: String; let text: String }
final class WatchModel: NSObject, ObservableObject, WCSessionDelegate {
  @Published var state = "offline"
  @Published var paused = false
  @Published var note = "James auf dem iPhone öffnen und den Rechner koppeln."
  @Published var draft = ""
  @Published var sending = false
  @Published var lines: [WatchLine] = []
  @Published var sound = false
  let audio = WatchAudio()
  private var pending: (id: String, text: String)?
  private var deadline: DispatchWorkItem?
  var tint: Color { paused || state == "offline" ? .gray : ["thinking", "tool"].contains(state) ? .orange : .cyan }
  var label: String {
    if paused { return "Pausiert" }
    return ["idle": "Bereit für dich", "listening": "Ich höre zu", "speaking": "James spricht", "thinking": "Denke nach", "tool": "Arbeite daran", "research": "Recherchiere", "confirm": "Deine Antwort?", "offline": "Nicht verbunden", "error": "Verbindung prüfen"][state] ?? "Verbinde …"
  }
  override init() {
    super.init()
    WCSession.default.delegate = self
    WCSession.default.activate()
  }
  func refresh() { send(["t": "status"]) }
  func toggleAudio() {
    do { try audio.toggle(); sound = audio.enabled; note = audio.enabled ? "Watch-Ton aktiv" : "Watch-Ton aus" }
    catch { note = "Tonausgabe nicht verfügbar. Audioziel auf der Watch prüfen." }
  }
  func submit() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !sending else { return }
    guard WCSession.default.isReachable else { note = "iPhone nicht erreichbar. Entwurf bleibt erhalten."; return }
    let id = UUID().uuidString
    pending = (id, text); sending = true
    audio.flush()
    send(["t": "text", "text": text, "requestId": id])
    let timeout = DispatchWorkItem { [weak self] in
      guard let self, self.pending?.id == id else { return }
      self.pending = nil; self.sending = false
      self.note = "Keine Bestätigung. Vor erneutem Senden den Verlauf prüfen."
    }
    deadline?.cancel(); deadline = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
  }
  func send(_ message: [String: Any]) {
    guard WCSession.default.activationState == .activated, WCSession.default.isReachable else {
      note = "iPhone nicht erreichbar. James auf dem iPhone öffnen."; return
    }
    if message["t"] as? String == "press" { audio.flush() }
    WCSession.default.sendMessage(message, replyHandler: { value in DispatchQueue.main.async { self.handle(value) } }, errorHandler: { _ in
      DispatchQueue.main.async { self.note = "Verbindung zum iPhone unterbrochen. Bitte erneut versuchen." }
    })
  }
  private func handle(_ value: [String: Any]) {
    switch value["t"] as? String {
    case "state": state = value["state"] as? String ?? "offline"; paused = value["paused"] as? Bool ?? false
    case "availability": if value["ready"] as? Bool != true { state = "offline"; note = "James-Fenster am Rechner öffnen." } else { note = "" }
    case "note": note = String((value["text"] as? String ?? "").prefix(500))
    case "error": note = String((value["message"] as? String ?? "Fehler").prefix(500))
    case "captions":
      let items = value["items"] as? [[String: Any]] ?? []
      lines = items.suffix(30).compactMap { item in
        guard let id = item["id"] as? Int, let who = item["who"] as? String, let text = item["text"] as? String else { return nil }
        return WatchLine(id: id, who: who, text: String(text.suffix(8000)))
      }
    case "text-result":
      guard let current = pending, value["requestId"] as? String == current.id else { return }
      if value["ok"] as? Bool == true { if draft.trimmingCharacters(in: .whitespacesAndNewlines) == current.text { draft = "" }; note = "" }
      else { note = "Nicht gesendet. Dein Entwurf bleibt erhalten." }
      pending = nil; sending = false; deadline?.cancel()
    default: break
    }
  }
  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    DispatchQueue.main.async { self.handle(session.receivedApplicationContext); if session.isReachable { self.refresh() } }
  }
  func sessionReachabilityDidChange(_ session: WCSession) {
    DispatchQueue.main.async { if session.isReachable { self.refresh() } else { self.state = "offline"; self.audio.flush() } }
  }
  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    DispatchQueue.main.async { self.handle(message) }
  }
  func session(_ session: WCSession, didReceiveMessageData messageData: Data, replyHandler: @escaping (Data) -> Void) {
    DispatchQueue.main.async {
      if messageData.first == 2 { self.audio.push(Data(messageData.dropFirst())) }
      replyHandler(Data())
    }
  }
}

/// The PC sends mono PCM16 at 24 kHz. Decode without alignment assumptions.
final class WatchAudio {
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
  private var scheduled = 0
  private var generation = 0
  private(set) var enabled = false
  init() { engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format) }
  func toggle() throws {
    if enabled { enabled = false; flush(); engine.stop(); try? AVAudioSession.sharedInstance().setActive(false); return }
    try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
    try AVAudioSession.sharedInstance().setActive(true)
    try engine.start(); player.play(); enabled = true
  }
  func push(_ data: Data) {
    guard enabled, !data.isEmpty, data.count % 2 == 0 else { return }
    if scheduled > 24000 * 4 { flush() }
    let samples = data.count / 2
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples)), let channel = buffer.floatChannelData?[0] else { return }
    buffer.frameLength = AVAudioFrameCount(samples)
    data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
      for i in 0..<samples { channel[i] = Float(Int16(bitPattern: UInt16(bytes[i * 2]) | UInt16(bytes[i * 2 + 1]) << 8)) / 32768 }
    }
    scheduled += samples
    let current = generation
    player.scheduleBuffer(buffer) { DispatchQueue.main.async { if current == self.generation { self.scheduled = max(0, self.scheduled - samples) } } }
    if !player.isPlaying { player.play() }
  }
  func flush() { generation += 1; player.stop(); scheduled = 0 }
}
