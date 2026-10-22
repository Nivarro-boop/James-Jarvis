# Was wirklich geprüft ist – und was noch ein Gerät braucht

Das neue Tages-Board, deklarative Feature-Packs und die isolierte Wiederherstellung werden nicht nur gegen eine simulierte Schnittstelle getestet: `scripts/check-workspace-integration.cjs` startet die gebaute App in echtem Electron mit einem Wegwerfprofil. Es verwendet keine persönlichen Konten, keine geerbten API-Schlüssel und kein künstliches Mikrofon.

## App und lokale Integrationen

| Bereich | Nachweis | Grenze |
|---|---|---|
| App-Start, Preload, IPC | Echter Electron-Lauf mit isolierten Einstellungen | Kein installierter Release/Installer |
| Einrichtungsrolle | Auswahl vor KI-Zugang; explizites Speichern über echte UI/IPC; Rollenwert auf Platte und Systemprompt prüfen | Die Rolle erteilt keine Kalenderrechte, verbindet keine Konten und startet keine Hintergrundabfragen |
| IPC-Vertrauensgrenze | Fremdes Electron-Fenster mit echter Preload-Brücke wird abgewiesen | Ergänzt die bestehende Hauptframe- und Navigationsprüfung |
| Erinnerungen | Erstellen und Erledigen über echte IPC und Datenbank | Kein fälliges Erinnerungsaudio über einen physischen Lautsprecher |
| Aufgaben | Über echte UI anlegen und abhaken; lokale Datei prüfen | Keine Synchronisierung zu einem externen Aufgabenanbieter |
| Widget-Board | Über echte UI nach oben verschieben, ausblenden, wiederherstellen; persistierte Anordnung prüfen | Drag-and-drop ergänzt die getestete Tastatur-/Button-Alternative |
| Kalender | Opt-in/Opt-out in echter UI; ohne Konten getrennte „nicht eingerichtet“-Zustände | Google-/iCal-Daten, Quellenfehler, DST und Opt-out-Rennen zusätzlich mit Fixtures getestet; kein echtes Kalenderkonto |
| Feature-Packs | Berechtigungsannahme, Installation, lokaler Checklistenstatus, Deaktivierung und Entfernung über echte IPC | Keine ausführbaren Fremdplugins und kein öffentlicher Marktplatz |
| Backup und Recovery | Echtes Backup, Integritätsvorschau, digestgebundene Erstellung; Originalprofil bleibt bytegleich | Aktuelles Format v1 ist ausdrücklich kein vollständiges Profilabbild |
| Recovery-Start | Neues Profil wirklich starten; eigene Profiladresse, Pause, deaktivierte Eingabe und Orb; Tools, Einstellungen, Kalender und Live-Secrets werden abgeblockt | Der bestätigte Rückweg ist implementiert; kein automatischer Austausch des aktiven Profils |
| Schmale App | Echte 520-Pixel-Ansicht ohne horizontalen Überlauf oder Kopfzeilen-Überlappung | Kein physischer Telefonbrowser |
| Alexa | Lokale Regressionen für gleichzeitige/replayte Anfragen, persistentes Neustart-Journal und unklare Tool-Timeouts | Kein signierter Live-Auftrag eines Echo-Geräts |
| Companion | Lokale HTTP-/TLS-Protokolltests: HTTP nur Loopback, keine Tokens/QR-Verbindung ohne TLS, HTTPS-Transport | Kein physisches Telefon mit vertrauenswürdig installiertem Zertifikat |
| Datentransparenz | Einstellungsabhängige lokale/externe Datenwege einschließlich Fallbacks geprüft | Konfigurationsübersicht, kein Mitschnitt des tatsächlichen Netzwerkverkehrs |

