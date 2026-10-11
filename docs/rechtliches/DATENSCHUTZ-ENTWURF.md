# Datenschutzerklärung Void James — ENTWURF

> **Entwurf, keine Rechtsberatung.** Der Text beschreibt, was die App technisch tut
> (Stand: Code vom 2026-10-11). Vor der Veröffentlichung muss ihn eine Anwältin oder
> ein Anwalt für Datenschutzrecht (DSGVO/DSG Österreich) prüfen und ergänzen.
> Platzhalter stehen in [eckigen Klammern].

## 1. Verantwortlicher

[Firmenname, Anschrift, E-Mail, ggf. Datenschutzbeauftragter]

## 2. Grundsatz: Die App läuft auf Ihrem Rechner

Void James ist ein Programm, das auf Ihrem Windows-Rechner läuft. Ihre Gespräche und
die Dienste, die Sie einrichten, laufen **nicht über einen Server des Herstellers**.
Die Verbindung geht direkt von Ihrem Rechner zum jeweiligen Anbieter, mit Ihrem eigenen
Konto oder Schlüssel.

**Ohne Ihre ausdrückliche Zustimmung erheben wir keine Nutzungsstatistik (Telemetrie)
und erhalten keine Daten von Ihnen.** Die einzige Ausnahme sind die optionalen
Fehlerberichte und Berichte über Fähigkeitslücken an einen Empfänger des Herstellers
(Abschnitt 7). Sie sind standardmäßig ausgeschaltet und werden nur gesendet, wenn Sie
sie in den Einstellungen selbst einschalten.

[Anwalt: Rolle des Herstellers klären. Ohne eingeschaltete Berichte vermutlich keine
Verarbeitung durch den Hersteller. Ausnahmen: Auto-Update (Abschnitt 6) und die
optionalen Berichte (Abschnitt 7), für die der Hersteller selbst Verantwortlicher ist.]

## 3. Was lokal gespeichert wird

Gespeichert wird im Benutzerordner (`%APPDATA%`) und nur auf diesem Rechner:

- **Zugangsdaten** (API-Schlüssel, Anmeldungen bei Google, ChatGPT, Spotify, Twitch,
  MCP-Servern): verschlüsselt mit Windows DPAPI, nur unter Ihrem Windows-Konto lesbar.
- **Gedächtnis** (Fakten, die Sie James mitteilen), **Gesprächsverläufe**,
  **Aktionslog** (welche Werkzeuge James ausgeführt hat), **Kontakte**, **Termine und
  Timer**, **Preisbeobachtungen**, **Recherchen**, **Kostenübersicht** und
  **Störungsprotokoll**: in einer lokalen SQLite-Datenbank.
- **Einstellungen**.

Diese Daten löschen Sie, indem Sie die App deinstallieren und den Ordner
`%APPDATA%\[Ordnername]` entfernen. [Lösch-Funktion in der App? Siehe offene Punkte.]

## 4. Mikrofon, Kamera, Bildschirm

- **Weckwort:** Das Mikrofon wird lokal auf „Hey James" ausgewertet. Bis das Weckwort
  erkannt wird, verlässt kein Ton den Rechner.
- **Nach dem Weckwort**, nach dem Tastenkürzel oder nach einem Klick auf die Kugel wird
  Ihre Sprache an den eingestellten Sprachdienst gestreamt, in der Regel an Google
  Gemini (Live API). Sie können stattdessen auch Whisper lokal auf Ihrem Rechner
  nutzen.
