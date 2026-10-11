# James auf dem iPhone

Diese Seite ist die Fernbedienung. Sie wird vom Hauptprozess ausgeliefert
(`src/main/companion/server.ts`), hat keinen Bauschritt und keine
Abhängigkeiten — was hier liegt, ist genau das, was auf dem Telefon läuft.

## Warum das keine portierte App ist

Void James auf iOS zu bringen ist nicht schwer, sondern unmöglich, und der
fehlende Mac ist dabei das kleinste Problem. Electron gibt es dort nicht, und
alles, was James ausmacht, ist im Sandkasten von iOS gesperrt: fremde Programme
starten, Maus und Tastatur übernehmen, den Bildschirm anderer Fenster
abfotografieren, Chrome fernsteuern, ins Dateisystem, das Minecraft-Protokoll
lesen. Eine Portierung ergäbe eine App, die von dieser App nichts mehr kann.

Also bleibt der Rechner der Agent, und das Telefon wird sein Mikrofon, sein
Lautsprecher und seine Anzeige.

Ein Weckwort gibt es hier nicht. iOS lässt weder eine Seite noch eine App
dauerhaft im Hintergrund mithören; ein Weckwort, das nur wirkt, solange man auf
den Bildschirm schaut, wäre eine Attrappe. Stattdessen die Sprechtaste.

## Stufe 1 — als Webseite, ohne alles

Kein Mac, keine 99 Dollar, keine Prüfung durch Apple, kein Konto irgendwo.

**Ein Zertifikat gehört dazu, und zwar nicht als Sorgfalt.** `getUserMedia`
verlangt auf iOS einen sicheren Kontext; ausgenommen ist einzig `localhost`,
eine Adresse wie `http://192.168.1.20:8788` fällt durch. Safari stellt
`navigator.mediaDevices` dort gar nicht erst bereit — die Sprechtaste wäre also
tot, ohne dass sich daran etwas einstellen ließe.

Für eine Adresse im Heimnetz stellt kein öffentlicher Aussteller etwas aus.
Also stellt James es sich selbst aus, und das Telefon lernt einmal, ihm zu
trauen. Zu unterscheiden sind dabei zwei Dinge, die leicht in einen Topf
geraten:

- **Durchklicken** in Safari ist eine Ausnahme für genau diesen einen Ursprung.
  Sie gilt nicht für den WebSocket daneben, und auf dem Startbildschirm ohne
  Safari-Leisten gibt es nichts zum Durchklicken. Das hilft also nicht.
- **Eine eigene Stelle als vertrautes Root eintragen** ist etwas anderes: Für
  iOS ist das Zertifikat danach echt. Keine Warnung, kein Durchklicken, der
  WebSocket validiert normal.

Der zweite Weg ist der, den `src/main/companion/cert.ts` geht.

1. Am Rechner: Einstellungen → Telefon. Dort steht immer genau ein Schritt, und
   daneben der Knopf, der ihn erledigt — **Zertifikat erstellen**, dann
   **Einschalten**.
2. Den ersten QR-Code abfotografieren. Er führt auf eine Seite mit dem Profil
   und den zwei Schritten darunter:
   **Einstellungen → Profil geladen → Installieren**, und danach
   **Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen**,
   dort den Schalter für *Void James* umlegen. Der zweite wird gern übersehen;
   ohne ihn liegt das Profil nur herum.
3. Zurück am Rechner auf **Erledigt** drücken. Ob es geklappt hat, kann der
   Rechner nicht sehen — der Schalter sitzt am Telefon.
4. Den zweiten QR-Code abfotografieren. Safari öffnet die Adresse und trägt die
   Marke aus dem Adress-Fragment selbst ein — abgetippt wird nichts.
5. Teilen → **Zum Home-Bildschirm**.

Danach startet es mit eigenem Symbol im Vollbild. Was fehlt: der Weckknopf
(dazu unten), der Zugang von außer Haus (dazu gleich) und alles, was
Hintergrundbetrieb bräuchte — wischt man die App weg, schließt iOS die
Verbindung. Beim Zurückkehren verbindet sie sich von selbst.

Der Preis dieses Weges steht in `cert.ts` und gehört auch hierher: **Ein Root,
dem das Telefon vertraut, ist eine Vollmacht.** Wer den privaten Schlüssel hat,
kann diesem Telefon jede beliebige Seite vorspielen. Er liegt DPAPI-verschlüsselt
in den App-Daten und ist auf einem anderen Rechner wertlos — dieselbe Zusage wie
bei den API-Schlüsseln. Zurücknehmen lässt sich die Vollmacht nur am Telefon,
indem man das Profil löscht.

Zwei Randfälle, die im Alltag vorkommen:

- **Die Adresse wandert.** Ohne feste Vergabe im Router bekommt der Rechner
  irgendwann eine andere, und das Zertifikat passt nicht mehr. James merkt das
  und stellt ein neues aus; am Telefon ist dafür nichts zu tun, weil die Stelle
  dieselbe bleibt. Wer die Meldung nie wieder sehen will, trägt im Router eine
  feste Adresse ein.
- **Das Serverzertifikat läuft ab.** Nach 397 Tagen — mehr nimmt iOS nicht an.
  Erneuert wird zwei Wochen vorher, still, aus derselben Stelle. Die gilt zehn
  Jahre.

Geht gar nichts, läuft der Server trotzdem, nur über einfaches HTTP: Anzeige,
Wiedergabe und das Tippfeld gehen, die Sprechtaste nicht. Die Einstellungsseite
schreibt das auch so hin, statt es beim Ausprobieren scheitern zu lassen.

