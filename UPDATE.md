# Update 1.3.7 – Unsichtbarer Browser, Bedienung, LM Studio – 13.10.2026

- Der James-Chrome läuft außerhalb des sichtbaren Bildschirms (Drosselung
  verdeckter Fenster abgeschaltet). Sichtbar wird er nur, wenn der Nutzer
  selbst handeln muss (Einmalcode, Sicherheitsprüfung, Anmeldung über die
  Einstellungen); danach wird er wieder versteckt.
- Statuszeile oben im Hauptfenster zeigt den aktuellen Schritt bzw. „Wartet auf dich“.
- Übergabekarte hat nur noch „Ich bin fertig – prüfen“; „Browser nach vorne“ entfällt,
  weil das Fenster bei einer Übergabe selbst nach vorne kommt.
- Neue Werkzeuge: chrome_elements (nummerierte Bedienelemente),
  chrome_interact (klicken, eintragen, auswählen, Häkchen, Taste, Hover über
  Nummer; keine Passwort-/Zahlungsfelder), chrome_navigate (Adresse, zurück,
  vorwärts, neu laden, scrollen).
- website_login: Seiten ohne <form>, bis zu drei Schritte (E-Mail, dann Passwort),
  mehr Feld- und Knopfvarianten, Enter als Rückfall, Knöpfe fremder
  Anmeldedienste werden nie gedrückt. Bei Anmeldeseiten mit gespeichertem Konto
  meldet James sich selbst an statt zu übergeben.
