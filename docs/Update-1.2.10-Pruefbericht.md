# Void James 1.2.10

## Änderungen

- Permanente Live-Ansicht unter der Kugel mit Bearbeitungsphasen, Auftrag, Antwort, Werkzeugaktionen, Laufzeit und Fehlerdetails.
- Getippte Aufträge wechseln in Gemini Live und OpenAI Realtime sofort in den Bearbeitungszustand. OpenAI berücksichtigt zusätzlich den serverseitigen Antwortbeginn und streamt Antwortuntertitel.
- Reparatur im Hauptfenster baut die gewählte Sprachsitzung tatsächlich neu auf und wartet auf eine bestätigte Verbindung. Fehlende Mikrofonaufnahme, fehlende Zugänge und Zeitüberschreitungen werden als Fehler gemeldet.
- Reparatur aus den Einstellungen fordert den Sprachneustart im Hauptfenster an. Dieser läuft asynchron; eventuelle Verbindungsfehler erscheinen dort.
- OpenAI-Verbindungsfehler werden sichtbar, statt unbemerkt zu Gemini zu wechseln.
- Hermes ist keine auswählbare Denk- oder Zugangsalternative mehr. Die interne Agentenfunktion bleibt erhalten.
- Der Alt-Menüleisten-Fix bleibt enthalten.

## Prüfung

- TypeScript: bestanden.
- Automatisierte Tests: 1.685 bestanden, 0 fehlgeschlagen. Enthält einen neuen Test für den Zustandswechsel bei getippten Realtime-Aufträgen und serverseitigem Antwortbeginn.
- Produktionsbuild: bestanden.
- Electron-Oberflächenprüfung: Hauptfenster, Telemetrie, Diagnose, Reparatur bei fehlendem Zugang, Logknopf, Einstellungen und Alt ohne Menüleiste bestanden.

## Verbleibende Grenzen

Im vorhandenen Windows-Profil waren die gespeicherten Zugänge nicht lesbar beziehungsweise nicht vorhanden. Auch die ChatGPT-Anmeldung konnte nicht bestätigt werden. Eine echte OpenAI-/Gemini-Sprachsitzung, die erfolgreiche Sprachreparatur mit gültigen Zugangsdaten und die Weckwort-Erkennung mit dem tatsächlichen Mikrofon sind daher nicht Ende zu Ende bestätigt. Die automatisierten Tests verwenden simulierte Verbindungen.

Bitte Zugänge innerhalb der App erneut einrichten. Ein ChatGPT-Abonnement ersetzt keinen OpenAI-Realtime-API-Zugang. Selbstheilung kann fehlende Schlüssel, fehlende Kontingente und eine erforderliche Anmeldung nicht automatisch erzeugen.
