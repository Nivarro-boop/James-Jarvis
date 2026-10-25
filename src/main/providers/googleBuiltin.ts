/**
 * Der eingebaute Google-Zugang.
 *
 * Bisher musste jeder Nutzer in der Google Cloud Console einen eigenen
 * OAuth-Client anlegen und Client-ID samt Geheimnis abtippen, bevor der Knopf
 * „Mit Google anmelden" überhaupt etwas tat. Das schafft kaum jemand. Jetzt
 * legt der Herausgeber einmal einen Desktop-Client an, und der Build bringt ihn
 * mit: Der Nutzer drückt den Knopf, meldet sich im eigenen Browser an, fertig.
 *
 * Google behandelt das Geheimnis eines Desktop-Clients ausdrücklich nicht als
 * vertraulich — es steckt zwangsläufig in jeder ausgelieferten App. Die
 * Sicherheit der Anmeldung tragen PKCE und `state` in googleAuth.ts. Trotzdem
 * steht der Wert nicht im öffentlichen Repo: Er kommt beim Bauen aus
 * `JARVIS_GOOGLE_CLIENT_ID` / `JARVIS_GOOGLE_CLIENT_SECRET` (GitHub-Secret
 * oder lokale, nicht eingecheckte `.env.google`), siehe electron.vite.config.ts.
 *
 * Ein selbst eingetragener Client in den Einstellungen hat weiterhin Vorrang.
 */

declare const __JARVIS_GOOGLE_CLIENT_ID__: string | undefined
declare const __JARVIS_GOOGLE_CLIENT_SECRET__: string | undefined

export interface GoogleClientPair {
  id: string
  secret: string
}

function baked(name: 'id' | 'secret'): string {
  // `typeof` statt direktem Zugriff: In den Tests ersetzt esbuild die
  // Konstanten nicht, und ein nackter Zugriff wäre dort ein ReferenceError.
  if (name === 'id') return typeof __JARVIS_GOOGLE_CLIENT_ID__ === 'string' ? __JARVIS_GOOGLE_CLIENT_ID__ : ''
  return typeof __JARVIS_GOOGLE_CLIENT_SECRET__ === 'string' ? __JARVIS_GOOGLE_CLIENT_SECRET__ : ''
}

/** Der mitgelieferte Client, oder `null`, wenn dieser Build keinen hat. */
export function builtinGoogleClient(): GoogleClientPair | null {
  const id = (process.env.JARVIS_GOOGLE_CLIENT_ID?.trim() || baked('id')).trim()
  const secret = (process.env.JARVIS_GOOGLE_CLIENT_SECRET?.trim() || baked('secret')).trim()
  // Nur echte Google-Client-IDs. Ein Tippfehler im Build soll nicht als
  // „eingerichtet" gelten und dann erst bei Google scheitern.
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id) || !secret) return null
  return { id, secret }
}