- CAPTCHAs werden weiterhin nicht gelöst oder umgangen.
- LM Studio als Textanbieter (OpenAI-kompatibler lokaler Server, Standard
  http://127.0.0.1:1234/v1), mit Modellauswahl und Live-Status in den Einstellungen.
- Prüfung: Typecheck, 1.994 Tests bestanden, check-browser-login-ui und
  check-maps-ui bestanden. Installer: dist/James-Jarvis Setup 1.3.7.exe.
- Nachtrag: website_login meldet „rejected“, wenn die Website die Daten ablehnt;
  neue Werkzeuge chrome_wait_for und chrome_close_tab; höchstens zehn Tabs im
  unsichtbaren Browser. Alle drei Browser-Prüfskripte bestanden, 2.016 Tests.
- Nicht geprüft: echter LM-Studio-Server, echte Anmeldung, unsichtbares Fenster
  in der installierten App.

# Anmeldung mit Browser-Übergabe – lokale Ergänzung 13.10.2026

- Neues Werkzeug chrome_prepare_login öffnet eine HTTPS-Website im James-Browser
  und verwendet dessen vorhandene Sitzungen. Zugangsdaten in URLs werden abgelehnt.
- Erkannte Passwort-/Einmalcodefelder und menschliche Sicherheitsprüfungen werden
  an den Nutzer übergeben. CAPTCHA-/Bot-Schutz wird nicht gelöst oder umgangen.
- Eigene Karte mit „Browser nach vorne“ und „Ich bin fertig – prüfen“. Sie läuft
  nicht nach fünf Minuten ab. Die zweite Aktion fordert eine neue Zustandsprüfung
  an; sie bestätigt keine Anmeldung und löst keine automatische Prüfung aus.
- Chrome-Klicks und Eingaben pausieren bei erkannten Prüfungen. Die Erkennung
  berücksichtigt typische Titel, Hinweise und sichtbare Widgets. Sie ist
  heuristisch und deckt nicht jede Website ab. Passwort- und Codefelder werden
  auch anhand ihres tatsächlichen Feldtyps erkannt.
- Nach einem Tabwechsel verwenden Lesen/Klicken/Ausfüllen den fokussierten oder
  zuletzt ausgewählten Tab. Seitenlesen entfernt keine Navigation oder andere
  Elemente mehr aus der echten Website.
- Prüfung: TypeScript und Produktionsbuild bestanden, 1.948 Tests bestanden.
  scripts/check-browser-login.cjs prüft mit vollständig simulierten Webseiten
  im lokalen Chrome: Pause statt Klick/Eingabe, Anmeldung, HTTPS-Regeln,
  Seitenprüfung danach, unveränderte Navigation und Übergabekarte.
  scripts/check-browser-login-ui.cjs prüft die Karte und Aktionen in Electron,
  schmale Darstellung und das Erhalten über die normale Karten-Ablaufzeit hinaus.
  Screenshots: out/audit/browser-login-ui*.png.
- Keine echte Anmeldung, keine echten Zugangsdaten, kein echter CAPTCHA-Test.
  Kein neuer Installer gebaut; nichts installiert oder veröffentlicht.

# Kontext und Hermes-Funktionen – lokale Ergänzung 13.10.2026

- Arbeitsgedächtnis mit Ziel, Entscheidungen, Ergebnissen, nächsten Schritten,
  Blockaden und Plan. `context_checkpoint` speichert, `context_status` liest.
  `plan_update` aktualisiert automatisch den lokalen Arbeitsstand. Speicherung
  atomar in working-context.json im Benutzerprofil; ein Neustart stellt offene
  Aufgaben pausiert wieder her und setzt laufende Planschritte auf offen.
- Kontextkarte mit Vorschau, „Aufgabe fortsetzen“ und Zurücksetzen. Das
  Zurücksetzen löscht Arbeitsstand und Gesprächsverlauf, erhält Skills und
  Langzeiterinnerungen und startet die Gesprächsverbindung neu.
- Fertigkeiten-Bibliothek über den neuen Button oder `/skills`: suchen,
  Anleitung lesen und gezielt anwenden. Passende Skills und Erinnerungen werden
  beim Textauftrag vor unpassenden neuesten/häufigsten Einträgen priorisiert.
- Lokale vollständige Gesprächsbeiträge werden nun in der bereits vorhandenen
  Gesprächsdatenbank gespeichert (maximal 1.000 Einträge). Prompt-Rückblick:
  sechs Beiträge aus höchstens zwölf Stunden; `session_search` durchsucht den
  erhaltenen Wortlaut. Systemmeldungen wie Timer werden nicht aufgenommen.
- Normale Gemini-/Ollama-Historien werden an vollständigen Gesprächszügen
  gekürzt, ohne Werkzeugaufrufe von ihren Antworten zu trennen. Frühere
  Kontextnotizen überleben weitere Kürzungen; ursprüngliche Vorgaben und jüngere
  Beiträge bleiben in der begrenzten Notiz erhalten. Verdichtung ist verlustbehaftet.
- Der lokale Hermes-Gateway erhält jetzt Persona, passende Erinnerungen und
  Jarvis-Arbeitsstand. Er nutzt seine eigenen tatsächlich vorhandenen Werkzeuge;
  Jarvis-Werkzeugnamen machen keine zusätzlichen Hermes-Werkzeuge verfügbar.
- Desktop-Arbeitsstand wird nicht in Telefon-/Alexa-Systemprompts aufgenommen;
  Unteragenten können ihn nicht über context_checkpoint überschreiben.
- Quellen für das Konzept: offizielle Hermes-Dokumentation
  https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching
  Eigene TypeScript-Implementierung, kein kopierter Hermes-Code.

Prüfung: TypeScript und Produktionsbuild bestanden; 1.937 Tests bestanden.
Zusätzliche Electron-Prüfungen: scripts/check-context-ui.cjs und
scripts/check-learning-ui.cjs (Wiederherstellung, realer Checkpoint-Aufruf,
Speicherung/Rückblick/Löschen, Bibliothek, schmale Darstellung, Lernvorschläge).
Screenshots unter out/audit/context-hermes-ui*.png. Hermes-Gateway im Test simuliert;
echte Mikrofon-, Konto- und Hermes-Installationsläufe bleiben offen.
Kein neuer Installer gebaut, nichts installiert oder veröffentlicht.

# Lokale Ergänzung – 13.10.2026

- Selbstverbessernde Fertigkeiten erscheinen als Vorschlagskarte mit aufklappbarer
  Vorschau, bisheriger Anleitung, „Übernehmen“ und „Verwerfen“. Hintergrundlernen,
  skill_save und skill_patch schreiben erst nach Übernahme. Bei inzwischen
  geänderter Anleitung wird die Übernahme abgewiesen. Vorschläge liegen nur im
  Speicher (höchstens zehn); ein Neustart verwirft sie.
- Gesprächsansicht mit bis zu 80 Untertitelzeilen, kopierbarem Text und Vorschlägen
  abhängig von Gespräch und Werkzeugfehlern. Laufende Aufgaben sperren die
  Vorschlagsbuttons. Dies ist ein lokaler Sitzungsverlauf, keine dauerhafte Chathistorie.
- Prüfung: TypeScript, Produktionsbuild, 1.926 bestehende Tests und zusätzlicher
  Electron-Oberflächentest (scripts/check-learning-ui.cjs). Test prüft Vorschau,
  Verwerfen, tatsächliches Speichern, Konflikt mit zwischenzeitlicher Änderung,
  schmale Darstellung und Rendererfehler. Screenshots: out/audit/self-improvement-ui*.png.
- Kein Installer gebaut, nichts installiert oder veröffentlicht. Echte Sprach-
  und Modellläufe bleiben ungetestet. Fehlerwebsite unverändert.

# James-Jarvis Update 1.3.6 – 12.10.2026

## Selbstverbessernde Fertigkeiten (nach Hermes)

- Liest James eine Fertigkeit mit `skill_view` und weicht der Ablauf danach ab
  (Fehler, Umweg, fehlender Schritt), überarbeitet die Lernschleife genau diese
  Fertigkeit – auch bei kurzen Abläufen. Lief alles wie beschrieben, bleibt sie.
- Neues Werkzeug `skill_patch`: ersetzt eine Stelle in einer Fertigkeit, statt
  sie neu zu schreiben (wie Hermes' `skill_manage patch`).
- Gilt nur bei eingeschalteter Einstellung „Fertigkeiten lernen“, nicht im
  Sparmodus oder Spielemodus.

Prüfung: TypeScript bestanden, 1.926 Tests bestanden. Echte Lernläufe offen.
Versionsnummer: package.json bleibt 1.3.4; die Release-Action zählt Lauf 2 dazu.

## Vorheriges Update 1.3.4 – 11.10.2026

## Fähigkeitslücken melden

Sagt James „das kann ich nicht“ oder fehlt ihm ein Werkzeug, entsteht ein
Bericht für die Fehlerwebseite: Anfrage, Antwort, erkannter Grund,
Lösungsvorschlag, beteiligte Werkzeuge, Kanal, App-Version.

- Quellen: Ablehnung in der Antwort (Live, Realtime, Kaskade, getippt, Handy-Text,
  Alexa), gescheiterte Werkzeuge (unbekannt, keine Treffer in `tool_search`,
  ungültige Argumente) und das neue Kernwerkzeug `report_capability_gap`, mit dem
  das Modell selbst beschreibt, was man bauen müsste.
- Einstellung: Zugänge → Optionale Fehlerberichte → „Fähigkeitslücken mit
  Gesprächsausschnitt senden“. Standard aus. James kann sie nicht selbst einschalten.
- Vor dem Versand entfernt: E-Mail, Telefonnummern, IBAN, Schlüssel, Passwörter/PINs,
  Linkpfade, Benutzerordner. Namen können bleiben.
- Grenzen: zusammengeführt je Anfrage, gleiche Lücke höchstens alle 12 h, höchstens
  12 Berichte pro Stunde. Anrufer, die nicht der Besitzer sind, werden nie gemeldet.
- Fehlerwebseite (`error-dashboard/`): Feld `kind`, Reiter „Fähigkeitslücken“,
  Häufigkeit, „Erledigt“, Markdown-Export für das nächste Update. Lücken nur mit
  `JARVIS_REPORT_TOKEN` auf dem Server. Kaputte Sonderzeichen behoben.
- Empfänger jetzt `https://fastidious-pastelito-1f1564.netlify.app/api/error-report`
  (dort läuft die Fehlerwebseite). Die alte, nie bereitgestellte Voreinstellung
  `aimarketer-electronics` wird beim Start umgestellt.
- **Noch offen (Freigabe nötig):** neue Fassung von `error-dashboard/` dort
  bereitstellen, `JARVIS_REPORT_TOKEN` setzen, Token in der App eintragen.
- Bekannte Lücke: Kaskade mit Gemini-Audio ohne Werkzeugaufruf liefert keine
  Abschrift der Frage; solche Ablehnungen werden nicht gemeldet.
- Datenschutz-Entwurf um §7 ergänzt; rechtliche Prüfung offen.

Prüfung: TypeScript bestanden, 1.926 Tests bestanden, Fehlerwebseite 11/11,
Oberflächentest und Karten-Oberflächentest bestanden.
Installer: `dist/James-Jarvis Setup 1.3.4.exe`, SHA-256
`9AC2CE36FCB772312325F7D5FF8BC0C9257487B6CCF3126AA63C18336D86DA1F`.
Nicht installiert, nicht veröffentlicht.

## Vorheriges Update 1.3.3 – 11.10.2026

- ElevenLabs: Wird die Schlüssel-Kennung statt des Schlüssels eingetragen, erscheint eine klare Meldung (echter Schlüssel beginnt mit `sk_`); keine endlosen Wiederholungen mehr. Neuer Regressionstest.
- Prüfung: TypeScript bestanden, 1.858 Tests bestanden, Karten-Oberflächentest bestanden.
- Installer: `dist/James-Jarvis Setup 1.3.3.exe`, SHA-256 `8D6F11198987EB253D5CDCC50686A51184DDF95F9B5C056CB6C60CF571403F80`.
- Nicht installiert, nicht veröffentlicht. Mikrofon- und Kontoprüfungen offen.

## Vorheriges Update 1.3.2


## Dateien für GitHub

Das geprüfte Update liegt zusätzlich im Ordner `GitHub-Update-1.3.2`:
Windows-Installer, Blockmap, `latest.yml`, SHA-256-Prüfsumme sowie die
Release-Beschreibung `GitHub-Update-1.3.2/UPDATE.md` und eine Upload-Anleitung.
Die Dateinamen entsprechen exakt den Update-Metadaten. Die Installation auf
diesem PC wurde erneut geprüft: Version 1.3.2 läuft und das installierte
Paket stimmt mit dem geprüften Build überein.

Die großen Binärdateien sind lokal vorhanden und per `.gitignore` vom
Quellcode-Commit ausgenommen; sie werden als GitHub-Release-Anhänge verwendet.
Es wurde in diesem Schritt nichts auf GitHub veröffentlicht.

## Antwort-Stabilität

Der Nutzer meldete ausbleibende Antworten bei Sprache und Texteingabe. Konkrete
Hänger und Rennen im gemeinsamen Antwortablauf wurden mit Regressionstests
reproduziert und abgesichert:

- Gemini Live und OpenAI Realtime setzen Mikrofon-Sperre, Werkzeugzustand und
  Antwortanzeige bei Verbindungsabbrüchen zurück. Bleibt eine erwartete Antwort
  45 Sekunden aus, melden sie das und bauen die Verbindung erneut auf.
- Gleichzeitig gestartete Verbindungen teilen denselben Aufbau. Stoppen,
  Pause und Anbieterwechsel verhindern verspätete Rückrufe alter Sitzungen.
- Der Aufbau der Sprachwege und lokale Sprachausgabe sind zeitlich begrenzt.
  Hängende Modell-, IPC- und Stream-Aufrufe lassen sich abbrechen.
- Ollamas Zeitlimit gilt bis zum vollständigen Antwortinhalt. Gemini erhält
  ein Gesamtzeitlimit; ChatGPT und Hermes warten beim Abbruch nicht auf
  blockierte Stream-Bereinigung.
- Texteingaben funktionieren auch während einer ausstehenden Mikrofonfreigabe.
  Fehlgeschlagene Sendungen werden gemeldet und im Textfeld wiederhergestellt.
- Das Löschen einer Fehlermeldung entfernt auch ihren Fehlerzustand.

Anfragen werden nach Verbindungsfehlern nicht automatisch erneut ausgeführt:
bereits ausgeführte Werkzeuge könnten sonst doppelte Aktionen verursachen.
Der Nutzer kann die Anfrage selbst wiederholen.

## Prüfung und Installation 1.3.2

Erneute Installation auf ausdrücklichen Nutzerwunsch am 09.10.2026 durchgeführt:
Installer-Exitcode 0, App neu gestartet, Version 1.3.2.0 und identisches
installiertes Paket bestätigt. Desktop- und Startmenü-Verknüpfung starten beide
die aktuelle EXE. Zusätzliche Profilsicherung:
`%LOCALAPPDATA%\James-Jarvis-Update-Backups\2026-10-09-1.3.2-1467a48e`.

- **1.857 Tests bestanden**, keine Fehler oder übersprungenen Tests; 58 neue Regressionstests.
- TypeScript-Prüfung, Produktionsbuild und Diff-Prüfung bestanden.
- Electron-Oberflächentest mit isoliertem Profil bestanden, einschließlich
  wiederhergestellter Texteingabe nach Sendefehler und sichtbarer Fehlermeldung.
- Karten-Oberflächentest bestanden; keine Rendererfehler.
- Windows-Installer erstellt und Paket geprüft: aktuelle Main-/Renderer-Dateien
  stimmen mit dem Build überein; Modelle und Windows-Helfer vorhanden, Auditdaten ausgenommen.
- Installer-Exitcode **0**; installierte EXE mit Produktversion **1.3.2.0**.
  Installiertes `app.asar` entspricht bytegenau dem geprüften Paket.
- Installierte App gestartet; neues Startprotokoll ohne Rendererabsturz,
  unbehandelte Ausnahme oder Entschlüsselungsfehler.

Installer: `dist/James-Jarvis Setup 1.3.2.exe`.
SHA-256: `44C7328BCDA2787B2F09E9469791593E1E515E6147B0BE8580BB16A6B274A97B`.
Prüfsummendatei: `dist/James-Jarvis Setup 1.3.2.exe.sha256`.
Installationsordner: `%LOCALAPPDATA%\Programs\Void Jarvis\Void James`.

Profilsicherung vor der Installation:
`%LOCALAPPDATA%\James-Jarvis-Update-Backups\2026-10-09-1.3.2-f8f32378`.
Die Datenbank wurde konsistent über `VACUUM INTO` kopiert und mit
`PRAGMA quick_check` geprüft. Die Sicherung enthält persönliche Daten und
verschlüsselte Zugänge und bleibt lokal.

Details: `docs/Antwort-Stabilitaet-2026-10-09.md`.
Protokolle: `out/audit/reliability-1.3.2-*.log`. Keine Veröffentlichung auf GitHub.
Der Build meldet weiterhin große Renderer-Bündel; kein Signier-Zertifikat konfiguriert.

Bestehende Änderungen und persönliche Profile wurden erhalten.
Ein separater Electron-Zugangscheck konnte die verschlüsselten
Profile nicht entschlüsseln; daraus lässt sich kein fehlender Zugang in der
installierten App ableiten. Echte Kontoantworten und Mikrofontests bleiben offen.

## Vorheriges Update 1.3.1 – 09.10.2026

## Inhalt

Dieses lokale Update bündelt den aktuellen Arbeitsbaum einschließlich der bereits
vorhandenen Verbesserungen: Karten und Ortssuche, Routenübersichten, Antwortkarten,
Sprach-/Anmeldekorrekturen und weiterer Stabilitätsarbeit. Einzelheiten stehen in
`README.md` und `docs/Karten-Pruefung-2026-10-09.md`.

In diesem Durchlauf ergänzt:
- Auto-Updater registriert Ereignisse und Intervall nur einmal.
- Während Download, Installationsbereitschaft und Installation keine neue Prüfung.
- Neue Downloads löschen alte Fehlermeldungen und die alte Aufschubentscheidung.
- Fehler beim direkten Installationsstart werden abgefangen; das geladene Update
  bleibt bereit und wird für einen späteren Versuch zurückgestellt.
- Versionsstand auf 1.3.1 erhöht; `CLAUDE.md` verweist auf diese Übergabedatei.

## Prüfung

- TypeScript-Prüfung bestanden.
- Vollständige Testsuite: 1.799 Tests bestanden vor den Update-Änderungen.
- Nachprüfung nach den Änderungen: erneut 1.799 Tests bestanden, keine Fehler.
- Produktionsbuild und Windows-NSIS-Installer erfolgreich erstellt.
- Electron-Oberflächentest mit isoliertem Profil bestanden: echte Vektorkacheln,
  Orte, Routen, Quellen, Termine, Ziehen/Zoomen und Ausblenden; gefährliche Links
  abgewiesen, keine Rendererfehler.
- Screenshot: `out/audit/maps-answer-cards.png`.
- Testprotokoll der Nachprüfung: `out/audit/update-1.3.1-tests.log`.

## Dateien und Grenzen

Installer: `dist/James-Jarvis Setup 1.3.1.exe`.
SHA-256-Prüfsumme wird nach erfolgreichem Build daneben gespeichert.
Keine Veröffentlichung auf GitHub in diesem Durchlauf.

Echte Mikrofonerkennung, persönliche Kontoanmeldungen und sämtliche externen
Integrationen sind hier nicht vollständig geprüft. Öffentliche Kartendienste
können ausfallen; Routen bleiben Übersichten mit den im Kartenbericht genannten
Grenzen. „Alles verbessern“ ist kein Nachweis, dass sämtliche Funktionen fehlerfrei
sind; dokumentiert werden nur tatsächlich ausgeführte Prüfungen.

## Abschlussstatus

Installation abgeschlossen: Installer-Exitcode 0, Windows-Deinstallationseintrag
`James-Jarvis 1.3.1`, installierte EXE mit Produktversion `1.3.1.0`.
Installationsordner: `%LOCALAPPDATA%\Programs\Void Jarvis\Void James`.
Vorheriger Stand laut Windows: Void James 1.2.8.
Die installierte App wurde gestartet.

Profilsicherung vor der Installation:
`%LOCALAPPDATA%\James-Jarvis-Update-Backups\2026-10-09-1.3.1`.
Sie enthält Einstellungen, Daten und verschlüsselte Zugangsdaten und bleibt lokal.
Installer-Prüfsumme: `dist/James-Jarvis Setup 1.3.1.exe.sha256`.

Der Build meldet bestehende Hinweise auf große Renderer-Bündel und gemischte
statische/dynamische Imports. Kein Code-Signing-Zertifikat ist konfiguriert.
