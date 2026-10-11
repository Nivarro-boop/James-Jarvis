# Void James 1.2.11

## Umsetzung

- OpenAI Realtime und ElevenLabs besitzen direkt unter der Sprachauswahl ein Passwortfeld zum Speichern und Prüfen des API-Schlüssels.
- Der OpenAI-Test fordert einen kurzlebigen Realtime-Zugang für das ausgewählte Modell an. Er prüft damit mehr als die allgemeine Modellliste. Der Einstellungsrenderer erhält dabei kein Token. Fehlender Schlüssel, ungültige Zeichen, Projektberechtigung, Modellzugriff, Guthaben, Anfragelimit und Netzfehler werden unterschieden.
- ElevenLabs zeigt fehlende Schlüssel, fehlende Modelle und eine zu hohe Credit-Reserve ausdrücklich an. Die vorhandene Hörprobe bleibt verfügbar. ElevenLabs liefert Sprache; ein gesonderter Denkmotor erledigt die Aufträge.
- Der Agentenplan erscheint in der zentralen Live-Ansicht mit den Zuständen offen, läuft, erledigt und fehlgeschlagen. Ein Stoppen-Knopf unterbricht die Sprachsitzung und deren laufende Werkzeugaufrufe.
- Hermes-Unteragenten reichen Fortschrittsmeldungen an die Live-Anzeige weiter. Der Agentenprompt verlangt konkrete Ausführung, geprüfte Werkzeugergebnisse und ehrliche offene Schritte.
- Realtime beendet beim Unterbrechen den Wartezustand und zeigt nach Werkzeugergebnissen wieder die laufende Antwortbearbeitung an.
- Frühere Reparatur-, Log- und Alt-Menüleistenänderungen bleiben enthalten.

## Verifikation

- TypeScript-Prüfung bestanden.
- 1.688 automatisierte Tests bestanden, keine fehlgeschlagenen Tests.
- Produktionsbuild bestanden.
- Electron-Oberflächenprüfung in einem ausdrücklich isolierten Testprofil bestanden: Hauptfenster, Diagnose, Log, Alt ohne Menüleiste, OpenAI-Einrichtung samt tatsächlichem fehlenden Schlüssel, ElevenLabs-Einrichtung und fehlende Hermes-Auswahl.
- Die neuen Realtime-Tests prüfen Token-Anforderung, ausgewähltes Modell, fehlenden beziehungsweise ungültigen Schlüssel und Anbieterablehnungen. Es wurden simulierte HTTP-Antworten verwendet.

## Noch nicht bestätigt

Die erfolgreiche Sprachverbindung mit den persönlichen OpenAI-/ElevenLabs-Zugängen, echte Audiowiedergabe, das Mikrofon und eine reale Hermes-Aufgabe wurden nicht Ende zu Ende bestätigt. Im vorhandenen Profil waren Zugänge nicht lesbar oder fehlten. Der Zugangstest in der App liefert jetzt die konkret fehlende Voraussetzung. Er bestätigt bei OpenAI die Token-Erstellung, nicht den vollständigen Audio-WebSocket und dessen Wiedergabe.

Die App erzeugt keine externen API-Schlüssel oder API-Guthaben. Eine ChatGPT-Anmeldung ersetzt keinen OpenAI-Realtime-Zugang. Hermes benötigt weiterhin eine vollständige lokale Installation und ein eingerichtetes Modellprofil.

Der zentrale Stoppen-Knopf unterbricht die aktuelle Sitzung; separat gestartete Hintergrundrecherchen und Zeitpläne benötigen ihre eigenen Abbruchfunktionen.
