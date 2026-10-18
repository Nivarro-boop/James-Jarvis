# Innenleben und Konnektoren – geprüfter lokaler Stand vom 16.10.2026

Die Arbeiten ergänzen den [Oberflächenbericht](Verbesserungen-2026-10-16.md).
Quellcode und Produktionsbuild wurden geprüft. Paketversion weiterhin 1.3.7;
kein neuer Installer, keine Veröffentlichung und keine Änderung persönlicher Konten.

## Geschwindigkeit

Skill-Dateien werden nach dem ersten Lesen als geparste Inhalte wiederverwendet.
Dateiidentität, Größe sowie Änderungs- und Metadatenzeiten werden weiter geprüft;
externe Änderungen, neue und gelöschte Dateien bleiben sichtbar. Schreiboperationen
entwerten den passenden Eintrag. Aufrufer erhalten eigene Kopien.

Die Werkzeugsuche verwendet vorbereitete Suchtexte erneut, prüft aber bei jeder
Suche die aktuelle Registry. Neue, entfernte oder geänderte Konnektorwerkzeuge
bleiben dadurch auffindbar beziehungsweise verschwinden unmittelbar.

Messung mit isolierten Testdaten: 200 Skill-Dateien und 500 Werkzeuge.

| Lokale Operation | Vorher | Nachher |
| --- | ---: | ---: |
| Skill-Index für einen Prompt, Median | 25,904 ms | 14,494 ms |
| Inhaltslesevorgänge bei 120 warmen Skill-Abfragen | 24.000 | 0 |
| Werkzeugsuche, Median | 0,572 ms | 0,136 ms |

Wiederholbar mit `node scripts/benchmark-local-indexes.cjs`. Ein weiterer Lauf
während der Abschlussprüfung ergab 15,729 ms und 0,118 ms bei weiterhin null
wiederholten Inhaltslesevorgängen. Das misst lokale Verarbeitung, keine garantierte
Beschleunigung des Modellanbieters, der Sprache oder des Netzwerks.

## Kontext

- Arbeitsgedächtnis und sichtbarer Plan haben eine gemeinsame Quelle. Eine
  Zielkorrektur oder ein Zurücksetzen lässt keinen veralteten Live-Plan zurück.
- Normalisierte Titel erhalten bestehende Entscheidungen und passende Pläne.
  Zurückgegebene Zustände lassen sich nicht unbemerkt von außen verändern.
- Nach einem unterbrochenen Speichern kann eine vollständige temporäre Datei
  wiederhergestellt werden. Eine lesbare bestätigte Datei hat Vorrang.
- Wiederhergestellte Aufgaben bleiben pausiert. Unerledigte Planschritte werden
  nicht als erledigt ausgegeben; ungültige Zeitstempel werden bereinigt.
- Ein übergroßer neuer Textaustausch verschwindet im Sparmodus nicht mehr einfach.
  Anfang und Ende des aktuellen Auftrags bleiben nach Möglichkeit erhalten;
  Kürzungen werden gekennzeichnet. Werkzeugaufrufe und Antworten bleiben paarig.
  Passen deren Metadaten nicht hinein, wird der vollständige Werkzeugabschnitt
  durch eine ausdrückliche Textnotiz ersetzt. Inline-Audio wird nicht erneut hochgeladen.
- Auch JSON-Escaping und die Notiz zu früheren Beiträgen zählen beim 6.000-Zeichen-
  Budget mit. Kürzung ist verlustbehaftet und kein unbegrenztes Gedächtnis.

## Konnektor-Bibliothek

**Einstellungen → Konnektoren** bündelt die vorhandenen Einrichtungswege für
Google Kalender, Gmail/Yahoo, Home Assistant, Spotify/Apple Music, WhatsApp,
Alexa und Telefon/Handy. Diese Karten öffnen die vorhandenen Einstellungen;
sie behaupten keine bestehende Kontoverbindung.

Zusätzliche Vorlagen: Playwright, Dateisystem, GitHub, Notion, Linear,
Higgsfield und Brave Search. Die Dateisystemvorlage beschränkt ihren Start auf
den Dokumente-Ordner. Konten, Dienstberechtigungen und ein gegebenenfalls nötiger
lokaler Node-/npx-Aufruf müssen tatsächlich verfügbar sein.

Eigene Anbindungen lassen sich per Serveradresse, JSON-Konfiguration oder
lokalem Befehl ergänzen. Ein JSON-Import zeigt vor dem Start eine Vorschau.
Die Übersicht zeigt getrennt eingetragene und verbundene Server sowie die Zahl
geladener Werkzeuge. Fehlgeschlagene Verbindungen werden nicht als Erfolg gemeldet.

