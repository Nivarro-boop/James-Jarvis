# JARVIS Error Dashboard — repariert

Im ursprünglichen ZIP fehlte die komplette Backend-Funktion. Dieses Paket enthält POST/GET/OPTIONS, dauerhafte Speicherung in Netlify Blobs, die API-Weiterleitung und sichtbare Fehlermeldungen mit Zeitlimit im Dashboard.

## Bereitstellung

Das vollständige Projekt über ein verbundenes Netlify-Git-Projekt bereitstellen: Publish-Verzeichnis `public`, Functions-Verzeichnis `netlify/functions`, Node.js mindestens 20. Netlify installiert die Abhängigkeiten aus `package-lock.json`.

Alternativ aus diesem Projektverzeichnis:

```powershell
npm ci
npx netlify-cli login
npx netlify-cli link
npx netlify-cli deploy --build --prod
```

Beim Verknüpfen die richtige Website auswählen. Nur `public/index.html` per Drag-and-drop hochzuladen reicht nicht: Die Functions müssen ebenfalls bereitgestellt werden.

Eine vollständige Bereitstellung ersetzt die Website. Bei einer bestehenden anderen Website stattdessen `netlify/functions/error-report.mjs`, `netlify/lib/report-handler.mjs`, die Abhängigkeit `@netlify/blobs` und die Weiterleitung aus `netlify.toml` in deren Projekt übernehmen.

## Deine beiden Adressen

Die Fehlerwebseite läuft auf `https://jocular-otter-624907.netlify.app/` (Netlify-Projekt `jocular-otter-624907`). JARVIS sendet ab 1.3.4 an `https://jocular-otter-624907.netlify.app/api/error-report`; die frühere Voreinstellung `aimarketer-electronics` (nie bereitgestellt) wird beim Start umgestellt.

`https://resonant-shortbread-6be4b2.netlify.app/` ist ein älteres Dashboard ohne Function.

Das Dashboard verwendet zunächst `/api/error-report` auf seinem eigenen Host. Für einen getrennten API-Host dessen vollständige Adresse im Dashboard eintragen. Erfolgreiche Adressen werden lokal gespeichert. Die Dashboard-Adresse `https://resonant-shortbread-6be4b2.netlify.app` ist bereits für CORS zugelassen; weitere Ursprünge lassen sich über `JARVIS_ALLOWED_ORIGINS` kommasepariert ergänzen.

## Berichte

POST sendet beispielsweise:

```json
{"level":"error","message":"OpenAI API request failed","source":"JARVIS","details":"HTTP 429"}
```

Optional ist `kind`: `incident` (Standard, normaler Fehlerbericht) oder `capability-gap` (Fähigkeitslücke, siehe unten). Andere Werte lehnt der Server mit 400 ab.

Zeitstempel und ID werden auf dem Server erzeugt, `kind` wird mitgespeichert. Zusätzliche Felder werden nicht gespeichert. GET liefert die neuesten Berichte, maximal 200, über `?limit=200`. Mit `?kind=incident` kommen nur Fehlerberichte, mit `?kind=capability-gap` nur Fähigkeitslücken. Ohne `kind` kommen beide Arten wie bisher, damit ältere Dashboards weiter funktionieren; Lücken allerdings nur, wenn der Server einen Token hat. Netlify Blobs bewahrt Berichte über neue Deployments hinweg auf.

## Fähigkeitslücken

Sagt James, dass er etwas nicht kann, oder fehlt bzw. scheitert ein Werkzeug, sendet JARVIS einen Bericht mit `"kind":"capability-gap"`, aber nur mit eigener Zustimmung unter Einstellungen → Zugänge → „Fähigkeitslücken mit Gesprächsausschnitt senden“. `details` ist dann JSON mit `appVersion`, `platform`, `request`, `answer`, `reason`, `suggestion`, `tools`, `channel` und `sources`. Die App kürzt den Text und entfernt Schlüssel, Adressen und Nummern vor dem Versand.

- **Nur mit Token:** Lückenberichte enthalten Gesprächstext. Ohne `JARVIS_REPORT_TOKEN` antwortet der Server auf solche POSTs, auf `GET ?kind=capability-gap` und auf PATCH mit 403 („Fähigkeitslücken brauchen JARVIS_REPORT_TOKEN auf dem Server.“). Schon gespeicherte Lücken bleiben dann auch im ungefilterten GET verborgen.
- **Speicherung:** Lücken liegen unter `gap/<Zeit>-<Fingerabdruck>-<ID>`. Fehlerberichte behalten ihre bisherigen Schlüssel ohne Präfix.
- **Doppelte Meldungen:** Der Fingerabdruck entsteht wie in der App aus den sortierten Wörtern der Anfrage (länger als drei Zeichen) und den gescheiterten Werkzeugen. Gibt es unter den letzten 200 Lücken schon dieselbe, erhöht der Server `count` und setzt `lastSeen` und `lastAppVersion`, statt einen neuen Eintrag anzulegen (Antwort 200 mit `"duplicate":true`). Das geschieht als Lesen–Ändern–Schreiben ohne Sperre: Treffen zwei gleiche Meldungen gleichzeitig ein, kann ein Zähler verloren gehen oder ein zweiter Eintrag entstehen. Für eine Häufigkeit reicht das.
- **Status:** Jede Lücke hat `status` `open` (Standard) oder `done`. `PATCH /api/error-report` mit `{"id":"<ID>","status":"done"}` ändert ihn und braucht den Token. Tritt eine erledigte Lücke in einer neueren App-Version wieder auf als der, mit der sie erledigt wurde, öffnet der Server sie wieder. Meldungen älterer Versionen zählen nur weiter.

