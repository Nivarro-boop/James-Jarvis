# Verbindungen und Tokenverbrauch

## Änderungen

- Frontend: ChatGPT-Anmeldung auch unter **Verbindungen**, Schutz vor parallelen Anmelde-/Ladeaktionen und erneut ladbare Modelle. Fehler einer Timer-Abfrage verdecken die Verbindungsergebnisse nicht mehr. Die Übersicht zeigt den Prüfzeitpunkt und unterscheidet unbestätigte von fehlgeschlagenen Verbindungen.
- Backend: Gleichzeitig angeforderte Verbindungsprüfungen teilen dieselbe laufende Abfrage. Ein fehlgeschlagener Browser-Tab beeinträchtigt die übrigen Dienste nicht. Abgeschlossene Ergebnisse werden dabei nicht zwischengespeichert.
- ChatGPT: Gleichzeitige Modellabfragen werden gebündelt. Ein Kontowechsel macht die automatische Modellauswahl ungültig; verspätete Modelllisten des alten Kontos werden verworfen. Ein Abbruch während der Modellsuche beendet das Warten, ohne andere Abfragen abzubrechen.
- Kontext: Textmodelle mit eigenem Gesprächsverlauf erhalten die letzten Gesprächsbeiträge nicht zusätzlich im Systemtext. Ohne eigenen Verlauf bleibt der lokale Rückblick verfügbar. Auch außerhalb des Sparmodus wird der Verlauf jetzt nach Zeichen begrenzt; vollständige Werkzeugpaare und kurze Zusammenfassungen bleiben erhalten.
- Verbrauch: Getrennte Anzeige der vom Anbieter gemeldeten Eingabe-, Ausgabe-, Cache- und Denk-Token für die letzten bis zu 100 abgeschlossenen ChatGPT-Anfragen seit dem Start. Fehlende Angaben bleiben als unbekannt erkennbar. Ein Knopf stellt das empfohlene Sparprofil ein.

Die Größenbegrenzung betrifft vergangenen Kontext, nicht die aktuelle Nutzereingabe. Gekürzte Details müssen bei Bedarf erneut gelesen werden. Ein identischer Promptanfang kann Cache-Wiederverwendung ermöglichen; er garantiert keinen Cachetreffer ([offizielle OpenAI-Dokumentation](https://developers.openai.com/api/docs/guides/prompt-caching)). Die tatsächliche Einsparung ist ohne vergleichbare Nutzungsdaten noch nicht gemessen.

## Prüfung

- `npm run typecheck`: erfolgreich.
- `npm test`: 2.128 Tests erfolgreich.
- Zusätzlich ergänzter Test `node scripts/run-tests.mjs connection-probes-regression`: erfolgreich.
- `npm exec -- electron-vite build`: erfolgreich; Hinweise auf große Chunks und bereits gemischte statische/dynamische Imports.
- `git diff --check`: erfolgreich.

Regressionstests prüfen unter anderem parallele Abfragen, Wiederholung nach Fehlern, Kontowechsel, Abbruch während der Modellsuche, isolierte Browserfehler und begrenzte Verläufe mit erhaltenen Nutzerbedingungen und Werkzeugpaaren.

Echte Kontoanmeldungen, Anbieter-Verfügbarkeit, die Darstellung in der laufenden Desktop-App und Apple Health auf dem iPhone wurden in diesem Durchlauf nicht getestet. Kein Installer oder Release veröffentlicht.
