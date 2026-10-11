import { open, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { focusWindow, launch, listWindows, resolveApp } from '../../automation/desktop'
import { showLaunch } from './system'

/**
 * Minecraft.
 *
 * Den Launcher zu starten ist deterministisch und schnell. Was danach kommt —
 * Profil auswählen, auf Spielen klicken — ist Oberflächenarbeit und gehört in
 * den Vision-Loop; das wird hier nur angestoßen, nicht nachgebaut.
 */

const CLIENTS = {
  norisk: 'NoRisk Client',
  modrinth: 'Modrinth App',
  enderclient: 'EnderClient',
  fastclient: 'FastClient',
  minecraft: 'Minecraft'
} as const

const launchClient = defineTool({
  name: 'minecraft_launch',
  group: 'minecraft',
  description:
    'Startet einen Minecraft-Launcher. Ohne Angabe NoRisk. ' +
    'Startet nur den Launcher — auf Spielen klicken musst du danach mit computer_task, ' +
    'falls der Nutzer das will.',
  schema: z.object({
    client: z
      .enum(['norisk', 'modrinth', 'enderclient', 'fastclient', 'minecraft'])
      .optional()
      .describe('Welcher Launcher. Standard ist norisk.')
  }),
  async execute({ client }, ctx) {
    const key = client ?? 'norisk'
    const label = CLIENTS[key]
    const resolved = await resolveApp(key)
    if (resolved) showLaunch(ctx, resolved, `Öffne ${label} …`)

    const windows = await listWindows()
    const running = windows.find((w) => w.title.toLowerCase().includes(key.replace('client', '')))
    if (running) {
      ctx.annotate({ thought: `${label} läuft schon, hole es nach vorn …` })
      await focusWindow(running.title.slice(0, 20))
      return { schonOffen: true, launcher: label }
    }

    if (!resolved) {
      throw new Error(`Ich finde ${label} nicht auf diesem Rechner.`)
    }

    await launch(resolved)
    return {
      gestartet: label,
      hinweis:
        'Der Launcher braucht ein paar Sekunden. Sag das dem Nutzer und frag, ob du auf Spielen ' +
        'klicken sollst.'
    }
  }
}) as ToolDefinition

/** Standardpfad des Vanilla-Profils; NoRisk und Modrinth nutzen eigene Ordner. */
function minecraftDir(): string {
  return join(process.env.APPDATA ?? '', '.minecraft')
}

/**
 * Nur das Ende der Datei lesen.
 *
 * `latest.log` wächst über eine lange Spielsitzung auf zweistellige
 * Megabytebeträge — und gefragt sind immer die letzten Zeilen. Die ganze Datei
 * dafür in den Speicher zu ziehen und dann 99 Prozent davon wegzuwerfen, hängt
 * bei "wer ist online?" den Hauptprozess für eine spürbare Weile auf.
 *
 * Ein Megabyte deckt auch bei gesetztem Filter genug Verlauf ab. Gelesen wird
 * ab einer Byte-Grenze, die mitten in ein Zeichen fallen kann — deshalb fällt
 * die erste, womöglich angeschnittene Zeile weg.
 */
const TAIL_BYTES = 1024 * 1024

export async function readLogTail(path: string): Promise<string[]> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))
    await handle.read(buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf-8').split('\n')
    return start > 0 ? lines.slice(1) : lines
  } finally {
    await handle.close()
  }
}

const readLog = defineTool({
  name: 'minecraft_read_log',
  group: 'minecraft',
  description:
    'Liest das Ende des Minecraft-Protokolls. Damit lässt sich beantworten, wer online ist, ' +
    'was zuletzt im Chat stand, auf welchem Server du bist oder woran ein Absturz lag.',
  schema: z.object({
    lines: z.number().optional().describe('Wie viele Zeilen vom Ende, Standard achtzig.'),
    filter: z
      .string()
      .optional()
      .describe('Nur Zeilen, die diesen Text enthalten, etwa "joined" oder "Chat".')
  }),
  async execute({ lines, filter }) {
    const logPath = join(minecraftDir(), 'logs', 'latest.log')
    if (!existsSync(logPath)) {
      throw new Error('Ich finde kein Minecraft-Protokoll. Läuft das Spiel überhaupt?')
    }

    const info = await stat(logPath)
    const ageMinutes = Math.round((Date.now() - info.mtimeMs) / 60000)

    let all = await readLogTail(logPath)
    if (filter) {
      const needle = filter.toLowerCase()
      all = all.filter((l) => l.toLowerCase().includes(needle))
    }

    // `-Math.min(300, 0)` ist `-0`, und `slice(-0)` ist `slice(0)` — die Bitte
    // um null Zeilen lieferte also das ganze Protokoll. Dieselbe Zahl gilt am
    // Ende noch einmal: Das Wegwerfen der Zeitstempel lässt Leerzeilen übrig,
    // und die dürfen den Schnitt nicht auf eine feste Obergrenze drücken, sonst
    // bekommt der Nutzer nie, wonach er gefragt hat.
    const count = Math.min(300, Math.max(1, lines ?? 80))

    return {
      // Zeitstempel und Thread-Präfixe raus — vorgelesen sind sie wertlos.
      zeilen: all
        .slice(-count)
        .map((l) => l.replace(/^\[[\d:]+\]\s*\[[^\]]+\]:\s*/, '').trim())
        .filter(Boolean)
        .slice(-count),
      protokollAlter: ageMinutes < 2 ? 'aktuell' : `${ageMinutes} Minuten alt`,
      hinweis: 'Fass zusammen, was relevant ist. Lies keine Protokollzeilen wörtlich vor.'
    }
  }
}) as ToolDefinition

const listWorlds = defineTool({
  name: 'minecraft_list_worlds',
  group: 'minecraft',
  description: 'Zählt die lokalen Minecraft-Welten auf, mit letzter Änderung.',
  schema: z.object({}),
  async execute() {
    const savesDir = join(minecraftDir(), 'saves')
    if (!existsSync(savesDir)) return { anzahl: 0, note: 'Es gibt keine lokalen Welten.' }

    const entries = await readdir(savesDir, { withFileTypes: true })
    const worlds = entries.filter((e) => e.isDirectory())

    const withTime = await Promise.all(
      worlds.map(async (w) => {
        const info = await stat(join(savesDir, w.name)).catch(() => null)
        return {
          name: w.name,
          zuletzt: info ? new Date(info.mtimeMs).toLocaleDateString('de-DE') : 'unbekannt',
          ts: info?.mtimeMs ?? 0
        }
      })
    )

    withTime.sort((a, b) => b.ts - a.ts)
    return {
      anzahl: withTime.length,
      welten: withTime.slice(0, 15).map(({ name, zuletzt }) => ({ name, zuletzt }))
    }
  }
}) as ToolDefinition

export const minecraftTools: ToolDefinition[] = [launchClient, readLog, listWorlds]