GitHub verwendet die offizielle Remote-Adresse mit einem vom Nutzer hinterlegten
Personal Access Token. HTTP-Header enthalten in den Einstellungen nur Referenzen;
Tokenwerte liegen im verschlüsselten Keystore. Auch wörtlich importierte Header
werden daraus entfernt. Der Vorlagenexport liest keine Keystore-Werte aus.
Ungültige Protokolle, Zugangsdaten/Token in URLs, doppelte Header und Zeilenumbrüche
in Headerwerten werden abgelehnt. HTTP bleibt für Loopback-Server möglich.

Der MCP-Lebenszyklus startet höchstens drei Konnektoren gleichzeitig und fasst
gleichzeitige identische Ladeaufträge zusammen. Er lädt paginierte Werkzeuglisten,
erkennt ungültige Cursor, verarbeitet Änderungsbenachrichtigungen und entfernt
Werkzeuge geschlossener Verbindungen. Fehlgeschlagene Starts werden bereinigt.
Werkzeugaufrufe bekommen Abbruchsignal und Zeitlimit. Fremde Prozesse erhalten
die kleine Betriebssystemumgebung des SDK und ausdrücklich konfigurierte Werte,
keine pauschale Kopie sämtlicher Prozessvariablen. Beschädigte Werkzeugnamen
werden mit stabilen Zusätzen kollisionsarm registriert.

### Eigenes Plugin

Unter [connectors/project-notes](../connectors/project-notes/README.md) liegt ein
lauffähiger eigener MCP-Konnektor für Markdown-/Textnotizen mit Auflisten, Suche
und Einzelabruf. Er benötigt einen ausdrücklich gewählten Ordner und arbeitet
nur lesend. Pfadgrenzen, Junctions/Symlinks, Dateigrößen und Ausgabegrenzen werden
geprüft. Jede Quelle nennt ihren relativen Pfad und Änderungsstand.

Das ist eine Vorlage für eigene lokale Erweiterungen, kein automatisch aktivierter
Dienst und keine Betriebssystem-Sandbox für beliebige Fremdprogramme.

### Quellen für die vorbereiteten Dienstanschlüsse

- [Offizieller GitHub MCP Server](https://github.com/github/github-mcp-server)
- [Notion: Verbindung mit MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)
- [Linear: MCP](https://linear.app/docs/mcp)
- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [MCP-Dateisystemserver](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)

## Prüfung

- `npm run typecheck`: bestanden.
- `npm test -- --low-resource`: **2.054 Tests bestanden**, keine ausgelassenen Tests.
- `npm run build`: bestanden; bekannte Vite-Hinweise zu Bündelgrößen und gemischt
  statisch/dynamisch importierten Modulen bleiben bestehen.
- `node scripts/check-workspace-ui.cjs`: gebaute Electron-App, drei Fenstergrößen,
  Eingabe, Entwürfe, Stoppen, Rechercheergebnis und Einstellungssuche bestanden.
- `node scripts/check-connectors-ui.cjs`: Katalogsuche, Weiterleitung zur Kalender-
  und Smart-Home-Einrichtung, Header-Anmeldung, Importvorschau, Export, Fehler und
  Wiederholung sowie schmale Darstellung mit simuliertem Backend bestanden.
- `node scripts/check-conversation-ui.cjs`: Streaming, Leseposition, Kopieren,
  Sprung zur neuesten Nachricht und schmale Darstellung bestanden.
- `node scripts/check-context-ui.cjs`: tatsächliche lokale Speicherung,
  Wiederaufnahmeabsicht, Gesprächsrückblick und Zurücksetzen ohne Skill-Verlust bestanden.
- `node scripts/check-ui.cjs`: bestehende umfassende Electron-Prüfung bestanden,
  einschließlich fehlgeschlagenem Textversand, Diagnose, verschlüsseltem Speichern/
  Löschen eines Diagnosetokens und anonymisiertem Versand an einen simulierten Empfänger.
- Neuer eigener Notiz-Konnektor über echten SDK-Client und separaten Node-Prozess
  getestet, einschließlich Lesegrenzen und Junction-/Pfadsperren.
- MCP-Lebenszyklus mit simulierten Verbindungen auf Parallelitätsgrenze, Paginierung,
  Änderungsnachrichten, Trennung und Bereinigung getestet.
  Weitere Regressionen prüfen das Abbrechen eines interaktiven Wartens beim Beenden,
  das Weiterreichen von Zeitlimits und Abbruchsignalen sowie irreführende
  Read-only-Kennzeichnungen bei schreibenden Werkzeugnamen.

Echte Dienstkonten wurden nicht angemeldet, keine zusätzlichen Pakete global
installiert und keine E-Mails oder Nachrichten verschickt. Live-Berechtigungen,
Mikrofonhardware und externe OAuth-Verbindungen bleiben echte Einrichtungstests.
