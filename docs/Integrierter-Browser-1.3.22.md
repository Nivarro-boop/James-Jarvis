# Integrierter Browser – Version 1.3.22

James hat einen sichtbaren Browser direkt rechts neben dem Gespräch. Der Knopf **Browser** steht auf der Startseite; zusätzlich führt **Menü → Browser & iCloud** dorthin. Beim Öffnen erscheint links auch das Schreibfeld. Kleine Fenster zeigen den Browser über die ganze Breite; **×** rechts oben bringt das Gespräch zurück.

## Fertig implementiert

- Tabs mit Titeln, Schließen, neuem Tab, Adressfeld, Zurück/Vor, Laden stoppen und erneut laden.
- Direkte Einstiege für iCloud Mail, Kalender, Drive und Fotos. Einstellungen → Verbindungen → **Mit Apple Account anmelden** öffnet iCloud im Hauptfenster.
- Eigene persistente Electron-Sitzung für Webseiten; Anmeldecookies überleben einen App-Neustart. Diese Sitzung wird von allen Browser-Tabs geteilt. Sie ist unabhängig vom bisherigen separaten Chrome-Profil.
- Anmelde-Pop-ups öffnen als Tabs; Chromium behält die Verbindung zum Ausgangsfenster. Passwörter und Apple-Gerätefreigaben gibt der Nutzer auf der Webseite ein.
- `browser_open` und `browser_read` sind für James registriert. `icloud_open` und `icloud_read` verwenden dieselben eingebetteten Tabs. Das Lesen erfasst Seitentext, keine Eingabefelder; es ist zeitlich und mengenmäßig begrenzt.
- Externe Webseiten haben keine James-IPC-Brücke, kein Node.js und keinen Preload. Sie laufen in einer Sandbox. Datei- und Systemprotokolle sind gesperrt. Nur die beiden eigenen App-Oberflächen dürfen die privilegierten IPC-Handler ansprechen.
- Browserflächen werden beim Ausblenden und vor App-Dialogen versteckt. Geschlossene Tabs werden freigegeben. Fehlerhafte Seiten melden einen Ladefehler, statt eine erfolgreiche Verbindung zu behaupten.

## Tatsächlich geprüft

- Desktop-Typecheck und Produktionsbuild erfolgreich.
- 2.166 Tests bestanden, keine fehlgeschlagen.
- Electron-Integrationstest mit lokalen Testseiten: native Einbettung, Gesprächseingabe, Tabwechsel, Navigation, Pop-up mit `window.opener`, Sandbox/fehlender Node-Zugriff, Dialogschutz, Ausblenden/Wiederöffnen, kleine Fenster und Protokollgrenzen.
- Persistenztest: Testcookie gespeichert, App vollständig beendet, neu gestartet und Cookie wieder vorhanden.
- Öffentliche iCloud-Seite im echten eingebetteten Browser geladen: Titel „iCloud“, Adresse `https://www.icloud.com/`, sichtbarer Einstieg „Anmelden“. Keine Zugangsdaten eingegeben.
- Prüfbefehl: `node scripts/check-integrated-browser.cjs --apple`. Bilder und Ergebnisse stehen lokal unter `out/audit/browser/`; sie werden nicht ausgeliefert.

## Verbleibende Grenzen

Die echte Apple-Kontoanmeldung einschließlich 2FA und Zugriff auf private Mail-, Kalender-, Drive- und Fotodaten muss noch mit dem Nutzer erfolgen. Eine geöffnete iCloud-Seite ist keine bestätigte Kontoanmeldung. Die Integration ist ein eingebetteter Webzugang mit Textlesen, keine vollständige Hintergrundsynchronisierung und kein direkter IMAP-/SMTP-Client. Fotos können im Browser angesehen werden; das Textwerkzeug analysiert ihre Bildinhalte nicht.

Apple Health benötigt weiterhin die native iPhone-App samt HealthKit-Freigabe und Kopplung. HealthKit-Code ist vorhanden; ein signierter iPhone-Build und echte Gerätetests bleiben offen. Über die PWA und iCloud.com ist Health nicht verfügbar.

Die bestehenden automatisierten Gmail-/Yahoo-/Amazon-Werkzeuge arbeiten weiterhin mit ihrem separaten Chrome-Profil. Sie sind nicht automatisch mit der neuen eingebetteten Sitzung verbunden. Datei-Downloads und zusätzliche Website-Geräteberechtigungen sind im eingebetteten Browser noch nicht implementiert.

Die Version wird lokal gebaut; es wurde kein GitHub-Release veröffentlicht.

## Lokaler Installationsstand

Der Windows-Installer `dist/James-Jarvis Setup 1.3.22.exe` wurde erfolgreich ausgeführt (Exit 0).
Die installierte Anwendung meldet Dateiversion 1.3.22; ihr `app.asar` hat denselben SHA-256-Hash wie das geprüfte Paket.
Der Paketcheck bestätigt Main, Renderer, Sprachmodelle und Windows-Helfer ohne mitgelieferte Auditlogs.
Anschließend wurde die installierte Anwendung gestartet und der Browser über die sichtbare Oberfläche geöffnet.
iCloud Mail steht rechts im James-Fenster unter `https://www.icloud.com/mail/` mit sichtbarem „Anmelden“-Knopf bereit.
Die persönliche Apple-Anmeldung wurde noch nicht durchgeführt.

Quellen: [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [Electron-Pop-ups](https://www.electronjs.org/docs/latest/api/web-contents), [Apple: iCloud-Webzugriff und Health](https://support.apple.com/en-gb/102630).
