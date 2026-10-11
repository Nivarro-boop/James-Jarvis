import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { listWindows } from '../../automation/desktop'

/**
 * Was gerade läuft — für Spiel- und Streamfragen.
 *
 * Wie es dem Rechner geht (Last, Speicher, Platten), sagt `system_status` in
 * `pc.ts`. Hier steht nur, was dort fehlt: welche der üblichen Spiel- und
 * Creator-Programme offen sind.
 */

/**
 * Woran ein Programm zu erkennen ist.
 *
 * Verglichen wird mit Wortgrenzen: Ein bloßes `includes('obs')` schlug schon
 * bei jedem Fenstertitel mit „Jobs" oder „Probs" an.
 */
const PROGRAMS: Record<string, RegExp> = {
  fortnite: /\bfortnite/i,
  minecraft: /\bminecraft/i,
  obs: /\bobs(32|64)?\b|\bobs studio\b/i,
  twitch: /\btwitch\b/i,
  discord: /\bdiscord\b/i,
  // Nicht bloß „resolve": Das steht auch in „Resolve conflicts" und Ähnlichem.
  davinci: /\bdavinci\b|^resolve(\.exe)?$/i,
  chrome: /\bchrome\b/i,
  spotify: /\bspotify\b/i
}

const gamingStatus = defineTool({
  name: 'gaming_status',
  group: 'system',
  description:
    'Sagt, welche der üblichen Spiel- und Creator-Programme gerade offen sind: Fortnite, ' +
    'Minecraft, OBS, Twitch, Discord, DaVinci Resolve, Chrome, Spotify. Für "läuft OBS schon" ' +
    'oder "was hab ich gerade offen".',
  schema: z.object({}),
  async execute() {
    const windows = await listWindows()
    const offen: Record<string, boolean> = {}
    for (const [program, pattern] of Object.entries(PROGRAMS)) {
      offen[program] = windows.some((w) => pattern.test(w.name) || pattern.test(w.title))
    }
    return {
      offen,
      fensterAnzahl: windows.length,
      hinweis: 'Nenne nur, wonach gefragt wurde.'
    }
  }
}) as ToolDefinition

export const monitorTools: ToolDefinition[] = [gamingStatus]
