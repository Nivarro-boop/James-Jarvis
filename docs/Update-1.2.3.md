# Update 1.2.3

Enthält die bisherigen Änderungen aus 1.2.2 sowie die Korrekturen aus der weiteren Quellcodeprüfung.

- Fehler beim Audioaufbau stoppen die Mikrofonspuren und schließen den Audiokontext.
- Realtime-Werkzeuge haben eine Abbruch- und Zeitgrenze; alte Ergebnisse werden nach Abbruch nicht in neue Antworten übertragen.
- Cloud-, OpenRouter- und Ollama-Textanfragen erhalten Abbruchsignale und Zeitgrenzen.
- Die Einrichtung verlangt Gemini nur, wenn die gewählte Sprachpipeline es benötigt.
- Desktop-Pläne werden vor der Ausführung auf gültige Aktionen, Referenzen und Pflichtfelder geprüft. Bei unverändertem Bild nach einer Aktion erfolgt eine begrenzte zusätzliche lokale Screenshotprüfung.
- Im Sparmodus teilen Gesprächsrunden, lokale Werkzeuge und eingebundene Unteragenten ein Budget von zwölf Modellaufrufen pro Auftrag. Ein neuer Auftrag hat ein neues Budget. Bei Erschöpfung wird ein Fehler/Zwischenstand gemeldet; kein Erfolg behauptet.
- Die Sparanzeige kennzeichnet geschätzte Einsparungen und zeigt zusätzlich tatsächlich gemeldete ChatGPT-Token sowie die Dauer der letzten abgeschlossenen Antwort. Fehlende Tokenangaben bleiben unbekannt. Es werden höchstens die letzten hundert abgeschlossenen ChatGPT-Anfragen seit Programmstart gespeichert, ohne Gesprächstext.
- Gaming-Modus unter Einstellungen → Sparmodus: niedrigere Hauptprozesspriorität, keine automatischen Lern-/Gedächtnisarbeiten, kein geplanter Startdownload lokaler Ressourcen und kein verzögertes Symbolvorladen. Bereits laufende Downloads, explizite lokale Modellaufträge und GPU-Last werden dadurch nicht beendet; ruckelfreies Spielen ist keine Garantie.
- Die bisherigen Korrekturen für ChatGPT-Anmeldung, Klatschen nach Schlafmodus, Satzanfang, stumme Antworten, Computer Use und automatische Erinnerungen bleiben enthalten.

Grenzen: Native Gemini-Live-/OpenAI-Realtime-Antworten und intern ausgeführte Aufrufe eines externen Hermes-Gateways sind nicht vollständig durch den lokalen Modellzähler sichtbar. Dies ist kein hartes Token- oder Geldbudget und keine Kontingentanzeige. Die Nutzungsanzeige gilt derzeit für ChatGPT, nicht für alle Anbieter. Die große Einstellungsansicht und IPC-Brücke wurden nicht vollständig umgebaut; Budget, Nutzungsbericht und Startprüfung sind eigenständige Module.

Validierung: 1.666 automatisierte Tests bestanden. Keine kostenpflichtige Modellanfrage, kein echtes Mikrofon und keine reale Maus-/Tastaturaktion während Fortnite. Eine Anmeldung mit dem echten Benutzerkonto und eine praktische Sprach-/Desktop-Abnahme stehen weiterhin aus. Build und Installerprüfung werden separat im Releaseprotokoll erfasst.
