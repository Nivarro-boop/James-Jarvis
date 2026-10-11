# James-Jarvis

Lokales Update **1.3.2 (09.10.2026)**: Antwort-Hänger bei Sprache und Text,
Wiederverbindung, Abbruch und lokale Sprachausgabe gezielt abgesichert.
Fehlgeschlagene Texteingaben bleiben als Entwurf erhalten. Prüfung und
Installationsstand stehen in [UPDATE.md](UPDATE.md).

Lokales Update **1.3.1 (09.10.2026)**: aktueller Projektstand mit Karten und
Antwortkarten sowie robusterem Update-Ablauf. Prüfungen, Installer und
Installationsstatus stehen in [UPDATE.md](UPDATE.md); Claude findet den
Einstieg über [CLAUDE.md](CLAUDE.md).

Sprachgesteuerter Desktop-Assistent für Windows. Quellcode und Installer liegen
gemeinsam in diesem Repo: den neuesten Installer gibt es unter
[Releases](https://github.com/Nivarro-boop/James-Jarvis/releases/latest), die
installierte App aktualisiert sich danach selbst.

Update **1.3**: Fehler aus dem Betriebslog behoben (Live-Verbindung,
Datenbanksperre, Weckwort im Installer, Wiederholungs-Spam bei fehlender
Einrichtung), neuer Name James-Jarvis, dazu Orte, Routen und Karten aus
OpenStreetMap — mit eigener Karte und eigenem Routing, ohne Schlüssel und
ohne kommerziellen Kartendienst.

Update **1.2.8**: persönliche Windows-Ausgabe mit „Hey Jarvis“, Fehlerkarte
oben rechts, „Ja, reparieren“, Logzugang und zusätzlicher Live-Statusanzeige.
Die Audio-Vorstufe der Weckwort-Erkennung wurde korrigiert. Der optionale
Jarvis-Klassifikator wird mit `node scripts/fetch-wakeword.mjs --personal-jarvis`
geladen und ist ausschließlich für nichtkommerzielle Nutzung lizenziert.
Der tatsächliche Zuruf steht auf der Startseite; ältere Abschnitte unten
beziehen sich auf das eigene „Hey James“-Modell.
Tests, lokale Zugangsbefunde und verbleibende echte Konto- und Mikrofontests
stehen im [Prüfbericht 1.2.8](docs/Update-1.2.8-Pruefbericht.md).

Ein sprachgesteuerter Desktop-Assistent für Windows. Die App öffnet eine
Startseite, auf der **eine leuchtende Kugel** schwebt, darunter eine Zeile,
die ihren Zustand benennt. Antworten werden gesprochen; zusätzlich lassen
sich Texteingaben verwenden.

Die Kugel ist die eigentliche Oberfläche, und sie ist kein Gegenstand, sondern
Licht: Der Blickstrahl läuft im Shader durch ein Dichtefeld, statt eine Haut zu
beleuchten. Deshalb hat sie keinen Umriss, sondern einen Rand, der ausgeht.

Ihre Farbe sagt, woran man ist — kaltes Blau beim Zuhören und Sprechen, warmes
Orange, solange sie arbeitet, Rot, wenn sie auf eine Zusage wartet. Sie
reagiert auf die Maus, und der Ton geht in ihre Form statt in ihre Helligkeit:
Beim Sprechen fährt sie auf und wieder zu. Eine Lautstärkeanzeige wäre ein
Messgerät; das hier soll atmen.

---

## Schnellstart

### ChatGPT-Abo oder direkte Live-Sprache

Im Einrichtungsassistenten **ChatGPT-Abo → Continue with ChatGPT** wählen,
im Browser anmelden und freigeben, anschließend ein Modell aus dem Konto
wählen. Lokale Ohren und Stimme herunterladen und **Prüfen und weiter**
verwenden. Whisper transkribiert lokal, ChatGPT beantwortet die Textbeiträge,
Piper spricht lokal. Die Konto-Limits setzt OpenAI durch; Verbrauch und
Freigaben stehen unter [ChatGPT → Nutzung](https://chatgpt.com/settings/usage).
Eine echte Konto-Anmeldung ist für diesen Stand noch nicht getestet.
Ein laufender Browser-Anmeldeversuch lässt sich mit **Anmeldung abbrechen**
beenden. **Erneut anmelden** erneuert eine bestehende Verbindung; ein
fehlgeschlagener Versuch ersetzt die bisherigen Zugangsdaten nicht.
Ein abgelaufener Anmeldecode startet automatisch einen frischen Versuch,
höchstens einmal und mit der bereits ausgestellten App-Registrierung.

Die Bildschirmsteuerung bevorzugt den Windows-Bedienbaum und verwendet bei
gewähltem ChatGPT auch für Bildschirmbilder das Kontomodell. Im Sparmodus
sind Bildaufgaben auf 15 Bildschritte begrenzt; ein erreichtes Limit wird
gemeldet. Ältere Gesprächsantworten und große Werkzeuglisten werden gekürzt.
Details stehen im [Computer-Use-Prüfbericht](docs/Computer-Use-Sparmodus-2026-10-04.md).

Für natives OpenAI Realtime-Audio **OpenAI API** wählen und einen API-Schlüssel
prüfen lassen. Dieser Weg hat eine separate API-Abrechnung und verwendet
kein ChatGPT-Abo-Kontingent. Alternativ bietet Gemini seinen eigenen Live-Weg.
Lokale Installationen können die dynamische ChatGPT-Anmeldung verwenden;
kommerzielle Distributionen brauchen ihre genehmigte Client-Registrierung.
Siehe [OpenAI-Anmeldung](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
und [Preview-Grenzen](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

### Entwicklung

```bash
npm install
```

```bash
npm run dev
```

Während ein Spiel läuft, lassen sich die Tests mit `npm test -- --low-resource`
einzeln und mit niedriger Prozesspriorität ausführen. Der Modus begrenzt auch
die Parallelität des Test-Builds.

### Unterbrechen, Erinnerungen und Hermes

**Stopp** auf der Startseite oder **einmal Escape** unterbricht die aktuelle
Antwort und fordert den Abbruch ihrer laufenden Werkzeuge an. Mit aktivem
Mikrofon kannst du auch dazwischenreden; die lokale Erkennung behält den
Satzanfang. Bereits abgeschlossene Aktionen werden dadurch nicht rückgängig.
Dreimal Escape bleibt der Not-Aus für sämtliche James-Werkzeuge.

Im eigenen Profil arbeitet James standardmäßig **ohne Rückfragen**. Unter
**Rechte → Vor Aktionen nachfragen** lässt sich das umstellen. Explizit
gesperrte Werkzeuge bleiben gesperrt. Anmeldungen und Kontofreigaben finden
weiterhin beim jeweiligen Dienst statt.

„Erinnere mich morgen um neun an den Termin“ legt eine dauerhafte Erinnerung
an. James verwaltet einmalige, tägliche und wöchentliche Erinnerungen automatisch
und meldet fällige Termine per Sprache und Windows-Benachrichtigung. Erstellen,
Erledigen und Verschieben funktionieren über Sprache oder die Texteingabe.
James muss für die Zustellung laufen; verpasste Termine werden beim nächsten
Start nachgeholt. Eine pausierte Stimme verhindert die Windows-Benachrichtigung nicht.

Unter **Stimme → Denken → Hermes** arbeitet der vollständige Hermes-Agent
aus dem bereitgestellten ZIP als zusätzlicher lokaler Motor. James übernimmt
Ohren und Stimme. Die separate Installation liegt unter
`%LOCALAPPDATA%\Void James Hermes`, ihr eigenes Profil unter `profile`.
Der Gateway startet bei Auswahl automatisch; unter den Einstellungen kann
man ihn auch gezielt starten und prüfen. Antworten werden bereits während
der Bearbeitung weitergegeben; Werkzeugfortschritte erscheinen auf der Startseite.
Beim Beenden erhält der eigene Gateway Zeit zum Speichern seines Zustands.
Modellkonten, MCP-Server, Skills
und zusätzliche Hermes-Kanäle werden im Hermes-Profil eingerichtet.
Der Installer enthält die James-Anbindung; die Hermes-Python-Umgebung ist
eine separate Installation auf diesem Rechner.

Zum erneuten Installieren aus der Projektwurzel:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-hermes.ps1 -Archive "$env:USERPROFILE\Downloads\hermes-agent-main.zip"
```

Die Einrichtung braucht Python und uv. Mit `-Repair` lassen sich die Pakete
der separaten Installation reparieren. Sicherheitsaktualisierungen gegenüber
den Pins im ZIP sind im Skript festgehalten. Zum Einrichten eines Hermes-Kontos:

```powershell
$env:HERMES_HOME = "$env:LOCALAPPDATA\Void James Hermes\profile"
& "$env:LOCALAPPDATA\Void James Hermes\venv\Scripts\hermes.exe" setup
```

Der [aktuelle Nachprüfbericht](docs/James-Nachpruefung-2026-10-04.md) beschreibt
die getesteten Funktionen und die noch offenen Konto- und Gerätetests.

### Datensicherung und Status

Unter **Über → Datensicherung** sind tägliche lokale Sicherungen standardmäßig
aktiv. James behält sieben automatische Kopien; **Jetzt sichern** erstellt
eine zusätzliche manuelle Kopie. Gesichert werden die konsistente SQLite-Datenbank,
Einstellungen und Fertigkeiten. Die Kopien enthalten persönliche Gesprächsdaten.
Keystore, Anmeldetokens, MCP-Umgebungswerte, Sprachmodelle und das separate
Hermes-Profil sind ausgenommen. Details zur manuellen Wiederherstellung stehen
im [Nachprüfbericht](docs/James-Nachpruefung-2026-10-04.md).

Die Startseite zeigt den tatsächlich verwendeten Sprachweg. Fehlt der
Weckwort-Klassifikator, weisen Startseite und Einstellungen auf Klick und Hotkey hin;
die fehlende Datei wird nicht als einsatzbereites Weckwort angezeigt.

Beim ersten Start läuft der **Einrichtungsassistent**: ein Schritt pro Bild,
mit Auswahl zwischen Gemini, OpenAI API und ChatGPT-Abo, danach Mikrofon,
für wen der Rechner ist und Bedienung. Der Schlüssel wird dabei sofort ausprobiert statt nur
entgegengenommen; ein halb kopierter fällt sonst erst auf, wenn die Kugel
beim ersten Ansprechen wortlos wieder ausgeht.

Der Schritt **„Für wen"** ist die einzige Sicherheitsfrage des Assistenten. Die
Voreinstellungen sind für den gedacht, der die App gebaut hat: `computer_task`
übernimmt Maus und Tastatur ohne Rückfrage, und die Tagesgrenze steht auf aus.
Wer angibt, den Rechner für jemand anderen einzurichten, bekommt beides anders
herum — Rückfrage vor der Bildschirmsteuerung, tiefe Recherchen gedeckelt bei
5 $ am Tag. Umstellbar bleibt es unter **Rechte** und **Über**.

Danach zeigt das Einstellungsfenster sieben Abschnitte statt vierzehn. Die
übrigen — Telefon, Stimme, Sparmodus, Rechte, MCP-Server, Recherchen,
Gedächtnis — kommen über **Über → Erweiterte Einstellungen zeigen** dazu.
Abgeschaltet ist davon nichts, sie sind nur unsichtbar, solange niemand danach
fragt. Der Assistent selbst lässt sich dort ebenfalls erneut aufrufen.

Der Bau lädt die beiden gemeinsamen Weckwort-Vorstufen nach, falls sie fehlen.
Der Klassifikator `hey_james.onnx` fehlt im aktuellen Checkout und muss separat
trainiert werden (siehe `scripts/wakeword-training/README.md`). Bis dahin
funktionieren Klick und Hotkey. Die Vorstufen lädt man von Hand so:

```bash
npm run wakeword
```

---

## Ansprechen

| Weg | Wann sinnvoll |
|---|---|
| „Hey James" sagen | Freihändig, auch während du spielst |
| `Alt+Space` | Systemweiter Hotkey, greift auch über Vollbild-Minecraft |
| Klick auf die Kugel | Wenn sie ohnehin sichtbar ist |

### Wieder abschalten

Die Kugel ist auch der Ausschalter. **Ein Klick, während er läuft, legt ihn
still**: Verbindung zu, Mikrofon aus, Weckwort taub. Er kann sich dann nicht
selbst wieder einschalten. Der nächste Klick holt ihn zurück und macht gleich
die Sitzung auf — einmal drücken zum Reden, nochmal drücken für Ruhe.

Dasselbe erreichen ein **langer Druck** auf die Kugel, `Alt+Shift+Space`
und der Eintrag **James stilllegen** im Infobereich der Taskleiste.

Oder man **sagt es ihm**: „sei mal still", „lass mich in Ruhe", „leg dich
schlafen". Mit Frist geht es auch — „sei die nächste Stunde ruhig", und um
kurz nach der Stunde ist er von selbst wieder da. Zwölf Stunden sind das
Höchste; darüber hinaus ist es keine Pause mehr, sondern Ausschalten. Er
verabschiedet sich noch in einem Satz, bevor das Mikrofon ausgeht. Bis wann
er still ist, steht unter der Kugel und im Tooltip des Taskleistensymbols.

Gewartet wird dabei nicht im Fenster, sondern im Hauptprozess — sonst müsste
ausgerechnet der Teil den Wecker stellen, der gerade stillgelegt ist.

**Dreimal `Escape`** bricht sofort alles ab: laufende Werkzeuge, offene
Rückfragen, die Sprachausgabe.

Das **Zahnrad oben rechts** öffnet die Einstellungen — ebenso ein Rechtsklick
auf die Kugel oder das Symbol im Infobereich der Taskleiste.

### Mit Windows starten

Unter **Einstellungen → Über** lässt sich der Autostart einschalten. James
kommt dann ohne Fenster hoch, nur mit dem Symbol im Infobereich — wer sich
anmeldet, will einen mitlaufenden Assistenten und kein Fenster, das ihm
entgegenspringt. Weckwort und Hotkey greifen trotzdem ab der ersten Sekunde.
Eingetragen wird nur aus der installierten Fassung; im Entwicklungslauf
passiert nichts.

---

## Zugänge

Es wird ein eingerichteter Denkmotor benötigt. Weitere Dienste werden ohne Schlüssel sauber
deaktiviert — James behauptet dann gar nicht erst, er könne es.

Yahoo Mail steht bewusst nicht in der Tabelle: Es braucht keinen Schlüssel,
sondern dieselbe einmalige Anmeldung im James-Browser wie Gmail und Amazon.

| Zugang | Wofür | Woher |
|---|---|---|
| **Gemini** | Stimme, Recherche, Websuche, Bildschirmsteuerung, Gedächtnis | [Google AI Studio](https://aistudio.google.com/apikey) |
| OpenRouter | Übersetzen über ein anderes Modell | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Google OAuth | **Kalender** und Gmail **direkt versenden** (siehe unten) | Cloud Console → OAuth-Client, Typ **Desktop** |
| Higgsfield | Bild- und Videoerzeugung | `platform.higgsfield.ai`, braucht Creator-Tarif. Format: `schlüssel:geheimnis` |
| Twitch | Streamstatus und Clips | [dev.twitch.tv/console](https://dev.twitch.tv/console) |
| Spotify | Musik, auch auf dem Echo Dot | [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) — nur die Client-ID, kein Secret |
| Apple Music | Titel *finden*; abspielen geht auch ohne | Apple Developer → Keys → MusicKit. Team-ID, Key-ID, `.p8` |

Musik ist die eine Ausnahme von „ohne Schlüssel deaktiviert": Die
Ausgabegeräte dieses Rechners umzustellen braucht keine Einrichtung, und die
Apple-Music-App nimmt einen Link entgegen, sobald sie installiert ist. Was ohne
Anmeldung nicht geht, sagt James in ganzen Sätzen, statt so zu tun, als gäbe es
keine Musik.

Alle Schlüssel liegen über Windows-DPAPI verschlüsselt in deinem
Benutzerprofil. Sie stehen nie im Klartext auf der Platte und sind auf einem
anderen Rechner wertlos.

### Gmail und Amazon kosten eine einmalige Anmeldung

Beides läuft über einen Chrome, der James gehört — eigenes Profil, eigenes
Fenster, neben deinem normalen Browser. Melde dich darin einmal bei Gmail und
Amazon an, dann bleibt es: kein OAuth, keine Cloud Console, kein Formular.
Lesen, öffnen, durchsuchen, Text herauskopieren, eine Mail fertig ausgefüllt
zum Abschicken bereitlegen, Warenkorb ansehen und befüllen: alles über diesen
Weg. Den Knopf zum Anmelden gibt es unter **Verbindungen**.

Ursprünglich hing James am Standardprofil deines Chrome, damit gar nichts
einzurichten war. Seit Chrome 136 geht das nicht mehr: Der Debug-Zugang, über
den die Fernsteuerung läuft, wird auf dem Standard-Datenverzeichnis
abgeschaltet — eine Sicherheitsmaßnahme gegen das Abgreifen fremder Sitzungen,
und eine, um die herumzuarbeiten falsch wäre. Dafür musst du dein Chrome jetzt
nie mehr schließen; die beiden stören sich nicht.

Ob es gerade klappt, steht in den Einstellungen unter **Verbindungen** — dort
wird nicht geraten, sondern nachgesehen.

Der OAuth-Client aus der Cloud Console ist für zwei Dinge da: dass James Mails
auch **selbst verschicken** und archivieren kann, ohne den Browser — und für
den **Kalender**, der ohne ihn gar nicht geht. Wer beides nicht braucht, lässt
die Felder leer.

Wer sich vor der Kalenderfassung angemeldet hat, hat eine Zustimmung ohne
Kalenderrecht. Das steht dann unter **Zugänge** ausdrücklich da, und ein
erneutes „Mit Google verbinden" behebt es; an den Mails ändert sich nichts.

---

## Was er kann

**Recherche** — Tiefe Recherche läuft fünf bis zwanzig Minuten im Hintergrund,
während du normal weiterredest; danach meldet er sich von selbst. Der
vollständige Bericht mit Quellen steht im Einstellungsfenster. Für schnelle
Fragen nimmt er die Websuche mit Google-Grounding.

**Programme und System** — NoRisk, Modrinth, EnderClient, FastClient, Chrome,
Brave, Opera GX, Discord, CapCut, Medal, Streamlabs und Fortnite sind
namentlich hinterlegt; alles andere löst er über deine Verknüpfungen auf.
Dazu Fenster wechseln, Lautstärke, Medientasten, Zwischenablage.

**Fenster bedienen** — Für alles mit einer gewöhnlichen Oberfläche liest er den
Bedienbaum, den Windows zu jedem Fenster führt: Knöpfe, Textfelder, Kästchen,
Links — mit Namen und mit dem, was damit überhaupt geht. Aus „klicke bei 487,
203" wird damit „drücke Settings". Das braucht das Fenster nicht im Vordergrund,
nimmt also niemandem die Maus aus der Hand, trifft auch noch nach dem
Verschieben, und kostet ein paar hundert Token statt sechzehnhundert für ein
Bildschirmfoto. Was keine benannten Bedienelemente hat — Zeichenflächen,
Spiele, Videobilder —, bleibt bei der Bildschirmsteuerung darunter.

**Bildschirmsteuerung** — Wenn kein direktes Werkzeug passt, übernimmt er Maus
und Tastatur und arbeitet über Bildschirmfotos. Er klickt einfach, doppelt und
dreifach, hält dabei Strg oder Umschalt, hält die Maustaste für Schieberegler
gedrückt, scrollt in alle vier Richtungen an einer bestimmten Stelle, zieht,
tippt, liest über die Zwischenablage genau aus, was in einem Feld steht, und
vergrößert sich einen Ausschnitt in voller Auflösung, wenn Text zu klein zum
Lesen ist.

Absehbare Folgen erledigt er in einem Zug: ins Feld klicken, Inhalt ersetzen,
Enter — das sind drei Aktionen, aber nur ein Bildschirmfoto. Das ist der
größte Hebel bei den Kosten, weil jedes Bild bei jedem Schritt bezahlt wird
(siehe [Kosten](#kosten)).

Bei zwei Monitoren arbeitet er auf dem, der gemeint ist — beim Zielprogramm auf
dessen Fenster, sonst dort, wo der Mauszeiger steht. Verändert sich nach einer
Aktion nichts am Bild, erfährt er das und probiert etwas anderes, statt
dieselbe Stelle noch dreimal anzuklicken. Läuft ohne Rückfrage; die harten
Sperren gelten trotzdem, und dreimal Escape bricht jederzeit ab — auch mitten
in einer laufenden Folge.

**Dateien** — Suchen nach einem Stück Namen in Desktop, Dokumenten, Downloads,
Bildern, Videos und Musik. Textdateien lesen und daraus vorlesen oder
zusammenfassen. Eine Datei schreiben oder etwas anhängen. Öffnen oder im
Explorer zeigen. Wegwerfen geht nur in den Papierkorb.

**Befehle** — Für alles, wofür es kein eigenes Werkzeug gibt, führt er einen
PowerShell-Einzeiler aus und sagt, was dabei herauskam. Immer erst nach
Rückfrage, immer im Aktionslog, und eine feste Liste lehnt ab, was sich nicht
zurücknehmen lässt oder nach Schadsoftware aussieht.

**Chrome** — Ein eigener Chrome mit eigenem Profil. Einmal darin bei Amazon,
Gmail und Twitch anmelden, danach bleibt es angemeldet.

**Einkaufen** — Preisvergleich über Geizhals, idealo, Amazon und Google
Shopping. Warenkorb lesen, befüllen, leeren. Preiswächter, der sich meldet,
wenn etwas unter deinen Zielpreis fällt.

**Gmail** — Postfach zusammenfassen, suchen, lesen, eine Mail öffnen und
vorlesen, ihren Text in die Zwischenablage legen, eine neue Mail fertig
ausgefüllt bereitlegen. Mit hinterlegtem OAuth-Client zusätzlich: direkt
versenden, antworten, archivieren, in den Papierkorb legen — Versand und
Papierkorb nur nach ausdrücklicher Zusage.

**Yahoo Mail und das Kontaktbuch** — „Schreib eine Mail an Anna, dass ich
später komme." Die Adresse steht im Kontaktbuch, James fragt zurück und liest
dabei Name und Adresse vor — „Ich schicke eine Mail an Anna,
max@beispiel.at, mit dem Betreff …". Erst nach dem Ja geht sie raus, über
den James-Browser, ohne Schlüssel und ohne OAuth.

Die Adressen trägst du unter **Einstellungen → Kontakte** ein, getippt statt
diktiert. Das ist Absicht: „max punkt muster at example punkt com" kommt aus
einem Mikrofon als Transkript zurück, das an drei Stellen falsch sein kann, und
eine Mail an die falsche Adresse holt niemand zurück. Steht sie einmal drin,
genügt beim Sprechen der Vorname. Buchstabierst du ihm eine Adresse
ausdrücklich, trägt er sie selbst ein und liest sie zur Kontrolle vor;
erfinden tut er keine.

Stehen zwei gleichen Vornamens im Buch, fragt er, wer gemeint ist, statt zu
raten. Soll die Mail vor dem Absenden noch gelesen werden, füllt er das Fenster
nur aus und übergibt.

**Kalender** — „Was habe ich heute", „was steht diese Woche an", „trag mir
Freitag um zehn Zahnarzt ein", „verschieb den Elternabend auf Donnerstag".
Läuft über Google Kalender und braucht denselben OAuth-Client wie der direkte
Mailversand; einen Browserweg wie bei den Mails gibt es dafür nicht.

Nachsehen läuft ohne Rückfrage — zwei Sätze Genehmigungsverfahren für eine
Auskunft, die auch auf dem Telefon steht, wäre der sicherste Weg, den
Kalender nie zu benutzen. Eintragen, Verschieben und Absagen fragen dagegen
immer nach und nennen dabei Titel und Zeit. Abgesagte Termine liegen dreißig
Tage in Googles Papierkorb; endgültig gelöscht wird auch hier nichts.

Zeiträume rechnet der Rechner, nicht das Modell: „diese Woche" geht als Wort
ans Werkzeug, das die echte Uhr kennt. Datumsarithmetik im Modell geht
meistens gut — und die Fälle, in denen sie schiefgeht, liegen an Monatsenden
und Zeitumstellungen und fallen niemandem auf, weil ein fehlender Termin wie
ein freier Tag aussieht.

**Timer** — „Stell mir zehn Minuten." Er meldet sich von selbst, wenn die Zeit
um ist, und übersteht dabei auch einen Neustart der App.

**Wetter, Rechnen, Übersetzen** — Wetter kommt von Open-Meteo, ohne Schlüssel
und schneller als eine Websuche. Gerechnet wird mit einem eigenen kleinen
Rechner statt geraten. Das Übersetzen ist die einzige Hintergrundaufgabe ohne
Gemini-Eigenheit und lässt sich deshalb unter **Zugänge** auf ein
OpenRouter-Modell umlegen; antwortet das nicht, geht es still über Gemini
weiter. Websuche, Seitenabruf, Preisvergleich und Bildschirmauswertung hängen
am Google-Grounding und bleiben bei Gemini.

**Orte und Wege** — „Wo ist die nächste Apotheke?", „Wie lange brauche ich
nach Graz?" Beides braucht keinen Zugang: Die Ortssuche läuft über Photon
und Nominatim, Geschäfte und Straßennetz kommen über Overpass aus
OpenStreetMap, den Weg rechnet James selbst, und die Karte zeichnet er aus den
Vektorkacheln von OpenFreeMap. Ohne Ortsangabe gilt der Standardstandort.
Fahrzeiten gelten bei freier Straße, ohne Verkehrslage. Was einmal geladen
ist, bleibt auf der Platte — die Dienste werden von Freiwilligen betrieben.
Karten: OpenFreeMap © OpenMapTiles © OpenStreetMap-Mitwirkende.

**Der Rechner selbst** — Prozessorlast, Arbeitsspeicher, Plattenplatz,
Grafikkarte, Laufzeit. Fenster nach links oder rechts legen, groß und klein
machen, schließen. Bildschirmfoto in den Bilder-Ordner. Bildschirm sperren.

**Musik** — Spotify und Apple Music, und zwar auch auf anderen Geräten. „Spiel
was von Bowie auf dem Echo Dot" landet im Wohnzimmer, ohne Home Assistant und
ohne sonst eine Brücke im Heimnetz. Wie das geht und wo die Grenze verläuft,
steht unten unter [Musik auf anderen Geräten](#musik-auf-anderen-geräten).

**Über den Echo Dot** — „Alexa, frag James, was heute ansteht." Eine
Alexa-Skill, die auf diesen Rechner zeigt. Das Weckwort bleibt „Alexa", daran
lässt Amazon nicht rütteln; alles Weitere unter
[Über Alexa ansprechen](#über-alexa-ansprechen).

**Twitch** — Kanal öffnen, Streamstatus, Clips.

**Minecraft** — Launcher starten, Protokoll auswerten („wer ist online?"),
Welten auflisten.

**Higgsfield** — Bilder und Videos erzeugen, im Hintergrund mit Meldung bei
Fertigstellung.

**Gedächtnis und Zeitplan** — Merkt sich dauerhaft Dinge über dich, alles
lokal. Wiederkehrende Aufträge („jeden Morgen um acht die Mails
zusammenfassen") meldet er von selbst.

**Auskunft über sich selbst** — „Was hast du gespart" und „was ist gerade
verbunden" beantwortet er, ohne dass man die Einstellungen aufmachen muss.

**MCP** — Jeder Model-Context-Protocol-Server wird zum Werkzeug, ohne dass
dafür Code geschrieben werden muss.

**Vom Telefon aus** — Das iPhone wird nicht zu einem zweiten James, sondern zu
seiner Fernbedienung: Der Rechner bleibt der Agent, das Telefon ist Mikrofon,
Lautsprecher und Anzeige. Unter **Einstellungen → Telefon** steht immer genau
ein Schritt und daneben der Knopf, der ihn erledigt; am Ende zwei QR-Codes —
einer, damit das Telefon James traut, einer zum Koppeln. Dann über „Teilen" auf
den Home-Bildschirm.

Für das Mikrofon braucht es ein Zertifikat: iOS gibt es nur in einem sicheren
Kontext frei, und auf eine Heimnetzadresse stellt kein öffentlicher Aussteller
eines aus. James stellt sich deshalb selbst eines aus und legt dem Telefon
einmal das dazugehörige Root vor — kein Konto, keine Fremdsoftware, dafür nur zu
Hause gültig. Wer die Fernbedienung auch unterwegs will, stellt dort auf
Tailscale um. Ein Weckwort gibt es auf dem Telefon nicht — iOS lässt nichts
dauerhaft mithören —, dafür eine Sprechtaste.
Einzelheiten und der Weg zu einer echten `.ipa` ohne Mac stehen in
[`resources/companion/README.md`](resources/companion/README.md).

---

## Musik auf anderen Geräten

„Spiel was auf dem Echo Dot" funktioniert — ohne Home Assistant, ohne Bridge,
ohne dass ein zusätzliches Programm im Heimnetz laufen muss. Aber nicht bei
beiden Diensten auf demselben Weg, und der Unterschied ist keiner, den man
verschweigen kann.

### Spotify: der Ton geht gar nicht über diesen Rechner

Spotify Connect ist eine offene Fernbedienung. James lässt sich die Geräte
auflisten, auf denen dein Konto angemeldet ist, und schiebt die Wiedergabe auf
eines davon — genau das, was der Knopf unten links in der Spotify-App macht.
Der Lautsprecher holt sich den Strom danach selbst aus Spotifys Wolke.

Das hat zwei angenehme Folgen: Der Rechner darf in den Ruhezustand gehen, und
James' Stimme bleibt in deinen Kopfhörern, während im Wohnzimmer Musik läuft.

Der Echo Dot steht in der Liste, sobald in der Alexa-App einmal ein
Spotify-Konto verknüpft und dort einmal etwas abgespielt wurde. Spotify zeigt
nur wache Geräte — ein Echo, der seit Stunden still ist, taucht erst wieder
auf, wenn er einmal angesprochen wurde.

**Einrichtung**: Unter **Einstellungen → Musik**. Es braucht eine eigene
Client-ID aus dem [Spotify-Entwicklerbereich](https://developer.spotify.com/dashboard)
— „Create app", beliebiger Name, bei *Redirect URI* die Adresse eintragen, die
im Einstellungsfenster steht, und *Web API* ankreuzen. Ein Client Secret
brauchst du nicht: Die Anmeldung läuft über PKCE, und ein Geheimnis, das auf
deinem eigenen Rechner liegt, wäre ohnehin keins.

Eine eigene ID statt einer mitgelieferten, weil Spotify Kontingent und Sperren
an die Anwendung hängt und nicht an den Nutzer. Eine gemeinsame ID hieße: Einer
verstößt gegen die Nutzungsbedingungen, und bei allen ist die Musik aus.

**Fernsteuern verlangt Premium.** Spotify beantwortet jeden Steuerbefehl eines
Gratiskontos mit einer Absage. Suchen und nachsehen geht auch ohne. Das steht
so auch in den Einstellungen, damit es nicht wie ein Fehler dieser App aussieht.

### Apple Music: es gibt keine Fernbedienung

Apple bietet keine Schnittstelle an, mit der ein fremdes Programm die
Wiedergabe auf ein anderes Gerät schieben könnte. Kein Gegenstück zu Connect,
kein öffentliches AirPlay. Die Web-Schnittstelle kann Katalog und Bibliothek
lesen und sonst nichts, und die Wiedergabe im Browser bräuchte einen
DRM-Baustein, den Electron nicht mitbringt.

Was geht: den richtigen Titel finden und ihn in der Apple-Music-App auf *diesem*
Rechner aufmachen. Der Ton kommt dann aus diesem Rechner.

Ohne Einrichtung öffnet James die Trefferliste in der App — ein Klick, dann
läuft es. Mit einem MusicKit-Schlüssel (Team-ID, Key-ID und die `.p8`-Datei aus
dem Apple-Developer-Portal) findet er den Titel selbst und startet ihn. Der
Zugang kostet neunundneunzig Euro im Jahr; dafür macht niemand nur Musik an,
deshalb geht es auch ohne.

### Der zweite Weg: das Ausgabegerät von Windows

Damit auch Apple Music — oder ein Video im Browser, oder überhaupt alles — auf
dem Echo Dot landet, gibt es den gröberen Weg: Ein Echo Dot, der einmal über
Bluetooth gekoppelt wurde, ist für Windows ein Lautsprecher wie jeder andere.
James stellt das Standard-Ausgabegerät um, und alles, was dieser Rechner
abspielt, kommt dort heraus.

Der Unterschied zu Connect ist im Alltag spürbar und wird deshalb jedes Mal
mitgesagt: **Dorthin geht dann auch James' Stimme.** Wer Musik über das
Wohnzimmer hört, hört dort auch die Antwort auf „wie spät ist es".

`music_devices` zeigt beide Sorten getrennt an, und ein Name, der auf zwei
Geräte passt, führt zu einer Rückfrage statt zu einer Vermutung — Musik im
falschen Zimmer fällt erst auf, wenn sich jemand wundert.

### Was du sagen kannst

| Satz | Was passiert |
|---|---|
| „Spiel was von Bowie" | Auf dem eingestellten Standardgerät, sonst dort, wo zuletzt gespielt wurde |
| „Spiel das auf dem Echo Dot" | Über Spotify Connect, ohne diesen Rechner |
| „Mach das im Wohnzimmer weiter" | Verschiebt die laufende Wiedergabe |
| „Spiel Musik immer im Wohnzimmer" | Trägt das Standardgerät ein |
| „Nächster", „lauter", „was läuft gerade" | Greift auch auf einem entfernten Gerät |

---

## Über Alexa ansprechen

Eine Alexa-Skill, die auf diesen Rechner zeigt. Du sagst etwas, Amazon
transkribiert, schickt die Wörter durch denselben Tunnel wie die Telefonie,
James antwortet, der Echo liest vor. Kalender, Musik, Licht, Timer,
Gedächtnis — dieselben Antworten wie am Rechner.

**Das Weckwort bleibt „Alexa".** Es heißt immer „Alexa, frag James, …".
Amazon lässt Dritte das Weckwort nicht ändern — es gibt dafür keine
Einstellung, keinen Umweg und keinen Trick. Wer „Hey James" sagen will, sagt
es dem Rechner; der Echo ist die zweite Tür, nicht dieselbe. Das steht hier
oben, weil es die Erwartung ist, die jeder mitbringt.

### Einrichten

Unter **Einstellungen → Alexa**, in drei Schritten, weil sie aufeinander
aufbauen: Erst einschalten und starten — dann steht die Endpunkt-Adresse da.
Damit im [Alexa-Entwicklerbereich](https://developer.amazon.com/alexa/console/ask)
eine *Custom*-Skill anlegen, Aufrufname `jarvis`, ein Intent mit einem
einzigen Slot namens `frage` vom Typ `AMAZON.SearchQuery`. Der Slottyp ist der
Punkt: Nur er lässt einen ganzen Satz durch, statt ihn gegen eine Werteliste zu
prüfen. Zuletzt die Skill-Kennung zurück in die Einstellungen.

**Die Stelle, an der es sonst scheitert:** Amazon nimmt keinen Beispielsatz an,
der nur aus `{frage}` besteht — der Build des Sprachmodells schlägt dann fehl,
mit einer Meldung, die den Grund verschweigt. Es braucht Trägerwörter davor,
und die kommen bei James *nicht* an: Übermittelt wird nur der Slot. Taugen tun
deshalb ausschließlich Füllwörter — `sag mir {frage}`, `erzähl mir {frage}`,
`mach {frage}`, `spiel {frage}`. „wie" oder „was" wären verlockend und falsch:
Sie gehören zur Frage und fehlten hinterher, aus „wie wird das Wetter" käme
„wird das Wetter" an.

Braucht Tailscale oder cloudflared, genau wie die Telefonie. Ein
cloudflared-Quick-Tunnel bekommt bei jedem Start eine neue Adresse, die dann
in der Skill nachgetragen werden muss — mit Tailscale bleibt sie gleich.

### Wer da klopfen darf

Der Endpunkt steht im offenen Netz; er muss, sonst kommt Amazon nicht heran.
Was ihn schützt, steht in [`verify.ts`](src/main/alexa/verify.ts) und läuft
vor jeder Anfrage: Zertifikatskette nur von Amazons S3 unter `/echo.api/`,
gültiger Zeitraum, ausgestellt auf `echo-api.amazon.com`, Kette durchgehend
unterschrieben, Unterschrift über den rohen Rumpf, Zeitstempel höchstens 150
Sekunden alt, und die Skill-Kennung muss stimmen.

Die letzte Prüfung ist nicht die unwichtigste: Die Tunneladresse ist nicht
geheim, und eine fremde Skill könnte auf sie zeigen. Deren Anfragen trügen
echte Amazon-Unterschriften — sie kämen ja wirklich von Amazon. Nur die
Kennung unterscheidet sie. Deshalb startet der Dienst ohne sie gar nicht erst.

### Zwei Grenzen, die man merkt

**Acht Sekunden.** So lange wartet Alexa auf eine Antwort. Der Agentenlauf ist
deshalb auf sechs gedeckelt — die übrigen zwei gehen für Tunnel und
Signaturprüfung drauf. Was länger dauert, bekommt am Echo einen ehrlichen Satz
(„das dauert länger, ich sag dir am Rechner Bescheid") und wird im Hintergrund
zu Ende gebracht; das Ergebnis spricht dann James am Rechner.

**Weniger Werkzeuge.** Auskünfte, Musik, Licht, Timer, Kalender, Gedächtnis.
Keine Mails, keine Dateien, keine Einkäufe, keine Bildschirmsteuerung — und das
lässt sich nicht freischalten. Ein Echo hört jeden, der im Raum steht; es gibt
keine Anmeldung und keine Stimmerkennung, auf die man sich verlassen könnte.
Dieselbe Überlegung wie beim Licht, nur schärfer.

---

## Was er grundsätzlich nicht tut

Diese Grenzen hängen nicht an den Einstellungen und lassen sich nicht
abschalten:

- Er schließt **keine Käufe ab** und drückt keinen Bestellknopf. Er legt in den
  Warenkorb und öffnet die Kasse — bestellen musst du selbst.
- Er gibt **keine Passwörter, PINs, Kartennummern oder Zahlungsdaten** ein und
  tippt sie auch nicht.
- In **Banking-, Passwortmanager- und Bezahlfenstern** übernimmt er die
  Bildschirmsteuerung nicht.
- **Sicherheitsabfragen** löst er nicht, sondern übergibt an dich.
- Mails und Dateien **löscht er nicht endgültig**. Der Papierkorb ist die
  einzige Löschstufe, die es gibt.
- Er schreibt **nur in deine eigenen Ordner** — Desktop, Dokumente, Downloads,
  Bilder, Videos, Musik. Ein Pfad nach C:\Windows ist nicht abgesichert,
  sondern für ihn gar nicht erst formulierbar: das Werkzeug nimmt einen
  Ordnernamen aus einer festen Liste und einen Dateinamen, sonst nichts.

Nachgefragt wird bei dem, was nach außen wirkt oder sich nicht zurücknehmen
lässt: Mails verschicken und beantworten, Warenkorb ändern, Kasse öffnen,
Dateien schreiben, Befehle ausführen, wiederkehrende Aufträge einrichten. Und
zwar konkret: „Ich schicke eine Mail an Max Mustermann mit dem Betreff
Rechnung. Soll ich?" Die Zusage prüft der Hauptprozess gegen das, was du
tatsächlich gesagt hast; das Modell kann sie sich nicht selbst erteilen.

Die **Bildschirmsteuerung fragt nicht mehr jedes Mal** — bei „mach mal eben"
erst um Erlaubnis zu bitten hat im Alltag mehr genervt als geschützt. Wer sie
zurück will, stellt unter **Rechte** das Werkzeug `computer_task` auf „fragt
nach".

Jede ausgeführte Aktion steht im **Aktionslog** in den Einstellungen. Da es
keine Chatoberfläche gibt, ist das die Stelle zum Nachvollziehen.

---

## Wenn etwas nicht stimmt

**Zuerst: das Protokoll.**
Einstellungen → Über → **Protokoll zeigen** öffnet den Ordner mit
`jarvis.log` (liegt unter `%APPDATA%\void-jarvis\logs\`). Darin steht, was
zuletzt schiefging — aus Haupt- *und* Renderprozess, dazu unbehandelte Fehler
und abgestürzte Unterprozesse.

Das ist nicht bloß Bequemlichkeit: Eine mit electron-builder gepackte App ist
unter Windows ein GUI-Prozess und hängt an keiner Konsole. Alles, was über
`console.error` ging, fiel dort ersatzlos aus — beim Entwickeln sieht man es im
Terminal, beim Benutzer nie. Wer die App nicht selbst gebaut hat, kann keine
Entwicklerwerkzeuge öffnen; die Datei ist das Einzige, was er verschicken kann.

Sie rotiert bei 2 MB (eine Generation, `jarvis-vorher.log`), und was wie ein
Zugangsschlüssel aussieht — Google-Keys, Bearer-Token, OAuth-Refresh-Token,
Twilio-SIDs — wird beim Schreiben ersetzt. Eine Datei zum Verschicken liest
niemand vorher Zeile für Zeile durch.

**Für jemanden, der die App nur benutzt:** `resources/kurzanleitung.html` ist
eine Seite zum Ausdrucken — SmartScreen-Klickweg, die drei Wege ihn
anzusprechen, der Not-Aus, und wie man an das Protokoll kommt. Sie wird
mitinstalliert und ist über Einstellungen → Über → **Kurzanleitung öffnen**
erreichbar.

**Er unterbricht dich mitten im Satz.**
Einstellungen → Zuhören → Sprechpause erhöhen. 700 ms ist der Standard, 900 bis
1000 ms lässt dir mehr Luft zum Nachdenken.

**Er versteht dich schlecht.**
Einstellungen → Audio → Mikrofontest. Der Balken sollte beim normalen Sprechen
etwa bis zur Mitte ausschlagen. Bleibt er links, ist das falsche Gerät gewählt.
Prüf außerdem, dass Rauschunterdrückung aktiv ist.

**Er unterbricht sich selbst dauernd.**
Echounterdrückung ist aus, oder du hörst über Lautsprecher und „Mikrofon
pausieren, während James spricht" ist deaktiviert. Beides unter Audio.

**Die Sprachausgabe stottert.**
Einstellungen → Audio → Pufferzeit erhöhen.

**Chrome-Werkzeuge melden „nicht angemeldet".**
Sie laufen im James-Browser, nicht in deinem. Einstellungen → Verbindungen →
**Anmelden**: Das Fenster geht auf der richtigen Seite auf, du meldest dich an,
danach bleibt es. Dein eigenes Chrome musst du dafür nicht schließen.

**Das Weckwort reagiert nicht.**
In der installierten Fassung liegen die Modelle bei — dort ist die Ursache
eher das Mikrofon (Einstellungen → Audio → Mikrofontest). Im Projektordner
fehlen sie womöglich: `npm run wakeword` ausführen. Ohne die Modelle bleiben
Hotkey und Klick.

**Er reagiert auf gar nichts mehr.**
Vielleicht ist er stillgelegt — die Zeile unter der Kugel sagt dann
„Stillgelegt". Ein Klick auf die Kugel holt ihn zurück.

**Die Bildschirmsteuerung tut nichts.**
Frag ihn „geht deine Bildschirmsteuerung". Er nennt dann den Weg, über den er
Maus und Tastatur bewegt. Normalfall auf diesem Rechner ist `powershell` — die
nativen Bindings von nut.js bauen hier nicht, deshalb läuft ein
PowerShell-Prozess mit, der `user32.dll` anspricht.

**Gmail oder Amazon gehen nicht.**
Einstellungen → Verbindungen → Jetzt prüfen. Dort steht, woran es liegt:
Browser startet nicht, im James-Browser nicht angemeldet, oder
OAuth-Zustimmung abgelaufen. Die Prüfung fährt den Browser dafür hoch und sieht
wirklich nach — bei Amazon in der Seite selbst, denn den Warenkorb zeigt Amazon
auch ohne Anmeldung, dann eben als leeren Gast-Warenkorb.

**Er sagt „das kann ich nicht".**
Solche Stellen kann James als **Fähigkeitslücke** an den Fehlerbericht-Empfänger
melden, damit die Fähigkeit ins nächste Update kommt: deine Bitte, seine Antwort,
den erkannten Grund, einen Lösungsvorschlag und die beteiligten Werkzeuge. Das
greift auch, wenn ein Werkzeug fehlt, unbekannt ist oder scheitert. Einschalten:
Einstellungen → Zugänge → Optionale Fehlerberichte → **Fähigkeitslücken mit
Gesprächsausschnitt senden**. Standardmäßig aus, weil der Bericht anders als die
technische Statistik Gesprächstext enthält. E-Mail-Adressen, Telefonnummern, IBANs,
Schlüssel und Linkpfade werden vorher entfernt, Namen in der Bitte nicht unbedingt.

---

## Aufbau

```
src/
├─ main/        Hauptprozess: Werkzeuge, Rechte, Automatisierung, Datenbank
├─ preload/     Enge IPC-Brücke, nur die Kanäle aus dem Vertrag
├─ renderer/    Die Kugel (Three.js) und das Einstellungsfenster
└─ shared/      Typen, IPC-Vertrag, System-Prompt, App-Registry

resources/
├─ windows-helper.ps1   Verknüpfungen, Fenster, PC-Zustand — je ein Aufruf
├─ input-server.ps1     Maus und Tastatur — ein Dauerläufer
├─ uia-server.ps1       Der Bedienbaum der Fenster — ebenfalls ein Dauerläufer
├─ audio-devices.ps1    Ausgabegeräte und was gerade spielt — je ein Aufruf
└─ companion/           Die Seite fürs Telefon, ohne Bauschritt
```

Die Live-Verbindung sitzt bewusst im Renderer, nicht im Hauptprozess: Audio
soll keinen Prozesswechsel machen. Über IPC gehen nur Werkzeugaufrufe.

Die Fernbedienung fürs Telefon hält sich daran, obwohl sie einen Server im
Hauptprozess braucht — ein Renderer kann keinen Port aufmachen. Statt Ton über
IPC zu schicken, hängt sich das Kugelfenster als gewöhnlicher Client an
denselben WebSocket, den auch das Telefon benutzt, nur über 127.0.0.1. Die
WebSocket-Schicht ist handgeschrieben (`src/main/companion/websocket.ts`):
`ws` liegt zwar im Ordner, aber nur, weil eine andere Abhängigkeit es
mitgebracht hat.

Auch die Musik hat einen PowerShell-Anteil, aber nur den kleinen Rest, für den
Node unter Windows keinen Weg hat: das Standard-Ausgabegerät auslesen und
umstellen (COM, davon ein undokumentiertes Interface — Windows bietet dafür
nichts Offizielles an), und auslesen, was gerade spielt. Letzteres über die
System Media Transport Controls, also dieselbe Stelle, an der auch die
Medientasten hängen. Das ist die einzige Auskunft, die auch dann stimmt, wenn
James die Musik gar nicht selbst angemacht hat. Alles Übrige — Spotify
Connect, die Apple-Katalogsuche — ist gewöhnliches HTTP aus dem Hauptprozess.

Maus und Tastatur laufen über `input-server.ps1`, einen PowerShell-Prozess,
der mitläuft und `user32.dll` anspricht. Als Dauerläufer, weil das `Add-Type`
darin den C#-Compiler ruft — bei einem Prozess pro Klick käme ein
Vision-Durchlauf allein dadurch auf eine halbe Minute Wartezeit. Findet sich
nut.js mit funktionierenden nativen Bindings, wird stattdessen das genommen.

**Modelle:** `gemini-3.1-flash-live-preview` für die Stimme (umschaltbar auf
`gemini-2.5-flash-native-audio-preview-12-2025` für Emotionserkennung), `gemini-3.6-flash` für
Denken und Bildschirmauswertung, `deep-research-preview-04-2026` für Recherche.

---

## Kosten

Live-Audio wird pro Sekunde abgerechnet, alles andere pro Token. Fünf Hebel,
nach Wirkung sortiert:

1. **Trennung nach Stille** (Zuhören, Standard 45 Sekunden). Das Weckwort
   läuft lokal und gratis; eine Verbindung entsteht erst, wenn du ihn
   ansprichst.
2. **Stille lokal wegfiltern** (Zuhören). Was nach Raumgeräusch klingt, geht
   gar nicht erst hoch. Nach dem Ende einer Äußerung läuft der Upload noch
   kurz weiter — sonst merkt die Gegenseite nie, dass du fertig bist.
3. **Werkzeugergebnisse kürzen** (Sparmodus). Eine gelesene Mail kommt mit
   sechstausend Zeichen zurück; vorgelesen wird davon nie mehr als ein Absatz.
4. **Werkzeugbeschreibungen kürzen** (Sparmodus). Die gehen bei jedem
   Verbindungsaufbau erneut über die Leitung, also alle fünfzehn Minuten.
5. **Bildschirmfotos** (Bildschirmsteuerung). Ein Bild kostet nicht nach
   Datenmenge, sondern nach Kantenlänge: Es wird in Kacheln von 768 mal 768
   Bildpunkten zerlegt, und jede Kachel hat ihren festen Preis — bei jedem
   Schritt aufs Neue. Zwei Dinge folgen daraus. Erstens werden die Bilder
   genau auf das Kachelraster zugeschnitten statt auf eine runde Zahl; 1365
   mal 768 kostet dasselbe wie 1280 mal 720 und zeigt vierzehn Prozent mehr.
   Zweitens fasst er absehbare Schritte zu einem Zug zusammen — drei Aktionen,
   ein Bild statt drei. Für kleinen Text gibt es die Ausschnittsvergrößerung;
   die ist billiger als ein durchgehend größeres Vollbild. Im Sparmodus
   arbeitet er mit einer Kachel weniger.

Was das zusammen bringt, steht unter **Einstellungen → Sparmodus**, und James
sagt es auf Nachfrage auch selbst.

Eine tiefe Recherche kostet je nach Tiefe etwa ein bis drei Dollar, in der
Stufe „maximal" drei bis sieben. Die Übersicht steht unter Einstellungen → Über.

Dort steht auch ein **Tageslimit**. Es greift bei dem, was ein bekanntes
Preisschild hat — derzeit die Recherche. Ist die Grenze erreicht, lehnt James
den nächsten Lauf ab und sagt warum, statt ihn stillschweigend zu starten.
Gerechnet wird mit dem erwarteten Betrag, nicht nur mit dem bisherigen Stand:
sonst wäre bei vier von fünf Dollar noch eine Recherche für drei erlaubt.
Standardmäßig ist die Bremse aus.

## Warum der Ordner so groß ist

Der eigene Code sind rund 400 Kilobyte. Der Rest ist Werkzeugkasten:

| Was | Größe | Wird ausgeliefert? |
|---|---|---|
| `electron` | 271 MB | nein — das ist die Entwicklungsumgebung |
| `app-builder-bin` | 207 MB | nein — nur zum Paketieren |
| `onnxruntime-web` | 132 MB | nur die eine WASM-Datei fürs Weckwort (13,5 MB) |
| `googleapis` | 119 MB | nur der Gmail-Teil |
| Rest | ~280 MB | teilweise |

Der fertige Installer aus `npm run dist` liegt bei rund 95 MB, nicht bei einem
Gigabyte. Wer den Platz trotzdem braucht: `node_modules` löschen, und vor dem
nächsten `npm run dev` einmal `npm install` — das ist ein Zwischenlager, kein
Bestandteil der App.

## Was der fertige Installer voraussetzt

Nichts, was man vorher installieren müsste. Node, Python und npm gehören zur
Werkbank, nicht zum Ergebnis: Electron bringt seine eigene Node-Laufzeit mit,
PowerShell steckt in Windows, und die Weckwort-Modelle liegen im Paket.

Drei Dinge sind rein optional und in der Vorgabe aus:

| Optional | Wofür | Ohne das |
|---|---|---|
| Chrome | Gmail, Yahoo, Amazon im James-Browser | Diese Werkzeuge melden „nicht verfügbar", alles andere läuft |
| Python mit PyTorch | VibeVoice als lokale Stimme | piper spricht, oder Gemini — siehe unten |
| Ollama | Denken ohne Netz, Übersetzen ohne Netz | Läuft über Gemini weiter |
| Tailscale | Fernbedienung übers Telefon von unterwegs | Zu Hause geht sie trotzdem |

**Gesprochen wird ab Werk auf diesem Rechner.** Die Voreinstellung ist piper.
Mitgeliefert ist es nicht — Programm und Stimme werden unter **Einstellungen →
Stimme** auf Klick geholt, zusammen keine 100 MB. Solange das nicht passiert
ist, spricht Gemini: Fehlt die lokale Stimme, tritt der Live-Motor an ihre
Stelle, und zu hören ist eine andere Stimme, kein Ausfall.

Genau diesen Rückweg gibt es für Abschrift und Denken nicht, deshalb stehen
beide ab Werk draußen. Fehlte whisper, käme ein leerer Wortlaut zurück;
antwortete Ollama nicht, stünde der Beitrag. Wer die Stücke geholt hat, stellt
es unter **Stimme** (Denken) und **Ohren** (Abschrift) um — dort steht auch,
was gerade wirklich läuft.

**Beim ersten Öffnen zeigt Windows „Der Computer wurde durch Windows
geschützt".** Das liegt nicht am Programm, sondern daran, dass der Installer
nicht signiert ist — eine Signatur kostet Geld und ein Zertifikat auf einen
eingetragenen Namen. Weg dort: auf **Weitere Informationen** klicken, dann auf
**Trotzdem ausführen**. Wer die Datei weitergibt, sagt das am besten dazu; es
ist genau die Stelle, an der ein misstrauischer Mensch zu Recht abbricht.

---

## Entwicklung

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

Die Tests laufen über Nodes eingebauten Runner, ein Framework kommt nicht
dazu. Geprüft wird, was still falsch sein kann:

- **Der Zod→JSON-Schema-Konverter**, gegen die Schemata aller Werkzeuge —
  Felder, Typen, Beschreibungen, Pflichtangaben. Diese Übersetzung entscheidet,
  was das Modell von einem Werkzeug sieht. Geht dabei etwas verloren, gibt es
  keine Fehlermeldung; das Werkzeug wird bloß falsch oder gar nicht aufgerufen,
  und an der Kugel sieht das aus wie ein dummes Modell.
- **Der Einheitenrechner**, samt der Umrechnungen, die es nicht geben darf.
  Kilogramm, Meter, Liter und km/h haben alle den Faktor 1 auf ihre eigene
  Basis — ohne Dimensionsprüfung ergibt „5 Kilo in Meter" glatt 5.

Dazwischen liegt `scripts/run-tests.mjs`: Es übersetzt die Tests mit esbuild,
weil die Quellen ohne Dateiendung und über `@main/` importieren, und schiebt
für Electron einen Ersatz unter — das echte gibt es außerhalb des
Electron-Prozesses nicht. Die Gründe stehen ausführlich im Kopf der Datei.

```bash
npm run dist
```

Die Programmsymbole entstehen aus `scripts/make-icon.mjs` — erst laufen
lassen, wenn sich Form oder Farbe ändern sollen, sonst nie. Es schreibt drei
Dateien: `resources/icon.ico` mit neun einzeln gezeichneten Größen (das ist
die, die electron-builder einbindet), `resources/icon.png` zum Nachsehen und
`resources/tray.png` für den Infobereich. Gezeichnet wird dasselbe wie im
Fenster, eine Dimension tiefer: vier Gaußglocken, deren Summe zugleich über
Farbe und Deckkraft entscheidet. Jede Größe wird eigens gerastert statt aus der
größten heruntergerechnet — bei 16 Bildpunkten ist der Unterschied ein Körper
mit hellem Kern gegen einen blassblauen Fleck.

**Beim ersten `npm run dist`** holt electron-builder ein Signierwerkzeug und
entpackt es. Darin stecken macOS-Symlinks, und die darf Windows ohne
Entwicklermodus nicht anlegen — der Bau bricht dann mit „Cannot create
symbolic link" ab, obwohl gar nichts signiert wird. Abhilfe: Entwicklermodus
einschalten (Einstellungen → System → Für Entwickler) oder das Paketieren
einmal in einer Eingabeaufforderung als Administrator starten.

Die Renderer-Konsole wird in den Hauptprozess weitergeleitet — bei einem
rahmenlosen Fenster ohne Entwicklerwerkzeuge ist das der einzige Weg, Fehler in
Shadern, Audio-Worklets oder der Live-Verbindung zu sehen.

## Danksagung

Die agentische Arbeitsweise — sichtbarer Plan, selbst geschriebene
Fertigkeiten mit Lernschleife, Unteragenten und Gedächtnis-Pflege — folgt den
Ideen von [Hermes Agent](https://github.com/NousResearch/hermes-agent) von
Nous Research (MIT-Lizenz). Übernommen sind Konzepte, kein Quelltext; Hermes
ist in Python geschrieben, James in TypeScript.
