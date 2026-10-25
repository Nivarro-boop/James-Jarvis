# GitHub-Update: ruhige Orb-Ansicht

24.10.2026. Die beiden runden Knöpfe unter dem Orb sowie „Beheben & senden“
in der Kopfzeile sind entfernt. Schreiben und Mikrofonpause bleiben im Menü;
Kugel und Hotkey bleiben bedienbar. Protokollierte Störungen erscheinen als
Loghinweise; ein aktueller Fehlerzustand bleibt als Fehler erkennbar.

Im lokalen Log stand ein unbehandelter ECONNRESET-Verbindungsabbruch. Der
alte Stack erlaubt keine eindeutige Zuordnung zur Ursprungsverbindung. Der
Companion schützt nun auch abgewiesene WebSocket-Upgrades vor unbehandelten
Socket-Fehlern und räumt fehlerhafte HTTP-Verbindungen auf. Ein Regressionstest
simuliert einen Reset nach abgelehntem Handshake. Es werden keine allgemeinen
Fehler pauschal unterdrückt oder alten Diagnoseeinträge gelöscht.

Die Veröffentlichung umfasst außerdem die bereits lokal geprüften Änderungen
an Handy-Audio, QR-Kopplung, Remote-Play-Anmeldung, Computer-Abbruch und
kompakteren Einstellungen. Die native Watch-Erweiterung bleibt ohne Apple-Build
und Gerätetest; der kostenlose James Store bietet den Web-/Kurzbefehl-Weg.

Vor Veröffentlichung: Typecheck, Gesamttests und Desktop-Oberflächenprüfung.
GitHub prüft den Pull Request erneut und erstellt nach dem Merge das öffentliche
Windows-Update. Die Release-Action addiert ihre Laufnummer zur Basisversion;
daher ist die veröffentlichte Versionsnummer höher als 1.3.12.
