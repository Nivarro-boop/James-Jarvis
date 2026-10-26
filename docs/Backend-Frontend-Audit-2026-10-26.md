# Backend- und Frontendprüfung – 26.10.2026

**Umsetzungsnachtrag:** Die unten beschriebenen Befunde sind inzwischen bearbeitet. Der aktuelle Zustand, Regressionstests und verbleibende Live-Abnahme stehen im [Umsetzungsbericht](Umsetzung-2026-10-26.md). Die Audit-Skripte prüfen jetzt die korrigierten Soll-Erwartungen; die ursprünglichen Reproduktionsbeschreibungen bleiben als Historie erhalten.

## Ergebnis und Umfang

James-Jarvis 1.3.24, Basis `55b7ca3` mit vorhandenem Arbeitsstand. Breite Projektprüfung einschließlich Desktop-Backend, Frontend, IPC, Berechtigungen, Speicher, Provider, Agenten, Scheduler, Companion, MCP, Mobile, Fehler-Dashboard und Build-/Releaseprozess. **Keine uneingeschränkte Freigabe:** Trotz grüner bestehender Tests sind reproduzierbare Produktfehler vorhanden.

Die Prüfung kombiniert die unmittelbar vorher in dieser Sitzung ausgeführte Baseline mit zusätzlicher Quellcodeprüfung, fünf weiteren UI-Smokes, zwei eigens erstellten Reproduktionsskripten und Abhängigkeitsprüfungen aller drei npm-Projekte. Produktcode wurde dabei nicht geändert. Nicht jede Zeile und nicht jede Integration wurde manuell geprüft. Echte Konto-, Hardware-, Swift-Build- und Installertests fehlen weiterhin.

## Wichtigste Befunde

### B1 · P1 · `alwaysAsk` wird im Standardprofil übergangen

**Fundstelle:** `src/main/tools/permissions.ts:138`, besonders die Rückgabe bei `!settings.confirmActions` vor Prüfung von `tool.alwaysAsk`; `src/shared/config/defaults.ts:225`; `src/main/tools/impl/icloud.ts:95`.

**Nachgewiesen:** Ein registriertes synthetisches Werkzeug mit `alwaysAsk: true` erhält unter dem Standardwert `confirmActions: false` die Erlaubnis `allow`. iCloud-Mail trägt genau dieses Kennzeichen, während Dokumentation und Beschreibung eine immer erforderliche Bestätigung versprechen. Auch werkzeugspezifisches `ask` wird erst nach dem globalen Freigabezweig betrachtet. Explizites `deny` und `order_place` sind vorher geschützt.

**Folge:** Die tatsächlichen Freigaberegeln weichen von den zugesagten Regeln ab. Kein echter Versand im Test.

**Auftrag:** Unbedingte Bestätigung und normale profilspezifische Rückfrage unterscheiden; beabsichtigte Rangfolge im Code und in der UI vereinheitlichen. Regression für `deny`, `alwaysAsk`, explizites `ask`, autonomen Modus und Bestellungen. Nutzerpräferenz für gewöhnliche autonome Aktionen erhalten.

### B2 · P1 · Fehler erneuert Freigabe auch bei unklarem externem Ergebnis

**Fundstelle:** `src/main/tools/runner.ts:329`, `src/main/tools/permissions.ts` (`regrantConfirmation`, `verifyConfirmation`).

Der Runner erneuert nach jedem nicht abgebrochenen Fehler einer bestätigten Aktion deren Freigabe. Der Kommentar behauptet dabei, die Aktion sei nicht passiert. Das ist etwa bei verloren gegangener SMTP-/HTTP-Antwort nicht ableitbar.

**Nachgewiesen:** Nach `regrantConfirmation` akzeptiert `verifyConfirmation` dieselben Argumente ohne neuen Nutzerturn. Der allgemeine Fehlerpfad wurde im Quellcode geprüft. Ein realer Doppelversand wurde ausdrücklich nicht provoziert.

**Auftrag:** Fehlerzustände „sicher nicht ausgeführt“, „Ergebnis unklar“ und „abgeschlossen“ unterscheiden. Schreibaktionen nicht pauschal erneut freigeben. Wo möglich stabile Vorgangs-ID und Anbieterstatus nutzen. Testtransport soll Seiteneffekt ausführen und anschließend einen Antwortfehler werfen; kein zweiter Seiteneffekt darf automatisch entstehen.

