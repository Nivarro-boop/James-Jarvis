# Was wirklich geprüft ist – und was noch ein Gerät braucht

Das neue Tages-Board, deklarative Feature-Packs und die isolierte Wiederherstellung werden nicht nur gegen eine simulierte Schnittstelle getestet: `scripts/check-workspace-integration.cjs` startet die gebaute App in echtem Electron mit einem Wegwerfprofil. Es verwendet keine persönlichen Konten, keine geerbten API-Schlüssel und kein künstliches Mikrofon.

## App und lokale Integrationen

| Bereich | Nachweis | Grenze |
|---|---|---|
| App-Start, Preload, IPC | Echter Electron-Lauf mit isolierten Einstellungen | Kein installierter Release/Installer |
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

Der lokale Linux-Lauf ist erfolgreich. Die PR-Prüfung führt Regressionen, Typecheck, App-Build und den echten Electron-Lauf zusätzlich auf **Windows und macOS** aus. Maßgeblich ist das Ergebnis des jeweiligen Betriebssystem-Jobs in [PR #1](https://github.com/Nivarro-boop/James-Jarvis/pull/1/checks); ein Betriebssystem-Runner beweist keine reale Audiohardware, Telefonverbindung oder Anmeldung.

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

Auf headless Linux: `xvfb-run -a node scripts/check-workspace-integration.cjs`. Befund und Testbilder stehen unter `out/audit/workspace-integration*`. Der Integrationslauf baut keinen Installer, veröffentlicht kein Release und benötigt keine persönlichen Schlüssel.
