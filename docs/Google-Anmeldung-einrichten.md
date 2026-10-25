# Eingebauter Google-Zugang („Mit Google anmelden“)

Damit Nutzer nur noch auf **Mit Google anmelden** drücken, bringt der Build einen
OAuth-Client mit. Den legt der Herausgeber **einmal** an. Ohne ihn baut die App
wie bisher; dann steht der eigene Client unter Einstellungen → Konten → „Für
Fortgeschrittene“.

## Einmalig in der Google Cloud Console

1. Projekt anlegen (z. B. „James-Jarvis“).
2. APIs aktivieren: Gmail, Google Calendar, Google Drive, Google Docs,
   Google Sheets, Google Tasks, People API.
3. „OAuth-Zustimmungsbildschirm“: Typ **Extern**, App-Name „James-Jarvis“,
   Support-E-Mail, Datenschutzerklärung und Startseite eintragen. Bereiche
   (Scopes) wie in `src/main/providers/googleAuth.ts` (`SCOPES`).
4. „Anmeldedaten“ → „OAuth-Client-ID“ → Anwendungstyp **Desktop-App**.
   Client-ID (`….apps.googleusercontent.com`) und Clientschlüssel notieren.

## In den Build bringen

Am einfachsten mit dem Einrichtungsskript, einmal im Projektordner:

```
npm run google:setup -- "C:\Pfad\zu\client_secret_….json"
```

Die JSON-Datei bietet die Cloud Console beim Anlegen des Desktop-Clients zum
Herunterladen an. Ohne Datei (`npm run google:setup`) fragt das Skript nach
Client-ID und Clientschlüssel; die Eingabe bleibt unsichtbar.

Das Skript

- schreibt `.env.google` (über `.env.*` in .gitignore ausgeschlossen, kommt
  nicht in den Installer),
- setzt auf Nachfrage die GitHub-Secrets `JARVIS_GOOGLE_CLIENT_ID` und
  `JARVIS_GOOGLE_CLIENT_SECRET` in `Nivarro-boop/James-Jarvis`, damit auch die
  Release-Action den Zugang mitbaut,
- gibt keinen der Werte aus.

Danach `npm run dist`. Kein Nutzer muss mehr etwas eintragen; die Felder für
einen eigenen Client verschwinden aus den Einstellungen.

## Wer den Wert sehen kann

- **Nicht im Repo:** weder im Quelltext noch in der Historie.
- **Nicht in der Oberfläche, im Protokoll oder beim Sprachmodell:** Der Wert
  verlässt den Hauptprozess nur in Richtung Google.
- **Im Installer nur verschleiert** (`src/main/providers/googleSeal.ts`): pro
  Build zufällig verwürfelt, ein Durchsuchen nach `googleusercontent.com`
  findet nichts. `scripts/check-package.cjs` prüft das nach `npm run dist`.
- **Grenze:** Eine Desktop-App muss den Client zum Anmelden selbst kennen. Wer
  das Programm gezielt zerlegt, kann ihn herausholen — das gilt für jede
  Desktop-App, auch für die großer Anbieter. Google rechnet damit und
  behandelt den Schlüssel eines Desktop-Clients nicht als geheim; die
  Anmeldung ist über PKCE und `state` abgesichert. Mehr als der Client-Name
  „James-Jarvis“ lässt sich damit nicht missbrauchen: Ohne Anmeldung und
  Zustimmung des jeweiligen Nutzers kommt niemand an dessen Daten.

## Grenzen, die nur Google aufheben kann

- Solange die App **nicht verifiziert** ist, zeigt Google beim Anmelden
  „Google hat diese App nicht überprüft“, und höchstens 100 eingetragene
  Testnutzer können sich anmelden.
- Gmail (`gmail.modify`, `gmail.compose`, `gmail.readonly`) und voller
  Drive-Zugriff (`drive`) sind **eingeschränkte Bereiche**. Für den Verkauf
  braucht es Googles Verifizierung plus jährliche Sicherheitsprüfung (CASA).
  Wer das vermeiden will, reduziert auf `drive.file` und lässt Mails über den
  Browserweg laufen.
