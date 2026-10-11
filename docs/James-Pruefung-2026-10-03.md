# James: Prüfung und Verbesserungen vom 3. Oktober 2026

Geprüft wurde Commit `c06a8bf` einschließlich der bestehenden lokalen Änderung
in `src/renderer/settings/sections.tsx`. Diese Änderung wurde erhalten. Die
folgenden Korrekturen liegen lokal; es wurde nichts veröffentlicht.

## Verifikation des abschließenden Stands

| Prüfung | Ergebnis |
|---|---|
| Typprüfung | bestanden |
| Vollständige Testsuite | 1.603 Tests, 417 Suites, 0 Fehler, 0 übersprungen |
| Produktionsbuild | bestanden |
| Windows-NSIS-Installer | gebaut, `dist/Void James Setup 1.2.0.exe`, nicht signiert |
| Echter Electron-Start im isolierten Profil | bestanden: Einrichtung, Anbieterwahl, Abo-Anmeldestatus, Schlüsselübersicht, IPC-Validierung |
| Installer-Archiv | Main enthalten; Test-/Audit-Ausgaben und nut.js ausgeschlossen |
| Produktionsabhängigkeiten, `npm audit --omit=dev` | 0 bekannte Paketmeldungen |
| Gesamte Abhängigkeiten, `npm audit` | 8 hohe Paketmeldungen im Build-Werkzeugpfad verbleiben |

Prüfprotokolle liegen lokal in `out/audit/`. Der Electron-Test hat Mikrofonrechte
absichtlich verweigert und ein eigenes Profil benutzt. Die protokollierte
Mikrofon-Ablehnung sowie die Fehlermeldung für `audio: null` waren erwartete
Testfälle. Der Test prüft die echte Oberfläche über DOM und Preload/IPC,
aber ersetzt keine Sprachprobe. Versteckte Fenster lieferten teils verzögerte
Screenshots; diese sind keine abschließende visuelle Abnahme.

## Behobene Fehler und Bereinigung

1. **Bestätigungen:** Sachfremde Antworten wie „Wie spät ist es?“ gaben zuvor
   eine Aktion frei. Jetzt ist eine ausdrückliche, eigenständige Zustimmung
   erforderlich. Fragen, Einschränkungen und Verneinungen geben nichts frei.
   Argumentbindung, neuer Nutzerbeitrag und einmaliger Verbrauch sind getestet.
2. **Recherchebudget:** Geschätzte Kosten werden beim Start synchron verbucht.
   Laufende Aufträge zählen dadurch gegen die nächste Freigabe. Bei Abbruch
   bleiben Schätzungen konservativ bestehen, weil beim Anbieter Kosten
   entstanden sein können. Dies ist weiterhin kein vollständiger API-Verbrauch.
3. **Recherche-Not-Aus:** Das AbortSignal erreicht die SDK-Anfrage. Eine bekannte
   Interaktions-ID wird für eine serverseitige Stornierung verwendet; Fehler
   dabei werden protokolliert. Nach Abbruch erfolgt keine Ergebnisdurchsage.
   Eine echte Anbieter-Stornierung wurde nicht praktisch bestätigt.
4. **Mikrofonpause:** Stilllegen gibt den Capture-Stream frei. Gerätewechsel
   und verspäteter Capture-Aufbau können die Aufnahme während der Pause nicht
   wieder öffnen. Wiederaufnahme öffnet den Stream neu.
5. **Realtime-Lebenszyklus:** Aufbau-Wachhund, begrenzte Wiederholungen,
   Sitzungs-ID gegen alte Ergebnisse, abgefangene Konfigurations-/Werkzeugfehler
   und sichere Trennung alter Audio-Player beim Stop/Start. Drei neue Tests
   prüfen diese Abläufe mit deterministischen Sockets und Audio-Ersatz.
6. **Cloud-Fristen:** Direkte OpenAI-/Anthropic-Textanfragen und die
   Realtime-Tokenanfrage haben Zeitgrenzen.
7. **Geheimnisspeicher:** Verschlüsselte Daten werden über eine temporäre Datei
   atomar ersetzt. Der Cache wird erst nach erfolgreichem Schreiben geändert.
   Unlesbare Originale werden vor einem Ersetzen gesichert. Ein simulierter
   Dateisystemfehler prüft, dass ein fehlgeschlagener Schlüsselwechsel nicht
   als erfolgreich im Cache erscheint.
8. **Einstellungen:** Laufzeitprüfung für Typen, Auswahlwerte und wesentliche
   Wertebereiche; gefährliche Merge-Schlüssel werden abgewiesen. Einstellungen
   werden erst nach erfolgreicher Persistenz zum aktuellen Stand.
9. **Einrichtung:** Auswahl zwischen Gemini, OpenAI API und ChatGPT-Abo.
   OpenAI-Schlüssel werden vor dem Speichern geprüft; dies beweist noch keinen
   Zugriff auf jedes Realtime-Modell. Fertigstellung wartet auf das Speichern.
   Der Abo-Weg installiert auf Nutzerklick lokale Sprachkomponenten und prüft
   Whisper/Piper vor dem Weitergehen.
10. **Abo/API-Oberfläche:** Gemeinsame Anmeldekomponente, Kontomodell-Auswahl,
    abgefangene Anmeldefehler und Link zu den offiziellen Nutzungslimits.
    „OpenAI Realtime“ ist eindeutig als separate API-Abrechnung beschriftet.
