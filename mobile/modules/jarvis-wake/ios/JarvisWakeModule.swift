import Darwin
import ExpoModulesCore

/// Wake-on-LAN: sechsmal 0xFF, dann sechzehnmal die MAC, per UDP an Port 9.
///
/// Zwei Ziele, weil iOS das eine oft sperrt: Broadcast verlangt seit iOS 14 die
/// Berechtigung `com.apple.developer.networking.multicast`, die Apple einzeln
/// freigibt. Ohne sie scheitert `sendto` mit EPERM. Der direkte Versand an die
/// letzte Adresse des Rechners braucht keine Freigabe und genügt meist, solange
/// der Router den Rechner noch kennt.
public final class JarvisWakeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("JarvisWake")

    AsyncFunction("wake") { (mac: String, broadcast: String, address: String) in
      let packet = try magicPacket(mac: mac)
      var failures: [String] = []
      var delivered = false
      for target in [broadcast, address] where !target.isEmpty {
        do {
          // Dreimal, denn UDP verspricht nichts.
          for _ in 0..<3 { try send(packet, to: target) }
          delivered = true
        } catch let error as WakeException {
          failures.append(error.reason)
        }
      }
      if !delivered {
        throw WakeException(failures.isEmpty ? "Kein Ziel bekannt." : failures.joined(separator: " "))
      }
    }
  }
}

final class WakeException: GenericException<String> {
  override var reason: String { param }
}

func magicPacket(mac: String) throws -> [UInt8] {
  let hex = mac.replacingOccurrences(of: "[:\\-. ]", with: "", options: .regularExpression)
  guard hex.count == 12, hex.allSatisfy({ $0.isHexDigit }) else {
    throw WakeException("Die MAC-Adresse \(mac) ist ungültig.")
  }
  var bytes: [UInt8] = []
  var index = hex.startIndex
  for _ in 0..<6 {
    let next = hex.index(index, offsetBy: 2)
    bytes.append(UInt8(hex[index..<next], radix: 16)!)
    index = next
  }
  var packet = [UInt8](repeating: 0xFF, count: 6)
  for _ in 0..<16 { packet += bytes }
  return packet
}

func send(_ packet: [UInt8], to host: String) throws {
  var addr = sockaddr_in()
  addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
  addr.sin_family = sa_family_t(AF_INET)
  addr.sin_port = in_port_t(9).bigEndian
  guard inet_pton(AF_INET, host, &addr.sin_addr) == 1 else {
    throw WakeException("\(host) ist keine IPv4-Adresse.")
  }

  let fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
  guard fd >= 0 else { throw WakeException("Kein Netzsockel (errno \(errno)).") }
  defer { close(fd) }

  var on: Int32 = 1
  setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &on, socklen_t(MemoryLayout<Int32>.size))

  let sent = packet.withUnsafeBytes { buffer in
    withUnsafePointer(to: &addr) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        sendto(fd, buffer.baseAddress, buffer.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
  }
  guard sent == packet.count else {
    let code = errno
    throw WakeException(code == EPERM
      ? "iOS sperrt den Versand an \(host) (fehlende Netzwerk-Berechtigung)."
      : "Senden an \(host) fehlgeschlagen (errno \(code)).")
  }
}
