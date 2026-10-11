# Nachprüfung vom 4. Oktober 2026

Die Startseite zeigt unter der Texteingabe kein Erinnerungsformular mehr.
Erinnerungen werden über Sprache oder Texteingabe angelegt und automatisch
zugestellt. Die vorhandene Verwaltung bleibt in den Einstellungen erreichbar.
Die Terminverwaltung und Windows-Benachrichtigung bleiben im Hauptprozess;
das zuvor unverbundene Ereignis `reminder:due` ist jetzt mit der Sprachausgabe
verbunden. Bei pausierter Stimme bleibt die Windows-Benachrichtigung verfügbar.
James muss für die Zustellung laufen.

Der Erinnerungsdienst verwendet den vorhandenen Datenbankindex und liest jede
Sekunde nur ausstehende, bereits fällige Termine. Tests prüfen die genaue
Fälligkeitsgrenze und dass gemeldete oder verschobene Termine nicht erneut
ausgewählt werden. Die vorhandenen Prüfungen für Persistenz, Wiederholung und
fehlgeschlagene Zustellung bleiben erhalten.

Die Kugel berechnet höchstens etwa 30 Bilder pro Sekunde, bei fehlendem
Fensterfokus zehn und bei reduzierter Bewegung 15. Bei ausgeblendetem Fenster
wird die Animationsschleife gestoppt und bei Sichtbarkeit wieder gestartet.
Ein Test treibt die echte Zeichenroutine mit simulierten 240-Hz-Bildimpulsen
an und prüft Begrenzung, Wiederaufnahme und Freigabe der Ereignislistener.
Eine FPS-Messung mit Fortnite wurde nicht durchgeführt.

`npm test -- --low-resource` führt Testdateien einzeln mit niedriger Priorität
aus und begrenzt esbuild auf zwei Go-Ausführungsthreads. Der Hintergrundtimer
der Lernschleife hält beendete Prozesse nicht mehr offen. Das Lernen läuft
weiterhin automatisch, solange die Anwendung läuft.

Ein zusätzlicher Test lädt den echten Renderer-Einstieg und prüft, dass eine
Erinnerung den Sprachcontroller erreicht und der Listener beim Schließen
entfernt wird. Die Formulierung behandelt Erinnerungstexte als vorzulesenden
Inhalt und fordert keine Werkzeugausführung daraus an.

Prüfung: vollständige Testsuite mit 1.629 bestandenen Tests, ohne Fehler oder
übersprungene Tests; TypeScript-Prüfung und Produktions-Build erfolgreich.
Der abschließende Testlauf dauerte rund 13 Sekunden. Der Build meldet
weiterhin einen Hinweis zur Größe des Renderer-Bündels.

Die Prüfungen laufen ohne gestartete James-Oberfläche, echte Mikrofonaufnahme
oder Modellkonten. Sprache und Windows-Benachrichtigung wurden in dieser
Nachprüfung nicht auf dem laufenden Desktop ausprobiert, damit das Spiel
ungestört bleibt. Es wurde kein Installer gebaut und keine App neu gestartet.
