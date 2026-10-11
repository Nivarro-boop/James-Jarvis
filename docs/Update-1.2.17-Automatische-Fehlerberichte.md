# Update 1.2.17 — automatische anonymisierte Fehlerberichte

Unter Einstellungen → Zugänge → Optionale Fehlerberichte lässt sich „Neue Fehler automatisch anonymisiert senden“ einschalten. Der Schalter erlaubt gleichzeitig den Versand. Neue Installationen und bisher nur manuell sendende Profile werden nicht automatisch umgestellt. Der vorhandene HTTPS-Empfänger und der verschlüsselte Fehlerbericht-Token werden verwendet.

Neue in der Selbstheilung erfasste technische Störungen lösen den Versand aus, einschließlich Fehlern aus der Renderer-Protokollierung und aus der Dienstprüfung. Bestehende historische Störungen werden beim Einschalten nicht nachträglich hochgeladen.

## Übertragene Daten

Der POST verwendet ausschließlich level, eine feste message, source=JARVIS und details als JSON-Zeichenfolge mit App-Version, Betriebssystem, Anzahl gebündelter Störungen und automatic=true. Fehlertexte, Fingerabdrücke, Stacktraces, Gespräche, Benutzernamen, E-Mail-Adressen, Standorte und Schlüssel sind nicht enthalten. Es gibt keine Installations- oder Benutzer-ID. Der Empfänger sieht technisch die IP-Adresse.

## Begrenzung und Ausschalten

- Neue Fehler werden 30 Sekunden gesammelt.
- Höchstens ein automatischer Bericht je fünf Minuten.
- Derselbe lokale Fehlerfingerabdruck wird 15 Minuten unterdrückt.
- Fehlgeschlagene Uploads werden frühestens nach fünf Minuten erneut versucht; neue Fehler werden mitgezählt. Keine rekursiven Fehlerlogs durch fehlgeschlagenen Versand.
- Die Warteschlange bleibt ausschließlich im Arbeitsspeicher. Ausschalten, Empfängerwechsel und App-Ende verwerfen sie und brechen laufende Uploads ab. Keine späteren Uploads aus einem alten Empfängerprofil.
- HTTPS, zehn Sekunden Zeitlimit, keine Weiterleitung des Tokens über Redirects. Manuelles Senden bleibt verfügbar.

## Prüfung

TypeScript, Produktionsbuild und 1.705 Tests bestanden. Acht neue Tests prüfen Bündelung, Einwilligung, Duplikate, Versandbegrenzung, Wiederholung, Abbruch, App-Ende und die Beschränkung auf technische Zähler.

Der Electron-Test löst einen Renderer-Fehler mit privaten Testdaten aus und prüft den automatischen Upload an einen vollständig simulierten Empfänger. Es wird kein echter Bericht an den Netlify-Server geschickt. Die tatsächliche Serverannahme hängt weiterhin von der Bereitstellung des Backends auf dem Host der eingestellten API-Adresse ab.

Nachweise: out/audit/tests-1.2.17.log, build-1.2.17.log und ui-1.2.17.log.
