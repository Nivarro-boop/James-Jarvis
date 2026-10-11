# Stabilitätsupdate 1.2.2

Behobene Fehler und Verbesserungen:

- Zweimal Klatschen wird wieder ausgewertet, wenn eine Sitzung eingeschlafen ist, obwohl ihr Objekt noch vorhanden ist. Die Erkennung berücksichtigt kürzere Impulse mit geringerer Mikrofonverstärkung, setzt ihre Sperrzeit beim Zurücksetzen zurück und verwirft anhaltende laute Geräusche.
- Der zusammengesetzte Sprachmodus puffert während des Verbindungsaufbaus bis zu drei Sekunden Mikrofonton lokal. Der Satzanfang wird nach dem Aufwachen nachgereicht. Ein inzwischen gestoppter Aufbau darf die Sitzung nicht wieder aufwecken.
- Abgebrochene IPC- und Modelloperationen halten den Gesprächszustand nicht mehr fest. Abschriften haben eine Wartegrenze von 30 Sekunden, ein Gesprächszug von drei Minuten. Alte Abschlussrückrufe verändern keinen neueren Denkzug.
- Nach einem Fehler mitten in der Sprachausgabe wird die Stimme abgebrochen und das Mikrofon wieder freigegeben. Leere Modellantworten führen zu einer sichtbaren Fehlermeldung statt lediglich einem Konsolenhinweis.
- ChatGPT-Antworttext wird aus dem finalen IPC-Ergebnis ergänzt, falls Streaming-Ereignisse fehlen. Bereits empfangener Text wird dabei nicht doppelt gesprochen.
- Im Gemini-Live-Modus werden IPC-Fehler als Werkzeugergebnis an das Modell zurückgegeben. Werkzeugoperationen können abgebrochen werden und haben eine Wartegrenze. Ergebnisse einer alten Verbindung werden keiner neuen Verbindung zugeschickt.
- Hängende Windows-UIA- und Eingabehelfer werden nach einer ausgebliebenen Antwort beendet. Der nächste Zugriff startet einen neuen Helfer. Verspätete Ausgabe- und Exit-Ereignisse des alten Prozesses können dessen Zustand nicht löschen.
- Windows-Aufgaben wechseln bei fehlendem Bedienbaum oder ungültigem Plan zur Bildsteuerung. Ein Kontingent- oder Anbieterfehler löst keinen zusätzlichen Bildmodellaufruf aus.
- Bildaktionsstapel warten nur zwischen Aktionen, nicht zusätzlich nach ihrer letzten Aktion. Zwischenpause: 160 statt 280 ms; Wartezeit vor dem nächsten Screenshot: 350 statt 900 ms. Explizite Ladepausen bleiben möglich.

Verifikation: **1.661 Tests bestanden**, vollständige Typprüfung bestanden. Neue Regressionstests verwenden die echten Controller-, Cascade-, Live- und Windows-Helfermodule mit simulierten Mikrofonblöcken, Anbietern und IPC-Antworten. Getestet sind unter anderem Fehler mitten in der Ausgabe, folgende Fragen, Klatschen nach Schlaf, Satzanfänge während des Aufbaus, verlorene Text-Ereignisse, Helfer-Neustarts und der Rückfall vom Bedienbaum auf Bildsteuerung. Der echte Windows-Eingabehelfer hat einen reinen Ping-Test bestanden.

Die Prüfungen liefen mit niedriger Prozesspriorität. Es wurden keine Mausbewegungen oder Tastendrücke ausgeführt, keine Mikrofonaufnahme gestartet und kein reales Modellkontingent verbraucht. Reale Klatscherkennung mit dem Mikrofon des Nutzers und vollständige Desktop-Aufgaben mit dessen Modellkonto sind damit noch nicht verifiziert. Unterschiedliche Programme und Ladezeiten können weitere Anpassungen benötigen; die Software wird nicht als vollständig fehlerfrei ausgewiesen.
