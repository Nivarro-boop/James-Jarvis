# Update 1.2.16 — geschützte Fehlerberichte

Die Fehlerbericht-Anbindung unterstützt jetzt den optionalen Bearer-Token des reparierten Netlify-Backends. Unter Einstellungen → Zugänge → Fehlerbericht-Token kann er verschlüsselt gespeichert und gelöscht werden. Er wird nur im Authorization-Header an den eingestellten HTTPS-Empfänger übertragen; nicht im Bericht, nicht im Klartext der Einstellungen.

Versand bleibt standardmäßig deaktiviert und erfolgt nur per Knopfdruck. HTTP 404 erklärt die fehlende API-Route, 401/403 den abgelehnten Zugang, 429 das Kontingent und Serverfehler das Backend beziehungsweise den Speicher. Redirects werden nicht verfolgt; das Zeitlimit beträgt zehn Sekunden. Oberfläche und Hauptprozess verhindern gleichzeitige Doppelübermittlung. Versandmeldungen werden getrennt von OpenAI-Schlüsselprüfungen angezeigt.

## Prüfung am 8. Oktober 2026

- TypeScript, Produktionsbuild und alle 1.697 automatisierten Tests bestanden.
- Fünf neue Versandtests prüfen den Vier-Felder-Vertrag, Token-Header, ausgeschlossenen Versand, HTTP-Fehler und Netzwerkfehler. Netzwerkantworten sind simuliert; kein echter Bericht wurde versandt.
- Electron-Oberfläche: Token speichern und löschen im isolierten Testprofil, deaktivierter Versand, Alt-Menüleiste, Reparaturanzeige, Wetterkarte, OpenAI-Anzeige bei fehlendem Schlüssel und ElevenLabs-Einrichtung bestanden.
- Echtes Mikrofon ohne simuliertes Audiogerät erfolgreich geöffnet: 48 kHz, aktiver Stream, messbarer Eingangspegel, drei Eingabegeräte und sechs Ausgabegeräte erkannt. Dies aktualisiert den früheren negativen Mikrofonbefund aus 1.2.12.

Das Öffnen des Mikrofons bestätigt noch nicht die Erkennung gesprochenen „Hey Jarvis“ oder echten Doppelklatschens. Für „Hey James“ fehlt weiterhin ein eigener Klassifikator. Erfolgreiche Gespräche mit OpenAI/Gemini/ElevenLabs und ChatGPT-Anmeldung sind durch diese Prüfung nicht bestätigt. Das Netlify-Backend muss noch auf dem Host der eingestellten API-Adresse bereitgestellt werden.

Nachweise: out/audit/tests-1.2.16.log, build-1.2.16.log, ui-1.2.16.log und real-microphone.json.
