# Umsetzung des Backend-/Frontend-Audits

Stand: 26.10.2026, lokaler Quellstand 1.3.24. Die vorherigen nicht eingecheckten Änderungen wurden erhalten. Dieser Bericht ist der aktuelle Einstieg; Audit und Masterplan beschreiben zum Teil den Zustand vor diesen Reparaturen.

## Fertige Pakete

| Bereich | Änderung und Nachweis |
| --- | --- |
| Berechtigungen | `alwaysAsk` und explizites `ask` greifen auch im autonomen Profil. Explizites `deny` bleibt vorrangig. Normale autonome Aktionen bleiben möglich. |
| Freigaben nach Fehlern | Keine automatische Wiedererteilung nach einem Ausführungsfehler. Unklarer Ausgang wird genannt. Eine neue Rückfrage kann nicht mit dem schon vorher vorhandenen Ja beantwortet werden. Test mit Seiteneffekt und danach verlorener Antwort. |
| Diagnose-Migration | Fehlendes Standortfeld aktiviert keine ausdrücklich abgeschaltete Diagnoseübertragung. Test mit altem Profil und beiden Opt-outs. |
| Projekte | Leere Namen werden abgelehnt, mehrdeutige Suche nennt Treffer. Schreibaktionen brauchen vollständigen Namen oder Kennung; mehrdeutiges Schritt-Abhaken scheitert ohne Speichern. Projektpfade werden validiert. |
| iCloud Drive | Tatsächlich aufgelöste Pfade werden für Lesen/Öffnen geprüft; Junction-Ausbruch wird abgelehnt. Suche überspringt Verknüpfungen und begrenzt auch besuchte Einträge, Zeit und Tiefe. |
| Mailansicht | Anfragegenerationen verhindern veraltete Ordner-/Mailantworten. Ordnerwechsel entwertet alte UIDs. Konto-/Ladefehler sind von leeren Ergebnissen unterscheidbar. |
| Mailentwürfe | Entwurf einschließlich Antwortreferenz bleibt bei Navigation, Schließen der Kontenansicht und Neuladen im selben Fenster erhalten. Ausdrückliches Verwerfen; keine Vermischung zweier Entwürfe. Nicht für einen kompletten App-Neustart zugesagt. |
| Mailversand | Sofortige UI-Sperre, unveränderliche Felder während Versand, Sperre über Bereichswechsel. IPC fasst identische Versandkennungen zusammen und behält auch Fehler, damit eine verlorene SMTP-Antwort keinen zweiten Versand erzeugt. Der Schutz gilt während dieser App-Sitzung. |
| Health-Dateiimport | Grenzen für ZIP-/Zip64-Offsets, Eintragszahl, Verzeichnisgröße und entpackte Daten; vollständig gelesene Header, Kompression, CRC und tatsächliche Länge geprüft. Streams werden geschlossen. Ein Import gleichzeitig, Fortschritt, Abbrechen, Schutz vor spätem Speichern nach Löschen. |
| Health-Auswertung | Historische Tage werden früh verworfen; Exportdatum bestimmt die lokale Tagesgrenze. Identische Einträge zählen einmal; Schlafintervalle derselben Quelle werden vereinigt. XML-Abbruch und überlange Elemente werden abgelehnt. Quellenmaximum bleibt ausdrücklich eine Näherung. |
| Quizbewertung | Jede präsentierte Frage hat eine Kennung. Hauptprozess bewertet sie genau einmal, liefert bei gleichem Wiederholungsrequest dasselbe Ergebnis und lehnt veraltete/fremde Fragen ab. UI und gesprochenes Quiz verwenden diesen Bezug. |
| Sicherung | Zusätzlich Projekte, Notizen, Widgets, Arbeitsstand und PC-Profil im expliziten Dateiinventar. Keine beliebige Kopie des Benutzerprofils. |
| Wiederherstellung | Dateiauswahl und Bestätigung in den Einstellungen. Format-, Größen-, Pfad-, Lernkarten- und SQLite-Integritätsprüfung vor dem Vormerken. Anwendung beim nächsten Start vor Öffnen der DB, mit Rückfallbestand und Write-ahead-Journal. Fehler während Austausch werden zurückgerollt. Alte Version-1-Sicherungen bleiben lesbar. |
| PC-Profil | Ordnerauswahl, Ausschlüsse und Profilvorschau. Änderungen der Auswahl entwerten alte Profile und laufende Scans. Netzpfade und Verknüpfungen werden nicht eingelesen. Ohne eigene Auswahl bleiben die bisherigen Standardordner aktiv. |
| Tagesbriefing | Unabhängige, begrenzte Abfragen; Berechtigung vor dem Lesen. Verfügbare Ergebnisse bleiben bei Dienstausfällen sichtbar. Fehlgeschlagene Abfrage markiert den Tag nicht als vollständig erledigt; begrenzte Wiederholung und manuelles Aktualisieren im Menü. |
| Google Workspace | Drive-Downloads und Exporte werden während des Lesens begrenzt, abgebrochen und geschlossen. Nur ausdrücklich unterstützte Google-Dateitypen werden exportiert. Workspace-Clients erhalten Timeout und ausgeschaltete SDK-Retries. Teilweise Dokumenterstellung liefert vorhandene ID/Link und einen Hinweis zur Prüfung statt stiller Neuerstellung. |
| Wake-on-LAN | PowerShell-Timeouts und erneute Bereitschaftsprüfung nach angeforderter Änderung. Erfolgreicher Prozessstart allein gilt nicht mehr als bestätigte Einrichtung. Keine Adapteränderung im Audit ausgeführt. |
| Status und Bedienung | iCloud-Cookie wird als gefundene Browsersitzung angezeigt. Gespeicherter Mailzugang ist kein Live-Zugriffsnachweis. Fehler auffangen, Fokus beim Öffnen/Schließen zurückgeben, Voraussetzungen pro Apple-Dienst erklären. |
| Tests und CI | Alte UI-Erwartungen an offene Anbieterregler/„angemeldet“ aktualisiert. Kontext-/Lern-UI-Profile schalten Hintergrundaktivität ausdrücklich aus. Allgemeiner UI-Test verwendet eigenen Wrapper unter `out/`. PR-Workflow um Browser, Konten, Recovery, Mobile und Dashboard erweitert. |

