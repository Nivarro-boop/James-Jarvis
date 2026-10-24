# James auf dem iPhone und der Apple Watch

Neue Watch-App unter `targets/watch/`: SwiftUI, Orb, Diktat-/Texteingabe,
Verlauf, Pause, Ton und Rechner-Wecken. Das lokale Modul verbindet die Watch
über das iPhone mit dem Rechner; der Zugang bleibt im iPhone-Keychain.
Die native Erweiterung wurde unter Windows **nicht kompiliert oder am Gerät
geprüft**. Der JS-Export ersetzt diesen Test nicht.

Für den Apple-Build:

1. Apple-Team-ID in `expo.ios.appleTeamId` in `app.json` setzen.
2. Mit `npx eas-cli@latest init` das eigene Expo-Projekt verknüpfen.
3. `npx eas-cli@latest build --platform ios --profile development` ausführen.
4. Neue iPhone-Fassung installieren, HTTPS-Kopplungs-QR-Code am Rechner scannen
   und die James-Watch-App installieren. Auf der Watch den Lautsprecher
   einschalten und über die Systemtastatur diktieren.

Die Watch benötigt das gekoppelte iPhone. Sie versendet bei fehlender Verbindung
keine veralteten Befehle automatisch. Rechner und iPhone müssen sich erreichen;
das lokale Zertifikat muss auf dem iPhone vertraut sein. Hintergrundlaufzeit
und Audioausgabe werden von iOS/watchOS begrenzt.

Prüfen: `npm run lint`, `npm run typecheck`, `npm test`, `npx expo-doctor`.
[Gesamter Prüfbericht](../docs/Orb-Watch-Remote-Update-1.3.11.md).

Native Hülle um die Fernbedienungsseite unter `../resources/companion/`.
Der Rechner bleibt der Agent; das iPhone ist Mikrofon, Lautsprecher und
Anzeige. Warum das keine Portierung ist, steht in
`../resources/companion/README.md`.

Was die App mehr kann als die Seite in Safari:

- **Rechner aufwecken** (Wake-on-LAN). Eine Webseite darf kein UDP senden; das
  lokale Modul `modules/jarvis-wake` schon. Die Seite ruft es über
  `window.jarvisNative.wake` auf.
- **Bildschirm, wenn der Rechner schläft.** Dann lädt die Seite gar nicht. Die
  App merkt sich das Weckziel (`window.jarvisNative.remember`) und bietet den
  Weckknopf trotzdem an.
- **Koppeln per QR-Code** mit der eingebauten Kamera. Link und Weckziel liegen
  im iOS-Schlüsselbund.

Die WebView lädt nur den gekoppelten Rechner. Fremde Links öffnen in Safari;
Nachrichten an die Brücke werden nur von dieser Adresse angenommen.

## Aufbau

| Datei | Wofür |
| --- | --- |
| `App.tsx` | Koppeln, Fernbedienung (WebView), Offline-Bildschirm |
| `src/pairing.ts` | Prüft den Kopplungs-Link, erlaubter Ursprung |
| `src/storage.ts` | Schlüsselbund, prüft das Weckziel aus der WebView |
| `modules/jarvis-wake/` | Swift-Modul: Zauberpaket per UDP an Port 9 |
| `app.json` | Name, Bundle-ID, Rechte-Texte, Plugins |
| `eas.json` | Bauprofile für EAS Build |

## Prüfen

```bash
npx tsc --noEmit
```

```bash
npm test
```

```bash
npx expo-doctor
```

## Bauen ohne Mac

Xcode läuft nur auf macOS. Gebaut wird deshalb mit **EAS Build** in der Cloud.

1. Expo-Konto anlegen (kostenlos) und anmelden: `npx eas-cli@latest login`.
2. Projekt verknüpfen: `npx eas-cli@latest init`.
3. Testfassung bauen: `npx eas-cli@latest build --platform ios --profile development`.
   EAS fragt nach dem Apple-Konto und legt Zertifikat und Profil selbst an.
   Das iPhone wird dabei per Link registriert.
4. App vom Link installieren, am Rechner Einstellungen → Telefon öffnen,
   Kopplungs-QR-Code in der App scannen.

Für TestFlight und App Store: `--profile production`, danach
`npx eas-cli@latest submit --platform ios`.

Voraussetzung für Geräte-Installation: **Apple Developer Program** (99 USD pro
Jahr). Expo Go reicht nicht: Das Weckmodul ist eigener nativer Code.

## Grenzen

- **Broadcast braucht eine Freigabe von Apple.** Seit iOS 14 verlangt UDP an
  eine Broadcast-Adresse die Berechtigung
  `com.apple.developer.networking.multicast`. Apple gibt sie auf Antrag frei
  (developer.apple.com → Multicast Networking Entitlement Request). Bis dahin
  schickt die App das Paket zusätzlich direkt an die letzte Adresse des
  Rechners. Das klappt meist, solange der Router den Rechner noch kennt.
  Nach der Freigabe in `app.json` unter `ios.entitlements` eintragen.
- **Zertifikat.** Ohne vertrautes Zertifikat gibt iOS das Mikrofon nicht frei.
  Ablauf wie in Safari: erster QR-Code am Rechner, Profil installieren, unter
  Allgemein → Info → Zertifikatsvertrauenseinstellungen einschalten.
- **Kein Weckwort, kein Hintergrund.** iOS erlaubt kein dauerhaftes Mithören.
  Beim Zurückkehren in die App verbindet die Seite sich selbst neu.
- Swift-Code und App auf echtem iPhone sind unter Windows nicht geprüft. Der
  erste EAS-Build ist die erste echte Prüfung.