### B3 · P1 · Migration aktiviert ausdrücklich deaktivierte Diagnoseübertragung

**Fundstelle:** `src/main/store/settings.ts:91–92`.

**Reproduktion:** Temporäre `settings.json` mit `diagnosticReporting.enabled=false` und `automatic=false`, ohne `useDeviceLocation`. Nach `getSettings()` stehen beide Werte auf `true`. Es wurde kein Diagnoseversand gestartet.

**Auftrag:** Explizite Nutzerwerte bei Migration erhalten. Fehlendes Standortfeld nicht als Zustimmung zur Übertragung behandeln. Regression mit alten Profilen und vorhandenen Opt-outs; fehlende Felder und ausdrücklich ausgeschaltete Felder getrennt testen.

### B4 · P1 · Drive-Prüfung lässt Junction nach außerhalb passieren

**Fundstelle:** `src/main/providers/icloud.ts:322`; Aufrufer in `src/main/tools/impl/icloud.ts` und `src/main/ipc/bridge.ts`.

**Reproduktion:** Temporäre Drive-Wurzel mit Junction `linked` auf einen zweiten temporären Ordner. `insideDrive(root, 'linked/synthetic.txt')` akzeptiert den Pfad; anschließendes Lesen liefert die synthetische Datei außerhalb der Wurzel. Keine privaten Dateien betroffen.

**Auftrag:** Aufgelöste reale Pfade für Listen, Lesen und Öffnen prüfen; Netzwerkziele und Verknüpfungen ausdrücklich behandeln. Vorbild ist der bereits strengere `realTarget`-Weg der allgemeinen Dateiwerkzeuge. Suchbudget zusätzlich nach besuchten Einträgen statt nur gefundenen Treffern begrenzen.

### B5 · P1 · Projektänderungen können ein falsches Projekt treffen

**Fundstelle:** `src/main/brain/store.ts:51`; `src/main/tools/impl/brain.ts:54` und `project_update`.

**Reproduktion:** Zwei synthetische Projekte „Alpha Website“ und „Alpha Mobile“. `findProject('')` und `findProject('Alpha')` liefern jeweils ein Projekt statt fehlenden/eindeutigen Schreibbezug zu verlangen. `project_update` nutzt dieselbe Suche; dessen Schema akzeptiert leere Zeichenketten. Schritt-Abhaken verwendet ebenfalls den ersten passenden Teilstring.

**Auftrag:** Stabile IDs/exakte Identität für Mutationen; leere Eingaben ablehnen, Mehrdeutigkeit zurückgeben. Unscharfe Suche als getrennte Lesefunktion erhalten. Regression: Mehrdeutige Anfrage verändert keine Projektdatei und hakt keinen beliebigen Schritt ab.

### F1 · P1 · Alte Mailabfrage überschreibt neuen Ordner

**Fundstelle:** `src/renderer/accounts/AccountsView.tsx:257–270`.

**Reproduktion im echten Chromium mit Mock-IPC:** INBOX-Anfrage offen lassen, auf Archive wechseln, Archive zuerst beantworten, dann INBOX. Auswahl zeigt Archive, Liste zeigt anschließend den alten Posteingang. Da UIDs ordnerbezogen sind, kann ein anschließender Aufruf mit dieser Kombination eine falsche Mail anfordern.

**Auftrag:** Anfragegeneration plus Konto-/Ordner-/UID-Bezug; alte Ergebnisse verwerfen. Mailauswahl und Drive-Suche analog testen. Lade-/Fehlerzustände nicht durch ältere Aufrufe überschreiben lassen.

### F2 · P1 · Mailentwurf verschwindet beim Bereichswechsel

**Fundstelle:** `AccountsView.tsx:254`, `:300`, `:319`.

**Reproduktion:** Neue Mail mit Empfänger und Text → Kalender → iCloud Mail → Neue Mail. Textfeld leer, keine Verwerfen-Bestätigung. Der Composer wird mit dem Bereich unmountet.

