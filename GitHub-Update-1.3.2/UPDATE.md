# James-Jarvis 1.3.2

Update vom 9. Oktober 2026: zuverlässigere Antworten bei Sprache und Texteingabe.

- Verbindungsabbrüche lösen Mikrofon-Sperren sowie festhängende Antwort- und Werkzeugzustände.
- Bleibt eine erwartete Live-Antwort aus, meldet James das und baut die Verbindung neu auf.
- Starten, Stoppen, Pause und Anbieterwechsel sind gegen verspätete alte Sitzungen abgesichert.
- Hängende Modell-, IPC- und Stream-Aufrufe lassen sich abbrechen und haben Zeitlimits.
- Lokale Sprachausgabe gibt das Mikrofon auch nach einem fehlenden Abschlussereignis wieder frei.
- Texteingaben funktionieren während einer ausstehenden Mikrofonfreigabe. Fehlgeschlagene Sendungen bleiben als Entwurf erhalten.
- Ollamas Zeitlimit gilt auch für den vollständigen Antwortinhalt.

Prüfung: **1.857 Tests bestanden**, dazu TypeScript-Prüfung, Produktionsbuild,
Electron-Oberflächentest, Kartenprüfung und Kontrolle des fertigen Windows-Pakets.
58 Regressionstests wurden ergänzt. Echte Mikrofonerkennung und persönliche
Kontoantworten sind noch nicht vollständig geprüft.

Der Windows-Installer aktualisiert eine vorhandene Installation. Für dieses
Update wurde das lokale Profil vor der Installation gesichert. Nach einem
Verbindungsfehler werden Werkzeugaktionen nicht automatisch erneut ausgeführt.
