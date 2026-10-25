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

- **GitHub-Release:** im Repo unter Settings → Secrets → Actions zwei Secrets
  anlegen: `JARVIS_GOOGLE_CLIENT_ID` und `JARVIS_GOOGLE_CLIENT_SECRET`. Die
  Release-Action reicht sie an den Build weiter.
- **Lokal:** Datei `.env.google` im Projektordner (wird nicht eingecheckt):

  ```
  JARVIS_GOOGLE_CLIENT_ID=123-abc.apps.googleusercontent.com
  JARVIS_GOOGLE_CLIENT_SECRET=GOCSPX-…
  ```

  Danach `npm run dist`.

Google behandelt den Schlüssel eines Desktop-Clients nicht als geheim; die
Anmeldung ist über PKCE und `state` abgesichert. Er gehört trotzdem nicht ins
öffentliche Repo.

## Grenzen, die nur Google aufheben kann

- Solange die App **nicht verifiziert** ist, zeigt Google beim Anmelden
  „Google hat diese App nicht überprüft“, und höchstens 100 eingetragene
  Testnutzer können sich anmelden.
- Gmail (`gmail.modify`, `gmail.compose`, `gmail.readonly`) und voller
  Drive-Zugriff (`drive`) sind **eingeschränkte Bereiche**. Für den Verkauf
  braucht es Googles Verifizierung plus jährliche Sicherheitsprüfung (CASA).
  Wer das vermeiden will, reduziert auf `drive.file` und lässt Mails über den
  Browserweg laufen.