## Stufe 2 — als echte App, immer noch ohne Mac

Gebraucht wird sie für genau eine Sache: **Wake-on-LAN**. Ein Browser kann keine
UDP-Pakete verschicken, und ein Zauberpaket ist nichts anderes. Schläft der
Rechner, ist auch der Server hier aus — geweckt werden kann er also nur vom
Telefon, und das geht nur nativ.

Der Weg führt über [Capacitor](https://capacitorjs.com): Es verpackt genau diese
Dateien in eine iOS-App, ohne dass sie geändert werden müssen.

```bash
npm create @capacitor/app@latest jarvis-phone
```

In `capacitor.config.json` den `webDir` auf eine Kopie dieses Ordners zeigen
lassen. Danach ein Plugin mit einem UDP-Sockel — es gibt fertige, oder zwanzig
Zeilen Swift — und die Brücke unter dem Namen anmelden, den `app.js` sucht:

```js
window.jarvisNative = {
  async wake({ mac, broadcast }) { /* 6× 0xFF, dann 16× die MAC, UDP an Port 9 */ }
}
```

Mehr erwartet die Seite nicht. Fehlt `window.jarvisNative`, bleibt der Knopf
sichtbar und sagt, warum er nicht kann — das ist ehrlicher, als ihn zu
verstecken.

**Gebaut wird in der Wolke**, denn Xcode läuft nur auf macOS:

| Dienst | Mac nötig | Anmerkung |
| --- | --- | --- |
| Codemagic | nein | Baut iOS auf gemieteten Macs, freies Kontingent für kleine Projekte |
| Expo EAS Build | nein | Verwaltet Zertifikate und Profile über Apples Schnittstelle mit |
| GitHub Actions | nein | macOS-Runner; für private Projekte zählen die Minuten vielfach |
| MacinCloud | nein | Ein gemieteter Mac zum Selbstbedienen, stundenweise |

Aufs Gerät kommt die App nur mit dem **Apple Developer Program**, 99 Dollar im
Jahr — über TestFlight oder direkt. Wer das sparen will: AltStore, dessen
AltServer unter Windows läuft, signiert mit einer freien Apple-ID. Dann verfällt
die Signatur allerdings nach sieben Tagen und muss wöchentlich erneuert werden,
und die `.ipa` muss trotzdem irgendwo auf einem Mac entstanden sein.

## Wake-on-LAN einrichten

Drei Schalter, und die Software erreicht nur zwei davon:

1. **Die Netzwerkkarte** muss auf das Zauberpaket horchen. Einstellungen →
   Telefon → *Aufwachen einschalten* erledigt das, braucht dafür aber erhöhte
   Rechte.
2. **Der Windows-Schnellstart** hält den Rechner beim Herunterfahren in einem
   Ruhezustand, aus dem die meisten Karten nicht mehr aufwachen. *Bereitschaft
   prüfen* sagt, ob er an ist. Aus dem Schlaf klappt es auch mit ihm.
3. **Das BIOS.** Dorthin kommt keine Software. Wacht er trotz grüner Anzeigen
   nicht auf, liegt es hier.

Über WLAN funktioniert es meistens gar nicht — dafür bräuchte die Karte
zusätzlich Wake-on-Wireless-LAN. Steckt ein Kabel, wird es bevorzugt.

## Von unterwegs

Das eigene Zertifikat lautet auf eine Adresse im Heimnetz und gilt dort. Wer die
Fernbedienung auch außer Haus will, braucht einen Namen, der von überall
auflöst, und ein Zertifikat darauf — dafür ist **Tailscale** weiter eingebaut:
Einstellungen → Telefon → *Zertifikat* auf Tailscale stellen. Die Auswahl
erscheint nur, wenn Tailscale auf dem Rechner liegt; sonst zeigte sie auf eine
Tür, hinter der nichts ist.

Beide Geräte im selben Tailnet angemeldet, unter **DNS** MagicDNS und HTTPS an,
dann holt sich James das Zertifikat über `tailscale cert` und erneuert es ab
zwei Wochen Restlaufzeit. Ein Vertrauensprofil braucht es dabei nicht — das
Zertifikat ist öffentlich vertraut.

**Keine Portfreigabe.** Dahinter sitzt etwas, das Mails verschickt und
Warenkörbe füllt. Der Server bindet zwar auf alle Schnittstellen — sonst käme
das Telefon im WLAN nicht heran —, aber erreichbar sein soll er nur im Heimnetz
und im Tailnet.

## Dateien

| Datei | Wofür |
| --- | --- |
| `index.html` | Gerüst, zwei Bildschirme: koppeln und bedienen |
| `app.js` | Verbindung, Ton in beide Richtungen, Bedienung |
| `mic-worklet.js` | Mikrofon → 16-kHz-PCM, im Audio-Thread |
| `style.css` | Dunkel, mit den Abständen für Notch und Homebalken |
| `sw.js` | Nur damit iOS es als App auf den Startbildschirm lässt |
| `manifest.webmanifest` | Name, Symbol, Vollbild |
| *(Rechnerseite)* | `src/main/companion/cert.ts` stellt das eigene Zertifikat aus |
| *(Rechnerseite)* | `resources/companion-cert.ps1` tut die Arbeit dafür |
| *(Rechnerseite)* | `src/main/companion/tailscale.ts` — die Quelle für unterwegs |
