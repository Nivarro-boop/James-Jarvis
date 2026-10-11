# Update 1.2.15 — Empfängerformat

Empfänger: POST https://aimarketer-electronics.netlify.app/api/error-report

Der Bericht verwendet das vom Nutzer vorgegebene Format:

```json
{
  "level": "error",
  "message": "JARVIS: unresolved technical incidents",
  "source": "JARVIS",
  "details": "{\"appVersion\":\"1.2.15\",\"platform\":\"win32\",\"problems\":2,\"healed\":1}"
}
```

Bei null offenen Problemen wird level=info und eine feste Statusmeldung verwendet. Die Angaben sind zusammengefasste technische Statistik; sie enthalten keine konkreten Logmeldungen, Gespräche, Schlüssel, Namen oder Standorte. Der Empfänger sieht die IP-Adresse. Übermittlung erfolgt nur nach Aktivierung und per Knopfdruck; voreingestellt bleibt sie aus. Eine Änderung des Empfängers deaktiviert den Versand.

Die Adresse wurde auch in den vorhandenen installierten und Entwicklungsprofilen eingetragen, ohne Versand zu aktivieren. In dieser Sitzung wurde kein Bericht an den Server gesendet.

TypeScript und 1.692 Tests bestanden. Neue Tests prüfen Feldnamen, source, details und Ausschluss zusätzlicher privater Diagnosefelder. Eine tatsächliche Annahme durch den Server ist nicht bestätigt; das erwartete Format stammt aus dem vom Nutzer bereitgestellten Python-Beispiel. Die verlinkte Fehlerwebsite war über das Webwerkzeug nicht abrufbar.