**Auftrag:** Entwurf über Navigation erhalten; bewusstes Verwerfen ermöglichen. Konsistente Entwurfs-ID einschließlich `inReplyTo`. Beim bereits offenen Composer setzt „Neue Mail“ neue Props, während die einmal initialisierten Textfelder bleiben können; diesen weiteren Fall regressionsfähig machen. Versandpayload während laufendem Versand unveränderlich halten.

## Weitere konkrete Prüfpunkte aus dem Code

Diese Punkte sind nicht als neu vollständig reproduzierte Fehler ausgegeben:

- **Health-Import (P1):** Selbst implementierter ZIP-/Zip64-Leser ohne durchgehende Bounds-/Read-Prüfungen; kein Abbruch/Generationenschutz gegen Speichern nach Löschen. Parser hält historische Tagesaggregate bis zum Schluss statt nur sieben Tage. Details und Testszenarien im Sol-Plan, Paket D.
- **Tagesbriefing (P2):** Direkte `execute`-Aufrufe umgehen den normalen Runner und damit dessen Berechtigungsentscheidung. Dienstfehler werden teilweise verschluckt; anschließend wird der Tag auch bei leerem Ergebnis als erledigt markiert (`dailyBriefing.ts:80`). Test: gesperrtes Tool, zwei ausfallende Dienste, anschließende Wiederherstellung der Verbindung.
- **Kontenstatus (P2):** Statusfehler wird als `null` geschluckt und kann „Lädt …“ stehen lassen. Cookiefund wird als „angemeldet“ dargestellt, ohne Zugriffsnachweis. Einige UI-Aktionen haben kein Catch für verworfene IPC-Promises.
- **Backup/Restore (P2):** DB, Einstellungen, Skills und Lernkarten werden gesichert. Projektdateien unter `gehirn/` und weitere eigenständige Speicher fehlen im Payload; kein kompletter Restore-Assistent. Inventar und Roundtrip-Abnahme erforderlich.
- **Testisolierung (P2):** `check-context-ui.cjs` und `check-learning-ui.cjs` schalten Diagnoseübertragung, PC-Scan, Briefing und Downloads nicht vollständig explizit aus. Diese Skripte wurden deshalb nicht zusätzlich ausgeführt. Isoliertes Verzeichnis allein verhindert keine Hintergrund-Netzwerkaktionen.
- **Allgemeiner UI-Smoke (P2):** `check-ui.cjs` überschreibt und entfernt `.jarvis-ui-check.cjs`, obwohl diese Datei bereits vor dem Audit unversioniert vorhanden war. Diesen Test nicht unverändert gegen den aktuellen Arbeitsstand starten; eindeutigen Wrapper unter `out/` verwenden.
- **Performance (P3):** Große Renderer-/Mapbox-Chunks bleiben Buildwarnungen. Erst Startzeit/Leerlauf/Framezeit messen; keine Latenzbehauptung aus Dateigrößen ableiten.

## Abhängigkeiten

`npm audit --json`, am 26.10.2026 gegen die jeweilige lokale Abhängigkeitsauflösung:

| Projekt | Ergebnis |
| --- | --- |
| Desktop/Hauptprojekt | 0 gemeldete Schwachstellen |
| Fehler-Dashboard | 0 gemeldete Schwachstellen |
| Mobile | 6 betroffene Pakete mit Einstufung high, 0 critical |

Die sechs Mobile-Meldungen sind **nicht sechs unabhängige Sicherheitslücken**. Sie enthalten durchgereichte Abhängigkeiten über `expo`, `@expo/cli`, `@expo/code-signing-certificates` und `@bacons/apple-targets`. Die zwei zugrunde liegenden Advisories betreffen laut npm-Antwort `node-forge` (Signaturprüfung) und `zod` (Speicherverbrauch bei übergroßen Collections).

Rohberichte: `out/audit/dependencies-2026-10-26.json`, `out/audit/mobile-dependencies-2026-10-26.json`, `out/audit/dashboard-dependencies-2026-10-26.json`.

**P1 vor Mobile-Auslieferung:** Betroffene installierte Versionen und Erreichbarkeit in Build-/Signing-/Runtimepfaden prüfen, kompatible Auflösung suchen und Expo-58-Prüfungen wiederholen. Der vorgeschlagene automatische Fix würde Expo auf 44.0.6 und apple-targets auf 3.0.7 zurückstufen; nicht blind `npm audit fix --force` ausführen. Das Audit belegt die Paketmeldungen, nicht eine erfolgreiche Ausnutzung der App. Kein Paket wurde geändert.

