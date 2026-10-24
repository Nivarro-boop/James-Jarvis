# GUI und Stabilität — 23.10.2026

Diese Änderungen sind lokal im Quellcode und im Entwicklungsbuild enthalten. Die vielen bereits vorhandenen Änderungen wurden erhalten. Kein Installer wurde erstellt oder installiert; keine Veröffentlichung.

## Sichtbare Änderungen

- Einheitliche Gestaltung von Startseite, Antwortkarten, Quiz und Einstellungen: dunkle Flächen, Türkis-Akzent, konsistente Typografie, Abstände, Eingaben und Tastaturfokus. Zentrale Gestaltungsdatei: `src/renderer/refinement.css`.
- Die Kugel bleibt erhalten. Zusätzliche eindeutige Schaltflächen zum Sprechen und Pausieren des Mikrofons.
- Texteingabe mit mehrzeiligen Nachrichten, Enter/Shift+Enter, Sendestatus und Entwurf im sessionStorage des Fensters. Ein Fehler oder Neuladen verliert den Entwurf nicht. Erst eine erfolgreiche Übergabe leert ihn; währenddessen neu eingegebener Text bleibt erhalten.
- Aufklappbarer Gesprächsverlauf aus den im Renderer vorhandenen Beiträgen. Kein neuer dauerhafter Chat-Speicher.
- Direkte Zugänge zu Lernen, Projekten und Verbindungen. Aufgeräumte Lernansicht während eines Quiz.
- Sichtbarer Stopp-Knopf für laufende Arbeit, zusätzlich zu Escape.
- Menü mit Pfeiltasten, Home/End, Escape und Fokus-Rückgabe.
- Diagnoseanzeige sagt „Keine Fehlermeldungen“ statt pauschal „Alles läuft“. Der separate Verbindungsstatus bleibt sichtbar.
- Antwortkarten zeigen einen vorhandenen gültigen Zeitstempel.
- Einstellungen mit breiterer Navigation, klarer aktiver Auswahl, lesbareren Formularen und einheitlichen Kacheln. Onboarding-Text erklärt jetzt Sprache und Texteingabe.
- Kleine Fenster und reduzierte Bewegung berücksichtigt. Optionaler Status wird in engen Fenstern reduziert; Menü, Verbindung und Eingabe bleiben erreichbar.

## Daten und Ablauf

### Lernen

`src/main/study/store.ts` validiert gespeicherte Daten mit Zod. Nur eine tatsächlich fehlende Datei ergibt einen leeren Bestand. Fehlerhafte, unlesbare oder unbekannt versionierte Dateien werden nicht durch einen neuen Bestand überschrieben. Bestehende Dateien ohne Versionsfeld bleiben lesbar; neue Schreibvorgänge verwenden Version 1, eine eindeutige temporäre Datei und Dateisynchronisierung vor dem Umbenennen.

Schreibaktionen ordnen Stapel exakt zu. Leere Namen werden abgelehnt; mehrdeutige unscharfe Suchanfragen melden einen Fehler. Fragen werden vor der Duplikatprüfung gekürzt. Optionen sind begrenzt und enthalten die gespeicherte Lösung. Neue IDs verwenden vollständige UUIDs.

Die Oberfläche verhindert doppelte Bewertungen, entwertet alte Antworten nach dem Schließen/Wechseln und zeigt Lade- und Fehlerzustände. Bei fehlgeschlagenem Laden kann der Nutzer erneut laden. Bereits übermittelte Bewertungen werden durch das Schließen nicht zurückgenommen.

Freitextbewertung behandelt Zahlen einschließlich Vorzeichen streng und erkennt zusätzliche Negation. Die frühere großzügige Kernwortheuristik wurde entfernt. Das bleibt ein lokaler Kurzantwortvergleich, keine semantische Bewertung langer Erklärungen.

### Sicherung

Der bestehende Sicherungspayload erhält zusätzlich `study: { version: 1, decks: [...] }`. Darin sind Lernkarten, Fächer, Fälligkeiten und Antwortzähler enthalten. Das äußere Backupformat bleibt Version 1; es wurde ein zusätzliches Feld eingeführt. Alte Backups enthalten dieses Feld nicht.