## Automatisierte Prüfung

- Desktop: **2.299 Tests bestanden, 0 fehlgeschlagen, 0 übersprungen**. Abschließender Lauf etwa 46,1 Sekunden. `out/audit/implementation-tests-2026-10-26.log`.
- Typecheck für Main, Renderer und Tests bestanden.
- Produktionsbuild bestanden. Bestehende große Renderer-/Mapbox-Chunks werden weiterhin gemeldet; Warnschwellen wurden nicht hochgesetzt.
- Mobile: Typecheck, ESLint und **6 Tests** einschließlich zwei Sicherheitsregressionen bestanden.
- Fehler-Dashboard: **11 Tests** bestanden.
- Echte Electron-/Chromium-Prüfungen mit isolierten Daten: Redesign, Browser, Stimmen/iCloud, Workspace, Kontext, Lernen, allgemeine UI einschließlich simuliertem Diagnoseempfänger, Karten, Auth-UI, neue Kontenregression und Recovery-/PC-Profil-UI. Kein echter Mailversand oder Modellauftrag in diesen Prüfungen.
- Der Telefon-Web-Smoke wurde im vorherigen Prüfschritt dieser Sitzung erfolgreich ausgeführt; an dessen Produktcode wurde hier nichts geändert.
- Die neuen Audit-Skripte prüfen inzwischen die korrekten Soll-Erwartungen. Erfolgreicher Exit bedeutet jetzt Regression bestanden.

Neue Verhaltenstests stehen in `backend-hardening`, `backup-restore`, `briefing`, `google-workspace-reliability`, `health-import`, `http-body` und den erweiterten Health-/PC-Profil-Tests. Der Restore-Test prüft echten SQLite-Rundlauf, Lernfortschritt, Projektdaten, ausgeschlossene Zugangsdaten, Journal-Wiederaufnahme und einen Fehler nach bereits begonnener Dateiersetzung.

## Mobile-Sicherheitsbefunde

Expo 58 verwendet hier `node-forge` 1.4.0 und Zod 3.25.76. Der aktuelle [Forge-Advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) nennt keine gepatchte Veröffentlichung. Die vom [Zod-Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) genannte reparierte 4er-Reihe ersetzt nicht ohne Weiteres Expos 3er-Vertrag.

