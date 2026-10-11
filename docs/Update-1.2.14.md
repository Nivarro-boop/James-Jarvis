# Update 1.2.14

## Wetter und Standort

Wetterfragen ohne Ortsangabe verwenden den unter Zugänge gespeicherten Standardstandort. Ein expliziter Ort hat Vorrang. Ohne gespeicherten Ort kommt eine konkrete Einrichtungsmeldung. Es findet keine automatische GPS- oder IP-Ortung statt. Für andere, bisher nicht ortsbezogene Werkzeuge wurde keine pauschale Standortlogik ergänzt.

Die neue Karte enthält Temperatur, Luftfeuchte, Wind, einen stündlichen Verlauf mit Umschaltung zwischen Temperatur, Niederschlagswahrscheinlichkeit und Wind sowie bis zu sieben Vorhersagetage. Karte und gesprochene Antwort stammen aus derselben Wetterabfrage. Stundenangaben gelten für den abgefragten Ort. Datenquelle ist [Open-Meteo](https://open-meteo.com/en/docs). Die Wetterkarte lässt sich schließen.

## Automatische Komprimierung

Der bestehende Sparmodus komprimiert den Realtime-Kontext automatisch und begrenzt Textverläufe; ChatGPT erhält kurze lokale Notizen über verworfene Textwechsel. Dafür wird kein zusätzlicher kostenpflichtiger Zusammenfassungsaufruf gestartet. Die bisherigen Grenzen und der Verlust älterer Details sind im Bericht zu 1.2.13 beschrieben. Eine automatische Komprimierung beliebiger Dateien ist nicht enthalten.

## Optionale Diagnoseübermittlung

Unter Zugänge kann eine eigene HTTPS-Empfängeradresse eingerichtet werden. Der Versand ist standardmäßig aus, ein Empfängerwechsel deaktiviert ihn wieder. Nach bewusstem Aktivieren erfolgt Versand ausschließlich über den Knopf „Statistik senden“.

Der feste JSON-Inhalt enthält schema, appVersion, platform, problems und healed. Keine Fehlermeldungstexte, Gesprächsinhalte, Zugangsdaten, Namen, Gerätekennungen oder Standorte werden übertragen. IP-Adresse und Übertragungszeit sind technisch für den Empfänger sichtbar; vollständige Netzwerkanonymität wird nicht zugesagt. Weiterleitungen werden nicht verfolgt. Es gibt keinen voreingestellten Codex- oder OpenAI-Empfänger. In dieser Sitzung wurde keine Diagnose an einen Server gesendet.

## Prüfung

TypeScript und Produktionsbuild bestanden. 1.690 automatisierte Tests bestanden. Neuer Wettertest prüft Standardort, explizite Ortsangabe und fehlenden Standardstandort mit simulierten Anbieterantworten. Electron-Prüfung bestätigt Karte, Ansichtswechsel, Schließen und bisherige Bedienabläufe. Das visuelle Prüfbild verwendet ausdrücklich gekennzeichnete Testdaten.

Die tatsächliche Annahme eines Diagnoseberichts durch deinen Server wurde mangels Empfängeradresse nicht geprüft. Eine echte Wetterabfrage mit deinem Standort und echte Sprachbefehle sind damit ebenfalls nicht bestätigt.
