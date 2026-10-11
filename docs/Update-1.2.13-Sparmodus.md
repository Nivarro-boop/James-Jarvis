# Update 1.2.13 — Sparmodus und Verbindung

## Änderungen

OpenAI Realtime übernimmt jetzt den Sparmodus auch während einer laufenden Sitzung. Aktiviert werden ein Gesprächsbudget von 8.000 Token nach den Anweisungen, ein Beibehaltungsverhältnis von 80 Prozent bei Kürzung und maximal 2.048 Ausgabetoken pro Antwort. Alte Gesprächsinhalte können entfallen. Eine wegen des Ausgabelimits unvollständige Antwort meldet dies ausdrücklich. Bei ausgeschaltetem Sparmodus gelten wieder automatische Standardkürzung und keine zusätzliche Ausgabetokenbegrenzung der App.

Dies ergänzt die vorhandenen Maßnahmen: kompakte Werkzeugergebnisse, schlanke beziehungsweise nachgeladene Werkzeugdefinitionen, begrenzter Verlauf für Textmotoren, Zwischenspeicherung geeigneter Aufrufe und lokale Filterung von Stille. Der Sparmodus ist standardmäßig aktiviert; eine vom Nutzer gespeicherte abweichende Einstellung bleibt bestehen. Keine pauschale oder gemessene Prozentersparnis wird behauptet.

Die Hermes-Verbindungsprüfung versucht bei nicht erreichbarem Gateway den verwalteten Start der vorhandenen lokalen Installation. Das ist kein Nachweis einer erfolgreichen Hermes-Modellverbindung. Mikrofonfehler unterscheiden nun verweigerten Windows-Zugriff, fehlendes Eingabegerät und andere Aufnahmefehler. Die vorhandene Wiederaufnahme bei Gerätewechsel bleibt aktiv.

## Tests

TypeScript, Produktionsbuild, Electron-Oberflächenprüfung und 1.689 automatisierte Tests bestanden. Ein neuer Realtime-Test prüft die tatsächlich gesendete Sitzungskonfiguration sowie die Übernahme eines Sparmoduswechsels in laufender Sitzung. Die API-Verbindung ist im Test simuliert.

## Verbleibende Voraussetzungen

In der letzten Gesamtprüfung war kein nutzbares Mikrofon in der Ausführungsumgebung verfügbar. Persönliche Zugänge waren nicht lesbar oder fehlten. Deshalb sind echte Spracherkennung, Anbieterantworten, die tatsächliche Hermes-Modellausführung und gemessene Tokenersparnis noch nicht bestätigt. „Hey James“ benötigt weiterhin einen eigenen Klassifikator; vorhanden ist „Hey Jarvis“.

## Technische Grundlage

OpenAI beschreibt die Begrenzung des Realtime-Kontexts und retention_ratio in der [offiziellen Dokumentation zur Kostenoptimierung](https://developers.openai.com/api/docs/guides/voice-latency-cost).