Im Dashboard gibt es die Reiter „Alle“, „Fehler“ und „Fähigkeitslücken (offen n)“. Der gewählte Reiter wird im Browser gemerkt und bleibt auch nach der automatischen Aktualisierung alle 10 Sekunden aktiv. Eine Lücke zeigt Anfrage, Antwort von James, erkannten Grund, Lösungsvorschlag, Werkzeuge, Kanal, App-Version und Häufigkeit. „Erledigt“ setzt den Status; schlägt das fehl, steht der Grund über der Tabelle. „Erledigte zeigen“ blendet abgeschlossene Lücken ein.

„Offene Lücken als Markdown kopieren“ legt eine Aufgabenliste für das nächste Update in die Zwischenablage. Ist das Kopieren blockiert, erscheint der Text zum Markieren:

```markdown
## Fähigkeitslücken für das nächste Update

- [ ] **Grund** (3×, zuletzt 11.10.2026) — Vorschlag: …
  - Anfrage: „…“
```

Zeilenumbrüche werden zusammengezogen, Markdown-Zeichen wie `*`, `_`, `[`, `<` und Backticks maskiert.

## Vor dem ersten Lückenbericht bereitstellen

Auf `jocular-otter-624907` lief bis 11.10.2026 die ältere Fassung ohne `kind` und ohne Token. Damit Fehlerberichte und Lücken ankommen:

1. Dieses Projekt auf dieser Website bereitstellen (siehe „Bereitstellung“) oder Function, `report-handler.mjs`, `@netlify/blobs` und die Weiterleitung in deren Projekt übernehmen.
2. In Netlify die Umgebungsvariable `JARVIS_REPORT_TOKEN` mit einem langen Zufallswert setzen und neu bereitstellen.
3. Denselben Wert in JARVIS unter Einstellungen → Zugänge → Fehlerbericht-Token eintragen und „Fähigkeitslücken mit Gesprächsausschnitt senden“ einschalten.
4. Im Dashboard denselben Token eingeben, um die Lücken zu sehen.

## Optionaler Zugangsschutz

Die Netlify-Umgebungsvariable `JARVIS_REPORT_TOKEN` schützt GET, POST und PATCH. Clients müssen `Authorization: Bearer TOKEN` oder `x-jarvis-token: TOKEN` mitsenden. Im Dashboard lässt sich der Token eingeben; er wird nicht dauerhaft gespeichert.

JARVIS ab Version 1.2.16 unterstützt diesen Header über Einstellungen → Zugänge → Fehlerbericht-Token. Ältere Versionen bis 1.2.15 unterstützen ihn noch nicht. Ohne die Variable ist die API für Fehlerberichte öffentlich lesbar und beschreibbar; Fähigkeitslücken werden dann abgelehnt.

## Prüfung

`npm test` führt elf Backend-Tests aus: Speichern/Lesen, Eingabeprüfung, Token-Schutz, CORS, `kind`-Prüfung, Ablehnung von Lücken ohne Server-Token, Speicherung und getrennte Liste unter `gap/`, Zählen doppelter Lücken, PATCH mit und ohne Token samt Wiederöffnen, Berichte knapp unter 16 KB mit Umlauten und Speicherfehler. Diese Tests bestehen mit einem lokalen Speichermodell.

Die Browserprüfung prüft sichtbare HTTP-404-Fehler, anschließende Wiederherstellung, Zähler, sichere Textdarstellung auch in allen Lückenfeldern, den Lücken-Reiter nach Aktualisieren und Neuladen, „Erledigte zeigen“, „Erledigt“ mit und ohne Serverfreigabe, den Markdown-Export und die Breite auf dem Telefon. Bildschirmfotos landen in `audit/`. `tests/ui.mjs` verwendet Playwright aus dem übergeordneten JARVIS-Projekt und eine lokale Chrome-Installation; es ist kein eigenständiger npm-Test dieses Pakets.

Es wurden keine echten Fehlerberichte an deine Websites gesendet und kein Deployment durchgeführt. Die Online-Funktion kann erst nach der Bereitstellung überprüft werden.

Netlify-Dokumentation: https://docs.netlify.com/build/data-and-storage/netlify-blobs/
