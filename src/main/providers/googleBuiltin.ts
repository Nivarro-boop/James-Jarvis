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
 * steht der Wert weder im öffentlichen Repo noch lesbar im Installer: Er kommt
 * beim Bauen aus `JARVIS_GOOGLE_CLIENT_ID` / `JARVIS_GOOGLE_CLIENT_SECRET`
 * (GitHub-Secret oder lokale, nicht eingecheckte `.env.google`, angelegt mit
 * `npm run google:setup`) und wird verschleiert eingebettet, siehe
 * googleSeal.ts und electron.vite.config.ts. In die Oberfläche, ins Protokoll
 * oder an das Sprachmodell gelangt er nie.
 *
 * Ein selbst eingetragener Client in den Einstellungen hat weiterhin Vorrang.
 */

import { openGoogleClient } from './googleSeal'

declare const __JARVIS_GOOGLE_CLIENT__: string | undefined

export interface GoogleClientPair {
  id: string
  secret: string
}

function baked(): GoogleClientPair | null {
  // `typeof` statt direktem Zugriff: In den Tests ersetzt esbuild die
  // Konstante nicht, und ein nackter Zugriff wäre dort ein ReferenceError.
  return openGoogleClient(typeof __JARVIS_GOOGLE_CLIENT__ === 'string' ? __JARVIS_GOOGLE_CLIENT__ : '')
}

/** Der mitgelieferte Client, oder `null`, wenn dieser Build keinen hat. */
export function builtinGoogleClient(): GoogleClientPair | null {
  const fromBuild = baked()
  const id = (process.env.JARVIS_GOOGLE_CLIENT_ID?.trim() || fromBuild?.id || '').trim()
  const secret = (process.env.JARVIS_GOOGLE_CLIENT_SECRET?.trim() || fromBuild?.secret || '').trim()
  return isGoogleClient(id, secret) ? { id, secret } : null
}

/**
 * Nur echte Google-Client-IDs. Ein Tippfehler im Build soll nicht als
 * „eingerichtet" gelten und dann erst bei Google scheitern.
 */
export function isGoogleClient(id: string, secret: string): boolean {
  return /^[\w-]+\.apps\.googleusercontent\.com$/.test(id) && Boolean(secret)
}
