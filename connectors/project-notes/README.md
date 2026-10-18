# Projekt-Notizen: ein eigener James-Connector

Ein lauffähiger lokaler MCP-Server zum Erweitern: James kann einen ausdrücklich
gewählten Notizordner auflisten, durchsuchen und einzelne `.md`-/`.txt`-Dateien lesen.
Er verwendet die bereits installierten Pakete `@modelcontextprotocol/sdk` und `zod`.
Es werden keine weiteren Pakete installiert.

## Start und Verbindung

Im Projektverzeichnis mit einem vorhandenen Node.js starten:

```powershell
node connectors/project-notes/server.mjs "C:/Meine freigegebenen Notizen"
```

Der Prozess wartet anschließend auf MCP-Nachrichten über stdin/stdout. Das ist kein
Terminal-Chat. stdout ist ausschließlich für das Protokoll reserviert; eigene
Diagnosen müssen mit `console.error(...)` auf stderr gehen.

In James unter **Einstellungen → MCP-Server** die Datei `example-config.json`
importieren und beide Beispielpfade durch absolute, vorhandene Pfade ersetzen.
`node` muss erreichbar sein; alternativ den absoluten Pfad zu `node.exe` verwenden.
Die Vorlage aktiviert sich nicht selbst. Der ausgewählte Ordner wird beim Start
auf seinen tatsächlichen Dateisystempfad aufgelöst und bleibt die Freigabegrenze.

## Werkzeuge

| Werkzeug | Argumente | Ergebnis |
| --- | --- | --- |
| `notes_list` | `limit` 1–100, Standard 50 | Relative Dateipfade, Größe, Änderungszeit |
| `notes_search` | `query` 2–200 Zeichen, `limit` 1–20 | Wörtliche Treffer ohne Beachtung der Großschreibung mit kurzen Auszügen |
| `notes_read` | `path` aus der Liste, etwa `Projekt/Plan.md` | Text, Herkunft und Kennzeichen einer Kürzung |

Jede Quelle nennt Connector, relativen Pfad, Dateigröße und Änderungszeit. Inhalt
aus Notizen ist Quelldaten und darf keine Systemanweisungen oder Freigaben ersetzen.

## Grenzen

- Nur lesend: keine Änderungen, Löschungen, Netzwerkaufrufe, Anmeldung oder Schlüsselverwaltung.
- Ausschließlich der gewählte Ordner; keine absoluten Dateipfade, `..`, versteckten
  Pfadbestandteile, Windows-Datenströme, Symlinks oder Junctions innerhalb der Freigabe.
- Versteckte Einträge werden ausgelassen. Wähle einen eigenen Notizordner ohne
  Zugangsdaten: Freigegebene Textinhalte können an den in James gewählten Modellanbieter gehen.
- Höchstens 1.000 Verzeichniseinträge, 200 Notizdateien und fünf Unterordnerebenen je Abruf.
- Höchstens 64 KiB pro gelesener Datei, 2 MiB gelesener Text pro Suche, 20 Suchtreffer,
  12.000 Zeichen pro Notiztext und 48.000 Zeichen pro Protokollausgabe.
- `truncated` und die mitgegebenen Grenzen zeigen, wann eine Liste/Suche unvollständig ist.
  Große oder nicht lesbare Dateien werden bei der Suche gezählt und übersprungen.
- Dies ist ein Starter für einen vom Nutzer verwalteten lokalen Ordner, keine
  Betriebssystem-Sandbox gegen einen bösartigen Prozess mit gleichzeitigem Schreibzugriff.

## Prüfen und erweitern

```powershell
npm test -- --low-resource project-notes-connector.test.ts
```

Die Tests starten einen echten Serverprozess mit dem SDK-Client und temporären
Dateien. Zum Erweitern neue `register(...)`-Aufrufe mit Zod-Eingabeschema ergänzen;
Dateizugriffe weiterhin durch `checkedPath` und `readNote` führen. Zusätzliche
schreibende Werkzeuge brauchen eigene, bewusst begrenzte Rechte und dürfen nicht
die `readOnlyHint`-Kennzeichnung dieses Beispiels übernehmen.