Der lokale Linux-Lauf ist erfolgreich. Die PR-Prüfung führt Regressionen, Typecheck, App-Build und den echten Electron-Lauf zusätzlich auf **Windows und M‑Macs (ARM64)** aus. macOS verwendet `macos-15` mit verpflichtender Architekturprüfung; Intel gehört nicht mehr zur Zielmatrix. Maßgeblich ist das Ergebnis des jeweiligen Betriebssystem-Jobs in [PR #1](https://github.com/Nivarro-boop/James-Jarvis/pull/1/checks); ein Betriebssystem-Runner beweist keine reale Audiohardware, Telefonverbindung oder Anmeldung. Bei fehlender Runner-Kapazität bleibt der M‑Mac-Nachweis offen, statt durch einen Intel-Job ersetzt zu werden.

Der Recovery-Test beendet die Originalinstanz nach dem Import, bevor er das neue Profil startet. So kann deren normaler Selbstheilungsmonitor nicht parallel die Referenzdatei verändern. Die bytegenauen Vergleiche des Originalprofils bleiben sowohl unmittelbar nach der Erstellung als auch nach dem Recovery-Start/-Shutdown bestehen; anschließend wird die Originalinstanz für die weiteren Prüfungen wieder geöffnet.

`npm run dist:mac` ist für ausschließlich ARM64 mit DMG **und dem für Auto-Updates erforderlichen ZIP** sowie `--publish never` vorbereitet. Dieser Befehl wurde hier nicht ausgeführt; weder fertige Mac-Pakete noch Signierung, Notarisierung oder die Installation auf einem physischen M‑Mac sind damit nachgewiesen. Die vorhandenen Windows-/PowerShell-Funktionen werden dadurch nicht automatisch zu macOS-Funktionen.

## Das tatsächlich veröffentlichte Paket

Das aktuell neueste [Release v1.3.9](https://github.com/Nivarro-boop/James-Jarvis/releases/tag/v1.3.9) enthält nur Windows x64. Der Installer samt Blockmap und `latest.yml` wurde wirklich heruntergeladen. Der Prüfer `scripts/check-release-package.cjs <Downloadordner>` vergleicht die offiziellen SHA-256-Digests aus `manifest.json`, beide Update-SHA-512, Größe, Blockmap-Abdeckung, ASAR-Version, HTML-/CSS-Referenzen, externe Helfer und den Windows-x64-Binärheader. Der hiesige Linux-Lauf bestätigt diese statischen Prüfungen, nicht die native Ausführung.

Der zusätzliche CI-Job **published-release** lädt exakt v1.3.9, prüft die fest hinterlegte Installer-SHA-256 **vor dem Auspacken und Ausführen** und startet mit `--native-smoke` die im Originalpaket enthaltene EXE auf einem GitHub-hosted Windows-Runner. Kein neu gebauter Source-Ersatz: Paketversion, Wegwerfprofil, echtes Preload/IPC und sichtbare Startseite werden geprüft. Anbieter-/GitHub-Schlüssel werden nicht an den App-Prozess vererbt; automatische Kontodienste und Modelldownloads sind im Testprofil abgeschaltet. Native Ausführung auf persönlichen oder selbst gehosteten Rechnern lehnt der Prüfer ab. Der aktuelle Jobstatus ist maßgeblich; Bericht und Originalansicht stehen im CI-Artefakt `published-release-1.3.9`.

Der erste native Prüflauf erreichte den Node-Inspector, aber nicht den von Playwright erwarteten Chromium-DevTools-Endpunkt und lief nach 45 Sekunden aus. Das ist **noch kein bestandener Original-EXE-Start**. Der Prüfer fordert die Chromium-Ausgabe nun ausdrücklich auf stderr an, startet im Programmverzeichnis und sichert bei Fehlern ausschließlich Protokolle aus seinem frischen Wegwerfprofil als `release-original-startup.json`, bevor er dieses aufräumt. Assertions und Zeitgrenze bleiben bestehen. Das kleine ASAR-Regressionsfixture wartet zudem auf den tatsächlichen Schreibabschluss des Packers; dessen Promise allein kann noch unvollständige Daten liefern.

Das startet das enthaltene Programm nach kontrolliertem Auspacken; **der NSIS-Installationsassistent samt Registry-, Shortcut- und Uninstall-Verhalten wird nicht ausgeführt**. Die bereits veröffentlichten Dateien werden nicht verändert. Die neuen PR-Funktionen sind dadurch nicht plötzlich Teil des alten Downloads. Für macOS existiert noch kein veröffentlichtes Paket; der reparierte native Update-Handoff und sein asynchroner Fehlerpfad sind mit Lifecycle-Regressionen, nicht durch eine signierte Squirrel-Installation belegt.

## Ehrlich als nicht verfügbar gekennzeichnet

- **Physisches Mikrofon:** Der Sandbox-Lauf meldet `NotFoundError`; es gibt hier kein angeschlossenes Audiogerät. Das zählt nicht als bestandener Mikrofontest.
- **Anbieter-Konto und Live-Sprache:** Keine passenden persönlichen Anbieterzugänge im Testprofil. Keine kostenpflichtige KI-/Audioanfrage wurde ausgelöst. Ein Chat-Abonnement wird nicht mit einem API-Schlüssel verwechselt.
- **Echte Kalender:** Keine Anmeldung, keine privaten Termine geladen, keine Änderungen an Kalendern.
- **Telefonnetz:** Keine freigegebene Zielnummer und keine Carrier-Zugänge. Es wurde kein Anruf getätigt.
- **Alexa/Telefon:** Kein verbundenes Echo und kein physischer Companion-Browser.

## Wiederherstellung ohne falsches Sicherheitsversprechen

Das derzeitige Backup enthält Datenbank, bereinigte Einstellungen und Fertigkeiten. Es enthält **keine** Schlüssel, OAuth-Tokens, Website-Konten oder MCP-Konfigurationen. Arbeitskontext, Widget-Anordnung, separate Aufgaben und installierte Feature-Packs sind ebenfalls noch nicht im aktuellen Backupformat enthalten; die Vorschau nennt diese Ausschlüsse.

Recovery importiert nur validierte lokale Präferenzen in sichere Voreinstellungen. Fertigkeiten liegen als passives Archiv vor. Importierte Zeitpläne bleiben deaktiviert. Das neue Profil startet ohne Sprachcontroller, Kamera-/Mikrofonfreigabe, externe Renderer-Anfragen, Anbieteraufrufe, Telefonie, Hotkeys, automatische Updates oder Downloads. Die ursprüngliche Installation wird nicht überschrieben.

## Selbst laufen lassen

```bash
npm ci
npm test
npm run typecheck
npx --no-install electron-vite build
node scripts/check-workspace-integration.cjs
```

Auf headless Linux: `xvfb-run -a node scripts/check-workspace-integration.cjs`. Befund und Testbilder stehen unter `out/audit/workspace-integration*`, `out/audit/home-clean*` und `out/audit/assistant-role*`. Der Integrationslauf baut keinen Installer, veröffentlicht kein Release und benötigt keine persönlichen Schlüssel.
