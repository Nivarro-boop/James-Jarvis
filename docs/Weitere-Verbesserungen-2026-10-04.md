# Weitere Verbesserungen für James

Quellcodeprüfung nach Update 1.2.2. Die folgende Liste unterscheidet nachgewiesene Fehler, belegte Grenzen und Verbesserungsmöglichkeiten. Sie ist keine Garantie, dass alle Fehler gefunden wurden. In diesem Prüfschritt wurde Produktcode nicht verändert.

## Zuerst beheben

| Priorität | Fundstelle | Befund und sinnvolle Änderung |
| --- | --- | --- |
| Hoch | `src/renderer/audio/capture.ts:67` | Scheitert das Laden des AudioWorklets, werden weder Mikrofonspuren gestoppt noch der AudioContext geschlossen. Reproduziert mit dem echten Modul und simulierten Geräten: null geschlossene Kontexte, null gestoppte Spuren. Den gesamten Aufbau mit Fehlerbereinigung absichern. |
| Hoch | `src/renderer/audio/player.ts:38` | Auch der Ausgabeaufbau lässt beim fehlgeschlagenen Worklet-Laden einen AudioContext offen. Gleicher Test: null geschlossene Kontexte. Fehler beim Aufbau und beim Resume müssen den Kontext schließen. |
| Hoch | `src/renderer/live/RealtimeSession.ts:411` | Dieser Sprachmotor wartet unmittelbar auf `tools:call`. Ein Abbruch fordert zwar Werkzeugabbruch an, löst aber nicht selbst das wartende IPC-Promise. Eine ausgebliebene Antwort kann den Werkzeugzustand festhalten. Wie bei Cascade und Gemini Live einen abbrechbaren Wartepfad mit Zeitgrenze ergänzen. |
| Hoch | `src/main/providers/text.ts:101` und `:120` | Das Abbruchsignal wird an ChatGPT und Gemini weitergegeben, aber nicht an die Aufrufe für Ollama, OpenRouter, OpenAI und Anthropic. Die Prüfungen vor und nach dem Aufruf ersetzen den Netzwerkabbruch nicht. Das Signal durch die jeweiligen Anbieterfunktionen bis zum HTTP-Aufruf durchreichen. |
| Mittel | `src/main/providers/openrouter.ts:99` und `:115` | Die direkte Spracherkennung und Modellabfrage haben kein eigenes AbortSignal/Zeitlimit. Ein Netzwerkproblem kann diese Wege lange warten lassen. Zeitgrenzen und Abbruch ergänzen; Fehlermeldungen bei der Modellabfrage erhalten. |
| Mittel | `src/main/index.ts:502` | Beim Start öffnet sich die Einrichtung allein wegen eines fehlenden Gemini-Schlüssels. James unterstützt inzwischen weitere Anbieter und lokale Kombinationen. Die Prüfung sollte den tatsächlich gewählten Zuhörer, Denkmotor und Sprecher berücksichtigen. |
| Mittel | `src/main/agent/desktopAgent.ts:274` | Der Bedienbaum-Plan wird per TypeScript-Typbehauptung übernommen; `actions` wird nicht zur Laufzeit als Aktionsliste validiert. Gültiges JSON mit falscher Struktur ist damit kein sauber behandelter Plan. Aktionen, Pflichtfelder, Referenzen und Zahlen validieren und strukturelle Fehler verständlich behandeln. |

## Verbrauch und Geschwindigkeit

| Priorität | Befund | Verbesserung |
| --- | --- | --- |
| Hoch | Vier Gesprächsrunden sind kein Gesamtbudget: Bildsteuerung erlaubt im Sparmodus 15 Schritte, der Bedienbaum zwölf Runden und delegierte Aufgaben haben eigene Schleifen. Siehe `computer.ts:427`, `desktopAgent.ts:48`, `subagent.ts:37`. | Ein gemeinsames Budget pro Nutzerauftrag für Modellaufrufe, Bildaufrufe und Unteragenten einführen. Bei Erreichen einen ehrlichen Zwischenstand liefern; keine unbemerkte neue Schleife starten. |
| Hoch | Die Tokenanzeige berichtet geschätzte Einsparungen. Tatsächliche ChatGPT-Nutzungszahlen stehen bislang nur im Protokoll, siehe `chatgptResponses.ts:63`, `tokenSaver.ts:249`, `sections.tsx:2860`. | Tatsächlich gemeldeten Verbrauch pro Frage und Anbieter anzeigen. Einsparschätzungen separat und ausdrücklich als Schätzung kennzeichnen. Fehlende Verbrauchsdaten dürfen nicht als null erscheinen. |
| Mittel | Für Mausaktionen und das Verstehen realer Mikrofone gibt es noch keinen vollständigen Live-Nachweis aus dieser Sitzung. Die bestehenden Tests simulieren Modellantworten und Eingaben. | Eine kleine wiederholbare Abnahme in einem eigens geöffneten Testprogramm und mit dem echten Mikrofon durchführen: Wecken, Satzanfang, Unterbrechen, folgende Frage, Bedienbaum, Bild-Rückfall und Abbruch. Während Fortnite wurde dies bewusst nicht ausgeführt. |
| Mittel | Die kürzere Screenshot-Wartezeit ist ein fester Wert. Manche Programme laden länger, andere sofort. | Auf sichtbare Zustandsänderungen warten statt überall feste Pausen zu verwenden; eine Obergrenze verhindert endloses Warten. Unter verschiedenen Ladezeiten testen. |

## Weitere sinnvolle Verbesserungen

- Ein sichtbarer Zustand „Zuhören / Abschrift / Denken / Werkzeug / Sprechen“ mit dem tatsächlichen Grund eines Fehlers. So lässt sich unterscheiden, ob der Auftrag verstanden wurde oder nur die Ausgabe ausfällt.
- Ein Gaming-Profil, das Hintergrunddownloads, lokale Modellstarts und größere Hintergrundaufgaben gezielt begrenzt. Die Wirkung anschließend mit CPU-, Speicher- und Antwortzeitmessungen prüfen; eine bloße niedrigere Prozesspriorität garantiert keine ruckelfreie Nutzung.
- Die große Einstellungsansicht und die umfangreiche IPC-Brücke schrittweise in kleinere fachliche Module teilen. Das erleichtert gezielte Tests und reduziert versehentliche Wechselwirkungen.
- Ein reproduzierbares Geschwindigkeitsprotokoll: Dauer bis zur Abschrift, bis zum ersten Antworttext und bis zur ersten Desktop-Aktion. Erst danach konkrete Geschwindigkeitsgewinne behaupten.

Prüfung: wichtige Gesprächs-, Audio-, Anbieter-, Werkzeug-, Start- und Desktop-Pfade im Quellcode untersucht; zwei Audiofehler gezielt mit den echten Modulen reproduziert. Kein echter Mikrofonzugriff, keine Modellanfrage, kein Browserstart und keine Maus- oder Tastatureingabe. Die Update-Datei 1.2.2 enthält diese zusätzlich gefundenen Punkte noch nicht als Korrekturen.