Deshalb kein Expo-Downgrade: `mobile/scripts/security-patches.cjs` wendet bei `npm install`/`npm ci` eng begrenzte, versionsgeprüfte lokale Schutzpatches an:

1. Forge: Anzahl der verschachtelten DigestAlgorithm-Elemente bei RSA-Prüfung kontrollieren. Ein korrekt signierter, strukturell unzulässiger DigestInfo wird abgelehnt; normale Signaturen bleiben gültig.
2. Zod v3, CommonJS und ESM: Zu große Arrays vor dem Parsen der einzelnen Elemente ablehnen. Vorhandene Maximal-/Exaktlängen greifen früh; für unbeschränkte Tooling-Arrays gilt zusätzlich 10.000 als lokale Obergrenze.

Tests liegen in `mobile/scripts/security.test.cjs`. Der Patch läuft idempotent und stoppt bei unerwarteter Paketversion statt fremden Code blind zu ändern. **Das npm-Audit meldet weiterhin sechs betroffene Pakete**, weil die Versionsnummern unverändert sind. Die konkret getesteten Fehlerpfade sind lokal mitigiert; das ist keine Behauptung einer vollständigen Upstream-Reparatur. Bei einem kompatiblen Upstream-Fix die lokalen Patches überprüfen/entfernen. Vor Änderungen an Expo-APIs gilt weiterhin die [SDK-58-Dokumentation](https://docs.expo.dev/versions/v58.0.0/) und `mobile/AGENTS.md`.

## Speicherinventar und Restore-Verhalten

| Speicher | Gesichert | Wiederherstellung |
| --- | --- | --- |
| `data/jarvis.db` | Ja, konsistenter SQLite-Snapshot | Integritätsprüfung; Austausch vor DB-Start; alte WAL/SHM-Dateien werden entfernt |
| `settings.json` | Ja | Validiert; vorhandene lokale MCP-Umgebungswerte werden nicht aus einer Sicherung ersetzt |
| `skills/*.md`, `study.json` | Ja | Strukturprüfung, Lernfortschritt bleibt erhalten |
| `gehirn/projekte`, `gehirn/notizen`, `gehirn/widgets.json` | Ja | Nur erlaubte lokale Dateien, keine Verknüpfungen |
| `working-context.json`, `pc-profile.json` | Ja | Beim Neustart geladen; Arbeitsstand wird weiter wie bisher pausiert wieder aufgenommen |
| Keystore/OAuth, Companion-Token, Zertifikate, Browser-Sitzungen | Nein | Bestehende lokale Zugänge bleiben bestehen; auf anderem PC neu anmelden |
| Health-Werte, Sprachmodelle, Logs und Laufzeitmarker | Nein | Health neu importieren/koppeln; Modelle bei Bedarf laden |

Zusätzliche Projektdateien sind auf 2 MiB je Datei, 2.000 Dateien und 16 MiB insgesamt begrenzt. Eine überschrittene Grenze erzeugt einen Fehler statt einer angeblich vollständigen Sicherung. Dateien, die in einer älteren Sicherung fehlen, werden beim Restore beibehalten. Eine Wiederherstellung ist daher ein kontrollierter Austausch der enthaltenen Bestände, kein Löschen sämtlicher später angelegter Dateien.

Vor dem Austausch liegt der vorherige Bestand als `backups/before-restore-*.json` im Benutzerprofil. Er enthält Dateipfade und Base64-Inhalte, also persönliche Daten. Nach einem Absturz wird das Journal zuerst zurückgerollt; danach kann der vorgemerkte Restore erneut vollständig laufen. Bei einem abgefangenen Schreibfehler wird der Vorgang aus der Warteschlange genommen, damit er nicht jeden Start blockiert. Die Rückfallkopie nicht ungeprüft mit anderen teilen.

## Messungen und Artefakte

- Synthetischer Health-Parserlauf: **1.000.000 historische Records**, etwa **164 MiB XML**, **2.661 ms** nach Zwischenspeicherung des Siebentagefensters. Der vorherige Einzellauf mit erneuter Datumsberechnung pro Record dauerte 16.447 ms. Beide liefen während weiterer lokaler Arbeiten; kein kontrollierter allgemeiner Geschwindigkeitsvergleich. Gemessene zusätzliche JS-Heap-Spitze bei Chunk-Stichproben etwa **2 MiB**, **0 historische Tagesaggregate behalten**. Kein ZIP-/Dateisystem-Benchmark und keine vollständige Prozess-RAM-Messung. `scripts/benchmark-health.cjs`, Ergebnis unter `out/audit/health-performance-2026-10-26.json`.
- `scripts/benchmark-startup.cjs`: ein kontoloser Electron-Start bis zum Menü in **2.748 ms**; Fünfsekunden-Prozesssample mit **463 MiB privaten Bytes** über die App-Prozesse. Das Einrichtungsfenster war Teil des Starts. Working-Set-Summen enthalten geteilte Seiten; private Bytes separat ausweisen. Kein Beleg für Modell-, Mikrofon- oder Sprachausgabelatenz.
- Screenshots: `out/audit/accounts/draft-preserved.png`, `out/audit/recovery/settings.png`, `out/audit/browser/`, `out/audit/redesign/`. Die neue Mailansicht und Recovery-Oberfläche wurden visuell geprüft; die Recovery-Fixture verwendet Produktstyles und synthetische Daten.
- Lokaler Windows-Installer liegt nach finalem Paketbau unter `out/audit/package-final-2026-10-26/`. Paketcheck prüft Übereinstimmung mit dem aktuellen Build, Weckwortmodelle, Helferskripte, Companion-Ressourcen und Ausschluss der Audit-Dateien. Kein GitHub-Release, keine Installation der neuen Fassung. Das Paket hat weiterhin die lokale Versionsnummer 1.3.24 und keine Authenticode-Signatur.

## Fähigkeitsmatrix und verbleibende Abnahme

| Fähigkeit | Lokal implementiert / automatisch geprüft | Echte Integration in diesem Durchgang |
| --- | --- | --- |
| Sprach-/Textzustände, Stoppen, Reconnect | Vorhandene Lifecycle-/Cancellation-Suite grün | Mikrofon, Lautsprecher und tatsächlicher Providerdialog offen |
| Erinnerungen, Lernkarten, Projekte, Arbeitsstand | Getestet; neue Zuordnungs- und Restore-Fälle ergänzt | Windows-Benachrichtigung und Langzeitbetrieb separat prüfen |
| iCloud-Mail/Kalender | Transportcode vorhanden; UI-/Zustands-/Freigabetests grün | Apple-Login, reale Mail/CalDAV und bewusster Testversand offen |
| Drive | Pfad-, Junction-, Such- und Streamgrenzen geprüft | Echte Cloud-Platzhalter und installierte iCloud-App offen |
| Health-Dateiimport | XML/ZIP, CRC, Abbruch, Tages-/Schlafregeln geprüft | Abgleich der Näherungswerte mit eigenem Export offen |
| Google Workspace | Streamgrenzen, Dateitypen und Teilerstellung getestet | Anmeldung/Scopes und echte Testdatei offen |
| Mobile/Watch | TS/Lint/Pairing und lokale Security-Tests grün | Signierter EAS-/Swift-Build, iPhone, HealthKit und Watch offen |
| WOL/Standby | Fehlerbehandlung und begrenzte Konfiguration vorhanden | Tatsächliches Schlafen/Aufwecken und Windows-Resume offen |
| Sicherung/Restore | Vollständiger isolierter Dateisystem-/SQLite-Rundlauf | Wiederherstellung eines Nutzerprofils nicht durchgeführt |
| Installer/Updates | Lokales Paket gebaut/geprüft | Installation, Update von installierter Fassung und Signierung offen |

Für die Geräte-/Kontoprüfung je einen klar bezeichneten Testbestand verwenden: leere Testmail, Testkalender/-datei, anschließend prüfen und wieder entfernen. Unklare Versand-/Schreibergebnisse vor Wiederholung beim Dienst nachsehen. WOL erst bewusst testen, wenn der Rechner schlafen darf. Für iPhone/Watch werden ein signierter Build und Geräte benötigt. Diese externen Nachweise werden nicht aus grünen Unit-Tests abgeleitet.

Der separate PR-Workflow enthält jetzt auch Mobile und Dashboard. Seine Ausführung auf GitHub ist noch offen. Große optionale Bundles sind weiterhin sichtbar; weitere Optimierung sollte gegen mehrere vergleichbare Start-/Leerlaufmessungen erfolgen, nicht allein gegen eine Dateigrößenwarnung.
