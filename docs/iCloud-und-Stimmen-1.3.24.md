# iCloud-Anmeldung und Stimmen-Galerie – Version 1.3.24 (25.10.2026)

## iCloud

Die iCloud-Anmeldung lag bisher eingeklappt unter „Technischer Status aller Verbindungen“. Sie steht jetzt sichtbar unter **Einstellungen → Verbindungen → Konten** als eigene Karte **Apple iCloud** mit drei Schritten:

1. **Mit Apple Account anmelden**: Öffnet iCloud rechts im James-Browser. Passwort und Zwei-Faktor-Code gibt der Nutzer nur bei Apple ein. Die Karte zeigt, ob im Browser ein iCloud-Anmeldecookie vorhanden ist. Das ist ein Hinweis und keine Bestätigung. Knöpfe öffnen Mail, Kalender, iCloud Drive, Fotos, Kontakte, Notizen, Erinnerungen, Pages, Numbers, Keynote und „Wo ist?“. „Im Browser abmelden“ löscht die iCloud- und Apple-Cookies und die gespeicherten Seitendaten dieser Domains.
2. **Mail und Kalender direkt**: Benötigt die iCloud-Mailadresse und ein app-spezifisches Passwort von account.apple.com. Das normale Apple-Account-Passwort wird abgelehnt. Die Daten liegen DPAPI-verschlüsselt im bestehenden Schlüsselspeicher. Neue Werkzeuge:
   - `icloud_mail_list`: Neueste Mails, nur ungelesene, Suche, andere Ordner. Zugriff über IMAP `imap.mail.me.com:993`, nur lesend.
   - `icloud_mail_read`: Vollständige Mail ohne „gelesen“-Markierung.
   - `icloud_mail_send`: Versand über SMTP `smtp.mail.me.com:587`. Fragt **immer** vorher nach (`alwaysAsk`).
   - `icloud_calendar`: Termine aller iCloud-Kalender über CalDAV mit denselben Zeiträumen wie die übrigen Kalenderwerkzeuge und mit Agenda-Karte.
   Die Zugangsdaten gehen nur an Apples feste Hosts. CalDAV-Weiterleitungen werden einzeln geprüft (`caldav.icloud.com`, `pNN-caldav.icloud.com`).
3. **iCloud Drive**: Wenn „iCloud für Windows“ installiert ist (`%USERPROFILE%\iCloudDrive`), kann James mit `icloud_drive_list` suchen und mit `icloud_drive_read` Textdateien lesen. Pfade außerhalb des Drive-Ordners werden abgelehnt. Ohne diesen Ordner öffnet James Drive im Browser.

Fotos, Notizen, Erinnerungen und Kontakte bleiben Browser-Zugänge, weil Apple dafür keine öffentliche Schnittstelle anbietet. Apple Health läuft weiterhin nur über die native iPhone-App.

## Stimmen-Galerie

Unter **Einstellungen → Stimme & Modelle → 2 · Stimme wählen** gibt es eine Galerie mit 14 klaren Assistentenstimmen, jeweils mit **Anhören** und **Wählen**. Die bisherigen Anbieter-Knöpfe und Regler stehen eingeklappt darunter.

- Siris eigene Stimme gehört Apple und ist nur auf Apple-Geräten verfügbar. Sie kann weder kopiert noch mitgeliefert werden. Mit „Wie Siri“ markiert sind die Stimmen, die ihrem sauberen, ruhigen Klang am nächsten kommen: Gemini Erinome und Iapetus, OpenAI marin und cedar sowie ElevenLabs Sarah.
- Mit einer Galerie-Stimme stellt James Anbieter und Stimme ein. Bei ElevenLabs wird mehr Gleichmäßigkeit und weniger Stil gewählt. Bei Piper werden Klangrauschen und Lautlängen reduziert. Gemini Live und OpenAI Realtime erhalten zusätzlich eine kurze, feste Sprechweise im Systemtext: klar, ruhig, gleichmäßig und ohne Schauspiel.
- Für Hörproben verwendet Gemini dessen TTS-Endpunkt mit derselben Stimme. OpenAI verwendet `audio/speech` und ElevenLabs die bisherige Hörprobe. Fehlt ein Schlüssel, ist „Anhören“ gesperrt und die Karte nennt den fehlenden Schlüssel. Lokale Stimmen werden nach der Auswahl geladen.

## Geprüft

- Typecheck, 2.271 Tests (neu: `tests/icloud-direct.test.ts`, `tests/voice-gallery.test.ts`) und Produktionsbuild erfolgreich.
- Neue UI-Prüfung `node scripts/check-voice-icloud-ui.cjs` im echten Electron-Fenster mit isoliertem Profil: Galerie, Siri-Abzeichen, gesperrte Hörprobe ohne Schlüssel und gespeicherte Auswahl. Außerdem iCloud-Karte mit allen Diensten und Ablehnung eines normalen Passworts ohne technisches Fehlerpräfix. `check-redesign-ui.cjs` und `check-integrated-browser.cjs` weiterhin bestanden.
- Installer `dist/James-Jarvis Setup 1.3.24.exe` gebaut. `check-package.cjs` meldet PASS, und `imapflow`, `mailparser` und `nodemailer` liegen im `app.asar`. Er ist still installiert (Exit 0). Die installierte `James-Jarvis.exe` meldet 1.3.24, der `app.asar`-Hash ist identisch mit dem geprüften Paket, und die App läuft mit Hauptfenster. Ein GitHub-Release gibt es nicht.
- Apple-Server erreichbar: IMAP-Begrüßung von `imap.mail.me.com` empfangen; CalDAV antwortet ohne Anmeldung mit 401.

## Nicht geprüft

- Echte Anmeldung mit app-spezifischem Passwort, echte Mails, echter Versand und echte iCloud-Kalender. Diese Sitzung hatte keine Zugangsdaten.
- Hörproben mit echten Schlüsseln. Der Modellname des Gemini-TTS-Endpunkts (`gemini-2.5-flash-preview-tts`, Ausweichmodell Pro) wurde nicht gegen das Konto geprüft.
- Die ElevenLabs-Standardstimmen werden über ihren Namen im Konto gefunden. Danach dient eine bekannte Kennung als Rückfall.
- iCloud Drive mit installiertem „iCloud für Windows“. Auf diesem Rechner ist der Ordner nicht vorhanden.