## Prüfmatrix

| Bereich | Nachweis | Grenze |
| --- | --- | --- |
| Desktop-Code/Verträge | Typecheck, 2.286 Tests, Produktionsbuild aus dieser Sitzung | Vorhandene Suite übersieht die oben reproduzierten Fälle |
| IPC/Electron | Senderprüfung, Preload-Allowlist und Fensterkonfiguration gelesen; Browser-Smoke bestanden | Keine umfassende Penetrationsprüfung |
| Berechtigungen/Runner | Quellcode plus synthetische Reproduktion B1/B2 | Kein realer externer Schreibvorgang |
| Datenhaltung | Settings, Keystore, Brain, DB-/Backupwege gelesen; B3/B5 reproduziert | Kein Restore des Nutzerprofils |
| Dateien/Health | Drive-Junction reproduziert; Health-Parser und Grenzen gelesen | Kein großer privater Health-Export |
| Provider/Agent | Timeouts, Abbruch, Retry und Toolzugriff gezielt gelesen; bestehende Tests grün | Keine echten Konten oder Modellrunden |
| Scheduler/Companion/MCP | Reminder-DST/Validierung, Socket-Token/Größenlimits, MCP-Lifecycle und Quit-Cleanup gelesen; bestehende Tests grün | Kein echter Telefon-/WOL-/Standbytest |
| Frontend | Redesign, Workspace, Connectors, Auth, Phone zusätzlich bestanden; Browser und Stimmen bereits bestanden | Teilweise Mock-IPC/synthetisches Audio |
| Neue Kontenoberfläche | F1/F2 mit echtem React/Chromium reproduziert | Mailtransport simuliert |
| Mobile | Typecheck, Lint, 4 Tests aus dieser Sitzung; Dependency-Audit | Kein Swift-/EAS-/HealthKit-Gerätetest |
| Fehler-Dashboard | 11 Tests aus dieser Sitzung, Dependency-Audit | Kein Deployment-/Live-Daten-Test |
| Release | CI/Versionsführung/Updater und Buildwarnungen gelesen | Kein Installer/Push/Release |

Die sieben erfolgreichen UI-Smokes dieser Sitzung sind `check-integrated-browser`, `check-voice-icloud-ui`, `check-redesign-ui`, `check-workspace-ui`, `check-connectors-ui`, `check-auth-ui`, `check-phone-ui`.

Die aktuellen Screenshots `out/audit/redesign/home-small.png` und `settings.png` wurden zusätzlich visuell angesehen. Einstellungen sind in dieser Aufnahme lesbar; das sehr kleine Hauptfenster zeigt eine stark begrenzte, gescrollte Startfläche über der Gesprächsansicht. Das ist kein vollständiger Tastatur-/Screenreader-/Kontrasttest. Neue Phone-Screenshots wurden unter `out/audit/phone-*-2026-10-26.png` abgelegt; die vom Test überschriebenen historischen versionierten Screenshots wurden auf ihren vorherigen sauberen Stand zurückgesetzt.

## Reproduktion und Übergabe

```powershell
node scripts/audit-backend-2026-10-26.cjs
node scripts/audit-frontend-2026-10-26.cjs
```

Die Audit-Skripte erwarten den **heutigen fehlerhaften Zustand**. Erfolgreicher Exit bestätigt die Reproduktion, nicht Fehlerfreiheit. Nach einer Reparatur müssen diese Fälle in Regressionstests mit der richtigen Soll-Erwartung umgewandelt werden. Backend-Daten bleiben ausschließlich in neu erzeugten temporären Auditprofilen; UI verwendet Mock-IPC ohne Konten.

Reparaturreihenfolge: B1/B2/B3 → B4/B5/F1/F2 → Health-Import → Mobile-Abhängigkeiten → Briefing/Restore/Status → Hardware- und Kontoprüfung → Performance/Auslieferung. Den bisherigen Sol-Plan um diese Prioritäten ergänzen; keine erneute Implementierung bereits erledigter Arbeit.