Es gibt weiterhin **keinen neuen automatischen Wiederherstellungsassistenten**. Bei manueller Wiederherstellung im geschlossenen Programm kann das JSON-Objekt aus `study` als `study.json` im Benutzerprofil gespeichert werden. Vorhandene Dateien vorher extern sichern. Der Test prüft den gesicherten Lernfortschritt, nicht einen vollständigen installierten Restore-Ablauf. Bei einer beschädigten Lernkartendatei schlägt die Sicherung mit verständlichem Fehler fehl, statt einen angeblich vollständigen leeren Lernbestand zu sichern.

### Einrichtung

WhatsApp-Statusabfragen laufen nacheinander und enden nach einer absoluten Zweiminutengrenze, auch bei Fehlern oder hängenden Anfragen. Schließen entfernt die Timer; verspätete Ergebnisse werden ignoriert. Die bereits gestartete zugrundeliegende IPC-/Browseraktion wird dadurch nicht rückgängig gemacht.

Der Downloadfortschritt bezieht sich auf einen stabilen anfänglichen Satz fehlender Assets. Abgeschlossene Assets bleiben im Fortschritt berücksichtigt. Die Anzeige hat eine zugängliche Beschriftung.

### PC-Profil

Verzeichnis-, Metadaten- und Dokumentlesezugriffe erfolgen asynchron. Das Dokument-Scanning begrenzt Einträge und prüft ein Zeitbudget zwischen Dateizugriffen; ein einzelner langsamer Dateisystemaufruf ist damit nicht hart abbrechbar. Verzeichnisverknüpfungen werden übersprungen. Dokumente und entpacktes DOCX-XML sind auf jeweils 2 MiB begrenzt. ZIP-Offsets und Kompressionsmethode werden geprüft.

„Eingelesenes löschen“ entwertet einen laufenden Scan. Vor dem Speichern werden Generation, Aktivierung und Gaming-Modus erneut geprüft. Die Profilsuche liefert bei deaktivierter Funktion keine Inhalte. Die Änderung ersetzt keine vollständige Inhaltsklassifikation oder frei konfigurierbare Ordnerauswahl.

## Prüfung

- Gesamtsuite: **2.093 Tests bestanden, 0 fehlgeschlagen** (`out/redesign-tests.log`).
- Gezielt geprüfte Speicher-, Backup-, ZIP- und Scan-Löschfälle sowie Zahlen-/Negationsbewertung.
- Typecheck bestanden; Produktionsbuild erfolgreich. Die bestehenden Größenwarnungen für Renderer/Mapbox bleiben bestehen.
- Neuer realer Electron-UI-Test: `node scripts/check-redesign-ui.cjs`. Isoliertes Profil, künstliche Mikrofonquelle und simulierte Sendebestätigung. Prüft Entwurferhalt und erfolgreiches Leeren, Neuladen, Tastaturmenü, Quiz-Doppelklick, kleines Fenster und Einstellungsnavigation.
- Bestehende Checks für allgemeine UI, Arbeitsbereich, Karten und Konnektoren bestanden. Veraltete Erwartungen „kein Textfeld“ angepasst. Die ausgeführten Electron-Testprofile deaktivieren automatisches PC-Einlesen, Briefing, Downloads über Gaming-Modus und Diagnoseversand, soweit der jeweilige Test diese Funktionen nicht ausdrücklich simuliert.
- Screenshots von Startseite, Quiz, kleinem Fenster und Einstellungen erstellt und angesehen: `out/audit/redesign/`.
- Neuer PR-Workflow `.github/workflows/check.yml`: Installation, Typen, Tests, Codebuild und isolierter GUI-Smoke. Er veröffentlicht nichts. Der Workflow wurde lokal vorbereitet, noch nicht auf GitHub ausgeführt.

## Noch offen

Echte Mikrofon-/Lautsprecher-/Weckworttests, Konto- und Geräteintegrationen, Standby/Wiederaufnahme und Installer-Abnahme. Der Hauptauftrag an James wurde im UI-Test simuliert, kein echter Modellaufruf nachgewiesen. Die neue Gestaltung ersetzt keinen manuellen Durchgang durch jeden einzelnen Integrationsdialog.

Weitere größere Arbeitspakete aus dem Masterprompt bleiben: vollständiger Restore-Assistent, serverseitige Idempotenz für Quizrunden, konfigurierbare Scanordner, robustere Briefing-Teilresultate, Streaming-/Größenlimits der Workspace-APIs und gemessene Bundle-/Leerlaufoptimierung. Diese Punkte wurden nicht als erledigt markiert.
