import { app } from 'electron'
import { join } from 'node:path'
import { resolveRecoveryProfile } from './store/recoveryProfile'

/**
 * Der Datenordner bleibt, wo er war.
 *
 * Electron leitet ihn aus dem Programmnamen ab. Seit der Umbenennung in
 * „Void James" hieße er im Installer anders, und jeder bestehende Nutzer
 * stünde ohne Schlüssel, Gedächtnis und Einstellungen da. Deshalb fest auf die
 * alten Namen: `Void Jarvis` für die installierte Fassung, `void-jarvis` für
 * `npm run dev`. Muss vor jedem anderen Modul laufen, das den Pfad liest —
 * deshalb der erste Import in `index.ts`.
 */
const recoveryProfile = resolveRecoveryProfile(app.getPath('appData'), process.argv)
export const recoveryMode = recoveryProfile !== null
app.setPath('userData', recoveryProfile?.directory ?? join(app.getPath('appData'), app.isPackaged ? 'Void Jarvis' : 'void-jarvis'))