- **Bildschirm und Kamera:** Bildschirmfotos oder Kamerabilder werden nur dann
  aufgenommen und an das Sprachmodell geschickt, wenn Sie James darum bitten
  (z. B. „was siehst du auf meinem Bildschirm").

## 5. Dienste Dritter

Die folgenden Dienste sind nur aktiv, wenn Sie sie selbst einrichten. Es gelten dann
zusätzlich deren Datenschutzbestimmungen.

| Dienst | Wofür | Was übertragen wird |
|---|---|---|
| Google Gemini (Google LLC / Google Ireland) | Sprachdialog, Denken, Websuche | Sprache, Text, auf Wunsch Bilder; Inhalte aus dem Gedächtnis als Kontext |
| OpenAI (ChatGPT) | optional für Textaufgaben | Text der Aufgabe |
| Anthropic (Claude) | optional für Textaufgaben | Text der Aufgabe |
| OpenRouter | optional für Textaufgaben | Text der Aufgabe |
| ElevenLabs | optional, Sprachausgabe | Text der Antwort |
| Google (Gmail, Kalender) | E-Mails und Termine | E-Mail- und Termininhalte, die James liest oder schreibt |
| Twilio | Telefonie und SMS | Rufnummern, Gesprächsaudio, SMS-Text |
| Spotify, Apple Music | Musiksteuerung | Suchbegriffe, Abspielbefehle |
| Twitch | Kanalsteuerung | Kanal- und Stream-Daten |
| Higgsfield | Bild- und Videoerzeugung | Beschreibung (Prompt) |
| Amazon Alexa (Skill) | Fragen über Echo-Geräte | Gesprochene Frage, Antwort |
| Tailscale / Cloudflare Tunnel | Zugriff vom Handy | Verbindungsdaten |
| Open-Meteo, Frankfurter, Yahoo Finance | Wetter, Wechselkurse, Kurse | Ort bzw. Währung oder Symbol |
| Photon (komoot GmbH, Deutschland), Nominatim (OpenStreetMap Foundation, UK) | Ortssuche | Genannte Orte und Adressen, Standardstandort als Bezugsort, IP-Adresse |
| Overpass API (FOSSGIS e. V., Deutschland, und Spiegelserver) | Geschäfte in der Nähe, Straßennetz für Routen | Ausschnitt um Bezugsort bzw. Start und Ziel, IP-Adresse |
| OpenFreeMap | Kartenkacheln | Angezeigter Kartenausschnitt, IP-Adresse |
| MCP-Server nach Ihrer Wahl | Erweiterungen | je nach Server |
| Webseiten (Browser-Steuerung) | Recherche, Preise, WhatsApp Web, Yahoo Mail | Was eine normale Browsersitzung überträgt |

[Anwalt: Drittlandübermittlung USA (Google, OpenAI, Anthropic, Twilio, ElevenLabs …)
Data Privacy Framework bzw. Standardvertragsklauseln. Weil der Nutzer jeweils selbst
Vertragspartner des Anbieters ist, klären, wie weit der Hersteller hier informieren muss.]

## 6. Auto-Update

Beim Start fragt die App bei GitHub (GitHub Inc., USA) nach, ob eine neue Version
vorliegt. Dabei sieht GitHub Ihre IP-Adresse und die Versionsnummer. [Rechtsgrundlage:
berechtigtes Interesse, Sicherheit. Abschalten in den Einstellungen?]

## 7. Optionale Fehlerberichte und Fähigkeitslücken

Unter Einstellungen → Zugänge → **Optionale Fehlerberichte** können Sie der App
erlauben, Berichte an den Hersteller zu senden. **Alle Schalter sind standardmäßig
aus.** Ohne Ihr Einschalten wird nichts gesendet.

| Schalter | Wann gesendet wird | Was gesendet wird |
|---|---|---|
| Versand technischer Statistik erlauben | Nur wenn Sie auf „Statistik senden" klicken | App-Version, Betriebssystem, Anzahl offener und behobener technischer Störungen der letzten 24 Stunden |
| Neue Fehler automatisch anonymisiert senden | Nach neuen technischen Fehlern, gebündelt, höchstens ein Bericht je 5 Minuten | App-Version, Betriebssystem, Fehleranzahl |
| Fähigkeitslücken mit Gesprächsausschnitt senden | Wenn James sagt, dass er etwas nicht kann, oder ein benötigtes Werkzeug fehlt oder scheitert | Siehe unten |

Die beiden ersten Berichte enthalten **keinen Gesprächstext**, keine Protokolltexte,
keine Schlüssel, Namen oder Standorte.

**Fähigkeitslücken.** Dieser Bericht soll dem Hersteller zeigen, welche Fähigkeit in
einem späteren Update fehlt. Er enthält deshalb einen **Ausschnitt aus dem Gespräch**:

- Ihre Bitte an James (gekürzt auf höchstens 600 Zeichen),
- James' Antwort (höchstens 1.200 Zeichen),
- den erkannten Grund und einen automatisch erzeugten Lösungsvorschlag,
- die beteiligten Werkzeuge mit Fehlermeldung bzw. Suchbegriffen,
- den Kanal (z. B. Sprache oder Text), die App-Version und das Betriebssystem.

Vor dem Versand entfernt die App auf Ihrem Rechner E-Mail-Adressen, Telefonnummern und
andere lange Ziffernfolgen, IBANs und Zugangsschlüssel; Links werden auf den
Domainnamen gekürzt (der Pfad wird entfernt). **Namen, Orte oder andere persönliche
Angaben, die Sie in Ihrer Bitte nennen, können im Bericht enthalten bleiben.** Schalten
Sie diese Option deshalb nur ein, wenn Sie damit einverstanden sind.

**Empfänger.** Die Berichte gehen an einen Endpunkt des Herstellers, der bei Netlify
(Netlify, Inc., USA) betrieben wird [Empfängeradresse eintragen; derzeit voreingestellt:
`https://fastidious-pastelito-1f1564.netlify.app/api/error-report`]. Die Adresse ist in den
Einstellungen änderbar; tragen Sie eine eigene Adresse ein, gehen die Berichte nur
dorthin. Übertragen wird ausschließlich über HTTPS. Dabei verarbeitet der Hostinganbieter
technisch Ihre IP-Adresse; die App selbst schickt keine Geräte- oder Nutzerkennung mit.

**Speicherung.** Gespeichert werden der Bericht, ein Zeitstempel und eine zufällige
Kennung in Netlify Blobs. Der Hersteller sieht die jeweils neuesten Berichte in einer
Übersicht. Speicherdauer: [vom Anbieter festzulegen]. [Anwalt/Technik: Löschfrist
festlegen und technisch umsetzen; derzeit werden Berichte nicht automatisch gelöscht.
Den Zugang zur Übersicht durch einen Zugangsschlüssel schützen; ohne ihn ist der
Speicher öffentlich lesbar.]

**Rechtsgrundlage** ist Ihre Einwilligung (Art. 6 Abs. 1 lit. a DSGVO), die Sie durch
das Einschalten des jeweiligen Schalters erteilen. Sie können sie jederzeit widerrufen,
indem Sie den Haken wieder entfernen; danach werden keine weiteren Berichte gesendet,
wartende automatische Berichte werden verworfen. Der Widerruf berührt nicht die
Rechtmäßigkeit der bis dahin erfolgten Übermittlung. Weil Berichte keine Kennung Ihres
Geräts tragen, kann der Hersteller einzelne Berichte nur über Zeitpunkt und Inhalt
zuordnen.

[Anwalt: Drittlandübermittlung an Netlify (USA) prüfen, Auftragsverarbeitungsvertrag
mit Netlify; Wortlaut der Einwilligung in der App prüfen; besondere Kategorien
(Art. 9 DSGVO), falls Nutzer etwa Gesundheitsangaben in ihrer Bitte nennen.]

## 8. Ihre Rechte

[Standardabschnitt: Auskunft, Berichtigung, Löschung, Einschränkung, Widerspruch,
Datenübertragbarkeit, Beschwerde bei der Datenschutzbehörde (Österreich: dsb.gv.at).]

## Offene Punkte für die Prüfung

1. Rolle des Herstellers, siehe Abschnitt 2.
2. Telefonie: Die Gesprächspartner werden aufgenommen bzw. transkribiert und haben
   nicht eingewilligt. Muss die App sie darauf hinweisen?
3. Gibt es eine „Alle meine Daten löschen"-Funktion in der App? (Noch nicht vorhanden.)
4. Mindestalter für die Nutzung.
5. Optionale Berichte, siehe Abschnitt 7: Löschfrist, Zugangsschutz des Empfängers,
   Netlify als Auftragsverarbeiter und Drittland, Gesprächsausschnitte bei
   Fähigkeitslücken.