11. **Bereinigung:** Unbenutzter optionaler nut.js-Zweig einschließlich nativer
    Adapter entfernt; Windows-Steuerung bleibt über PowerShell vorhanden.
    117 Pakete wurden bei dessen Entfernung deinstalliert. Ein leerer
    `front-desk/public`-Rest wurde entfernt. Tests und Audit-Artefakte landen
    nicht mehr im Installer. Nutzerdaten und bestehende Features wurden erhalten.
12. **Abhängigkeiten und Dokumentation:** Kompatible Sicherheitsupdates
    eingespielt, README/Einrichtung korrigiert. Das Weckwort-Skript meldet einen
    fehlenden Klassifikator ausdrücklich statt fälschlich Erfolg zu versprechen.

## ChatGPT-Anmeldung, Kontingent und Sprache

Die lokale Anmeldung ist implementiert und auch in lokalen paketierten
Installationen aktiviert. Sie verwendet den offiziellen Browser-OAuth-Weg
mit PKCE, State, Nonce, Tokenprüfung und verschlüsselter Ablage. James kopiert
keine Browser- oder Codex-Tokens. Kommerzielle Distributionen werden mit
`JARVIS_CHATGPT_DISTRIBUTION=commercial` gekennzeichnet und brauchen eine
genehmigte `oaiapp_`-Client-Registrierung.

**Einrichten:** ChatGPT-Abo wählen → Continue with ChatGPT → im Browser selbst
anmelden und freigeben → verfügbares Kontomodell wählen → lokale Ohren und
Stimme herunterladen → Prüfen und weiter. Im geprüften Testprofil war die
Anmeldung freigeschaltet, aber kein Konto verbunden. Eine echte Anmeldung,
Refresh-Token-Runde und Plan-Inferenz wurden nicht durchgeführt.

Geeignete Responses-Textanfragen können das ChatGPT-Plan-Kontingent verwenden.
OpenAI setzt die Limits durch. James zeigt keine erfundenen lokalen
Prozentwerte; Verbrauch/Freigaben werden über
[ChatGPT-Nutzung](https://chatgpt.com/settings/usage) verwaltet. Der Code
behandelt Konto-/Kontingentfehler und streamt mit `store: false`.

Die Preview unterstützt keine Audioeingaben oder Transkription über diesen
Abo-Weg. Deshalb verwendet die Abo-Sprachunterhaltung lokal Whisper für die
Ohren und Piper für die Stimme, mit ChatGPT als Text-Denkmotor. Dies ist eine
Unterhaltung in einzelnen Beiträgen. Natives OpenAI Realtime-Audio benötigt
einen separat abgerechneten API-Schlüssel. Auch dieser echte Audioweg ist
noch nicht mit einem Konto und Mikrofon getestet.

Quellen: [Anmeldung](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[lokale Apps und Vertrieb](https://developers.openai.com/siwc/token-sharing-open-source),
[Preview-Grenzen](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Verbleibende Punkte, nach Priorität

1. **Praktischer Konto- und Gerätetest:** Browser-Anmeldung/Abmeldung,
   Kontomodell-Inferenz, Neustart, Audioein-/ausgabe, Dazwischenreden,
   Stilllegen mit Windows-Mikrofonanzeige, Offline/Online und Headsetwechsel.
   Externe Konten, SIP/Twilio, Companion auf dem Telefon und der installierte
   Updater sind ebenfalls nicht Ende zu Ende bestätigt.
2. **Weckwort:** `hey_james.onnx` fehlt im Checkout und im Installer.
   `npm run wakeword` lädt nur die gemeinsamen Vorstufen. Klassifikator
   trainieren/bereitstellen und anschließend Modellladen im installierten
   Electron sowie Erkennung/Fehlalarme prüfen. Der Starttest meldet derzeit
   „Modelle nicht geladen“. Klick und Hotkey sind der verfügbare Weg.
3. **Build-Abhängigkeiten:** Die acht verbleibenden hohen Meldungen hängen
   transitiv an `http-cache-semantics` über `cacheable-request`, `got`,
   `@electron/get` und electron-builder. Zum Prüfzeitpunkt gab es keine
   gepatchte Version von `http-cache-semantics`. Der Audit-Vorschlag würde
   electron-builder zurückstufen; kein ungeprüftes Force-Downgrade vorgenommen.
4. **Releases:** Codesignatur und separaten Testkanal einrichten. Ein
   erfolgreich gebauter Installer ist noch keine erfolgreiche Installation
   oder ein bestätigter Update-Durchlauf. Es wurde kein Release veröffentlicht.
5. **Datensicherung:** Datenexport, automatische Backups und einstellbare
   Aufbewahrung für Gesprächsabschriften/Aktionsprotokolle ergänzen.
6. **Diagnose:** Gewählten und tatsächlich aktiven Sprachmotor sowie Fallback
   sichtbar machen. Datenstrukturen wie MCP-Server noch vollständiger
   validieren; die neue Einstellungsprüfung deckt nicht jedes fachliche Feld ab.
7. **Leistung:** Renderer-Bündel liegt bei rund 512 kB. Weitere Aufteilung erst
   nach Messung von Startzeit und Speicher priorisieren.

Eine pauschale Aussage „alles fehlerfrei“ wäre durch diese Prüfung nicht
belegt. Die konkret gefundenen Fehler wurden korrigiert; die verbleibenden
Punkte sind oben ausdrücklich benannt.
