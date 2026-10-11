# Update 1.2.8 — Prüfung vom 7. Oktober 2026

## Änderungen

- Weckwort: PCM-Amplituden bleiben im 16-Bit-Wertebereich. Die Mel-Vorstufe bekommt 480 Samples Überlappung und damit acht vollständige Frames statt unvollständiger Daten. Regressionstest prüft Werte, Überlappung, endliche Features und Reset.
- Persönliches Update enthält den unveränderten openWakeWord-Klassifikator für „Hey Jarvis“. Der tatsächliche Modellname bestimmt die angezeigte Aktivierungsphrase. Lizenz: CC BY-NC-SA 4.0, ausschließlich nichtkommerzielle Nutzung; Attribution in THIRD_PARTY_NOTICES.md. Der normale Download holt diesen Klassifikator nicht automatisch.
- ChatGPT-Einrichtung wählt bei leerer Auswahl das erste vom Konto angebotene Modell. Status und Modelle können nach Fehlern erneut geladen werden. Anmeldefehler werden im bereinigten Dateilog erfasst.
- Gemini: `gemini-3.8-live` als aktuelle Standardauswahl. Alte Modellnamen bleiben auswählbar; bei Nichtverfügbarkeit erfolgt höchstens ein Modellwechsel pro Sitzung.
- OpenAI Realtime: Fehlgeschlagene Antworten werden sichtbar gemeldet und protokolliert. Aus fehlgeschlagenen Antworten werden keine Werkzeugaufrufe ausgeführt. Endgültig gescheiterte Verbindungen liefern einen Logeintrag mit Ursache.
- Fehlerkarte oben rechts: offene Störungen, „Ja, reparieren“, Reparaturergebnis, Logzugang und Link zur Einrichtung. Verfügbare Laufzeitreparaturen nutzen das vorhandene Selbstheilungssystem.
- Diagnose erkennt fehlende Zugänge, unlesbare Anmeldungen und fehlende Weckwort-Dateien. Nach erfolgreicher Konfiguration schließen diese Einträge beim nächsten Prüflauf. Die Klassifikation erhält den ursprünglichen Anbieter aus weitergeleiteten Renderer-Logs.
- GUI zeigt Sprachweg, Aktivierung sowie laufende und abgeschlossene Aktionen zusätzlich zur vorhandenen Aktionsanzeige.
- Nachkorrektur: Menü in Haupt- und Einstellungsfenster vollständig entfernt. Alt blendet keine Menüleiste mehr ein; in beiden echten Electron-Fenstern geprüft. Gemini-Auswahl benennt jetzt ausdrücklich den benötigten API-Schlüssel statt „inklusive“.
- Bestehendes Dateilog bleibt aktiv: Zeitstempel, bereinigte Zugangsdaten, Rotation und automatische Fehlerbeobachtung. Keine Zugangsdaten stehen im Prüfbericht.

## Bestätigte Tests

- `npm run typecheck`: erfolgreich.
- `npm test`: 1.683 Tests bestanden (423 Test-Suites), 0 fehlgeschlagen, 0 übersprungen.
- `node scripts/check-wakeword.mjs`: alle drei echten ONNX-Dateien geladen; acht Mel-Frames, 96 Embedding-Dimensionen, gültiger Klassifikatorwert. Stille ergibt im technischen Test ungefähr 0,0000029.
- `node scripts/check-ui.cjs`: echte Electron-Oberfläche mit isoliertem Testprofil und simuliertem Mikrofon. Startseite, Telemetrie, Fehlerkarte, Prüflauf, Reparaturergebnis, Logknopf und Öffnen der Einstellungen erfolgreich geprüft.
- Windows-Installer für x64 gebaut. Testausgaben unter `out/audit` sind vom Installer ausgeschlossen.

## Echte lokale Zugänge und verbleibende Grenzen

`npx electron scripts/check-provider-access.cjs` prüft gespeicherte Zugänge, ohne Schlüssel, Token oder Kontonamen auszugeben. Ergebnis auf diesem Rechner:

- Installiertes Profil „Void Jarvis“: Schlüsselspeicher konnte nicht gelesen werden. Die gespeicherte ChatGPT-Anmeldung konnte ebenfalls nicht erfolgreich geprüft werden.
- Entwicklungsprofil „void-jarvis“: kein Gemini- oder OpenAI-Schlüssel und keine ChatGPT-Anmeldung vorhanden.

Deshalb sind erfolgreiche echte ChatGPT-Anmeldung, Gemini-Live-Unterhaltung und OpenAI-Realtime-Unterhaltung **nicht bestätigt**. Die Anmeldeprotokolle, Abbruchwege, PKCE, Erneuerung und Realtime-Lebenszyklen sind durch automatisierte Tests geprüft. Ein nicht lesbarer Zugang kann nicht durch Neustarten repariert oder ohne neue Freigabe rekonstruiert werden.

Nach Installation: Gemini/OpenAI-Schlüssel erneut eintragen und prüfen; ChatGPT im Browser erneut anmelden. Danach je Anbieter ein kurzes Gespräch mit dem echten Mikrofon führen. „Hey Jarvis“ zusätzlich mit der eigenen Stimme und Hintergrundgeräuschen testen. Der ONNX-Test bestätigt Verarbeitung und Dateikompatibilität, keine Erkennungsquote am realen Mikrofon.

Das Update ersetzt die App; die vorhandenen Datenordner bleiben über die bisherige Pfadlogik erhalten. Diese Arbeit veröffentlicht kein GitHub-Release.

## Quellen

- [OpenAI: Registrierung und Anmeldung](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI: Realtime-Konfiguration](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create)
- [Google: Live API](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- [openWakeWord: Referenz-Frontend](https://github.com/dscripka/openWakeWord/blob/main/openwakeword/utils.py)
- [openWakeWord: Modelle und Lizenz](https://github.com/dscripka/openWakeWord)
