# Computer Use und Tokenverbrauch — 4. Oktober 2026

## Funktionsstand

Der echte Windows-Eingabedienst wurde gestartet, per `ping` geprüft und danach
beendet. Ergebnis: `ok=true`. Es wurden keine Mausbewegungen, Klicks oder
Tastatureingaben auf dem laufenden Desktop ausgeführt.

`desktop_task` bevorzugt den Windows-Bedienbaum und plant jetzt über den
eingestellten Textanbieter statt fest über Gemini. Erfolgreich gelernte
Abläufe bleiben lokal gespeichert und können ohne weiteren Modellaufruf
abgespielt werden. Der Test prüft Planung und anschließendes Abspielen.

Bei gewähltem ChatGPT verwenden `computer_task` und `screenshot` jetzt die
ChatGPT-Anmeldung und das ausgewählte Kontomodell. Die Aktionen laufen als
normale lokale Funktionswerkzeuge. Die offizielle Abo-Schnittstelle erlaubt
[Bildinputs und Funktionswerkzeuge, jedoch kein gehostetes natives Computer Use](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
Das Kontomodell muss Bilder verarbeiten können. Gemini bleibt für den
entsprechend ausgewählten Weg verfügbar. Ein echter ChatGPT-Modellaufruf
wurde in dieser Prüfung nicht ausgeführt.

## Einsparungen

- Im Sparmodus höchstens 15 statt 30 Bildschritte pro Auftrag. Bei Erreichen
  der Grenze wird der Auftrag als nicht abgeschlossen gemeldet.
- Nur die letzten drei vollständigen Bildschritt-Paare werden mitgesendet.
  Beim Kürzen bleiben benötigte Gemini-Signaturen erhalten; verwaiste
  Werkzeugantworten werden entfernt. Das aktuelle Ziel wird erneut mitgegeben.
- Es werden nur das aktuelle Bildschirmbild und gegebenenfalls aktuelle
  Zoom-Ausschnitte gesendet. Die einfache Bildschirmbeschreibung nutzt im
  Sparmodus zwei statt vier Bildkacheln.
- Der gespeicherte ChatGPT-Gesprächskontext ist auf etwa 6.000 Zeichen begrenzt.
  Ältere lange Assistentenantworten werden auf 2.000 Zeichen gekürzt und
  entsprechend markiert. Vollständige Dialogpaare bleiben zusammen.
- Große Zahlen- und Wahrheitswertlisten verbrauchen jetzt das Budget der
  Werkzeugergebnis-Kürzung. Vorher konnte eine Zahlenliste unbegrenzt wachsen.
- Einfache Aufgaben erfordern keinen zusätzlichen Planaufruf mehr.
  Unteragenten werden für umfangreiche unabhängige Arbeit vorgesehen;
  kurze Aufgaben sollen ohne doppelte Modellarbeit ausgeführt werden.
- Textaufgaben berücksichtigen das angegebene Ausgabelimit nun auch bei Gemini.
  Die ChatGPT-Abo-Schnittstelle erhält weiterhin keine dort unzulässigen
  `max_output_tokens`-Parameter.

Der Sparmodus und gekürzte Werkzeugdeklarationen sind in beiden vorhandenen
Benutzerprofilen bereits eingeschaltet. Es wurden keine Kontozugangsdaten oder
Profileinstellungen geändert. Die Abrechnung hängt weiter vom gewählten
Modell, dem Kontingent und der Aufgabe ab; eine reale Ersparnis in Prozent
wurde nicht gemessen.

## Prüfung

**1.647 Tests bestanden**, ohne Fehler oder übersprungene Tests. Acht neue
Tests prüfen Zahlenlisten, Gesprächskürzung, gültige Bildverläufe, Schema-
Umwandlung, den Responses-Bildrequest, die tatsächliche Computer-Schleife mit
simulierten Eingaben, gelernte Bedienbaumabläufe und korrekte Abbruchmeldungen.
Der Bild-Rückfall erhält jetzt das Abbruchsignal des ursprünglichen Auftrags
und meldet ein abgebrochenes Ergebnis nicht mehr als erledigt.

TypeScript-Prüfung und Produktions-Build sind erfolgreich. Die lokal gebaute
Windows-Fassung liegt unter `dist/win-unpacked`. Prüfungen und Paketbau liefen
nacheinander mit niedriger Prozesspriorität. James wurde nicht gestartet und
der laufende Desktop wurde nicht zur Bedienprobe angefasst.

Die 7.628 Dateien des fertigen ASAR-Pakets stimmen mit ihren SHA-256-Prüfsummen
überein. Beide Windows-Steuerungsskripte entsprechen dem geprüften Quellstand.
Das Paket enthält die neuen Begrenzungen und keine Tests, Diagnoseartefakte,
Build-Logs oder Typprüfungs-Zwischendaten.
