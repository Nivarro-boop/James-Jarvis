# Orb, Geräte und Anmeldung – Update 1.3.11

Stand: 24.10.2026. Windows-Ausgabe gebaut, lokal installiert und gestartet.
Eine geprüfte Profilsicherung wurde vor der Installation erstellt. Quellcode
und Installer wurden nicht öffentlich veröffentlicht.

## Oberfläche und Einstellungen

Der große Orb bleibt in der Mitte, auch nach einer Unterhaltung. Die drei
Schnellzugriff-Kacheln und die dauerhaft sichtbare untere Eingabe entfallen.
Schreiben und Verlauf öffnen sich über den Tastaturknopf oder das Menü;
Entwürfe und die sichere Sendebestätigung bleiben erhalten. Mikrofonpause
bleibt als kleiner Knopf erreichbar. In schmalen oder niedrigen Fenstern
bleibt der Schreibbereich bedienbar.

Die Einstellungen haben acht sichtbare Hauptbereiche statt zwölf. Verbindungen
sind in Konten, iPhone & Watch, Musik, Zuhause, Kontakte und Erweiterungen
aufgeteilt. Persönlichkeit, lokale Ersatzmodelle, Netzwerk und zusätzliche
Sprachmodelle sind aufklappbar. Bisherige Sprungziele bleiben über die Suche
und direkte Verweise erreichbar.

Auch das iPhone zeigt einen großen Orb. Der Verlauf öffnet sich auf Wunsch.
Die Desktop-Kopplung erzeugt einen gemeinsamen QR-Code für Safari und die
native iPhone-Hülle. Der widersprüchliche zweite Code auf eine fremde Web-App
wurde entfernt. Kamera- und Speicherfehler beim nativen Scannen werden gemeldet.

[Desktop](screenshots/update-1.3.11/desktop.png) ·
[iPhone](screenshots/update-1.3.11/iphone.png) ·
[Einstellungen](screenshots/update-1.3.11/settings.png)

Die Desktop-Aufnahmen stammen aus isolierten Testprofilen ohne Konto.

## ChatGPT bei Remote Play

OpenAIs offizieller Ablauf verwendet einen lokalen HTTP-Rückkanal. Wird der
Anmeldebrowser auf einem anderen Gerät geöffnet, erreicht dessen Rückleitung
an 127.0.0.1 den James-Rechner nicht.

Während einer Anmeldung kann der Anmeldelink jetzt kopiert und die vollständige
Rückleitungsadresse in James eingefügt werden. Nur Adresse und Port des offenen
Versuchs sowie dessen State werden angenommen; der normale Code-Austausch mit
PKCE und die ID-Token-Prüfung laufen anschließend unverändert auf dem Rechner.
Nach Abschluss oder Abbruch ist der Rückweg ungültig. Die kopierbare URL enthält
kein ID-Token-Hint. Ein fehlgeschlagener Browserstart lässt den manuellen Weg offen.

Bedienung: **Stimme & Modelle → ChatGPT-Abo → Continue with ChatGPT**.
Bei Remote Play den eingeblendeten Bereich öffnen, Link kopieren und am Ende
die komplette Callback-Adresse aus der Browser-Adresszeile übernehmen.
Ein echter Konto-Login mit der Freigabe des Nutzers wurde hier nicht durchgeführt.

Referenz: [OpenAI: Registrierung und Anmeldung](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

## Computersteuerung und Abhängigkeiten

Wartezeiten reagieren unmittelbar auf Abbruch. Nach dem Bewegen zur Eingabe
wird ein Abbruch vor dem folgenden Klick beziehungsweise Tippen erneut geprüft.
Gehaltene Maustasten werden beim Ende eines Computerauftrags freigegeben;
ungültige numerische Aktionswerte werden vor der Ausführung zurückgewiesen.

Kompatible Sicherheitsupdates unter anderem für Electron, MCP-SDK, Vite und
Zod sind im Lockfile und in den Mindestversionen übernommen. Das npm-Audit
des Desktopprojekts meldet **0 Schwachstellen**.

## Native Apple Watch

Implementiert unter `mobile/targets/watch/` und
`mobile/modules/jarvis-wake/ios/WatchRelay.swift`:

- Native SwiftUI-App mit Orb und Status, Systemeingabe mit Diktat, Gespräch,
  Pause, Wecken und einschaltbarer Audioausgabe.
- Das iPhone vermittelt per WatchConnectivity und eigenem authentifizierten
  WebSocket zum Rechner. Der Server-Zugang bleibt im iPhone-Schlüsselbund;
  er wird nicht auf die Watch kopiert.
- Gesicherte Sendebestätigung und erhaltener Entwurf; begrenzte Audiopuffer,
  Wiederverbindung und gespeichertes Weckziel.
- Der Expo-Config-Plugin erzeugt das watchOS-Ziel außerhalb generierter iOS-Dateien.
  Die Expo-Konfiguration erkennt `dev.void.jarvis.phone.watch` als Apple-Ziel.

**Noch nicht gebaut oder am Gerät bestätigt:** Swift-Übersetzung, signiertes
Archiv, Installation, Watch-Ton/Routing und Wecken auf echten Apple-Geräten.
Windows kann das iOS-/watchOS-Projekt hier nicht nativ bauen. Apple-Team-ID
und Expo/EAS-Projekt-ID sind im Projekt noch nicht hinterlegt; diese Angaben
wurden angefragt. Die Watch-Erweiterung benötigt einen neuen nativen iPhone-Build.
Sie arbeitet über das gekoppelte iPhone, nicht unabhängig davon.

Auf der Watch wird die Spracheingabe über die Systemtastatur/das Diktat ausgelöst;
es gibt kein dauerhaftes Hintergrundmikrofon. Für Antworten den Lautsprecher
in der Watch-App einschalten. Aufnahme und Ausgabe am echten Gerät bleiben
Teil des ersten Apple-Gerätetests. Das lokale Rechnerzertifikat muss am iPhone
vertraut sein.

Die neuen veralteten Parser-/UUID-Abhängigkeiten des Target-Generators wurden
mit gezielten Overrides korrigiert. Das mobile Buildwerkzeug-Audit enthält
weiterhin sechs hohe Meldungen aus Expo-Abhängigkeiten. Eine erzwungene,
inkompatible Versionsumstellung wurde nicht vorgenommen.

Referenzen: [Apple WatchConnectivity](https://developer.apple.com/documentation/watchconnectivity/wcsession),
[Apple Targets](https://github.com/EvanBacon/expo-apple-targets),
[Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/).

## Verifikation

- 2.104 Desktoptests, vier native Kopplungstests und elf Fehlerbericht-Backendtests
  bestanden: insgesamt **2.119 Tests**.
- Desktop- und Mobile-Typecheck bestanden; Mobile-Lint bestanden.
- Alle sieben bestehenden Desktop-UI-Prüfungen bestanden; zusätzlich eigener
  Remote-Anmelde-Oberflächentest und iPhone-Browserprüfung auf zwei Bildschirmgrößen.
- `expo-doctor`: 20 von 20 Prüfungen bestanden.
- iOS-JavaScript-Bündel exportiert. Das ist kein Swift-Build.
- Produktionsbuild, Windows-Installer und Prüfung der gepackten Dateien bestanden.

Reproduzierbar: `npm test -- --low-resource`, `npm run typecheck`,
`node scripts/check-auth-ui.cjs`, `node scripts/check-phone-ui.cjs`,
`node scripts/check-package.cjs`; im Ordner `mobile`: `npm run lint`,
`npm run typecheck`, `npm test` und `npx expo-doctor`.
