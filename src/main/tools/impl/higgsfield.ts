import { shell } from 'electron'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { getSecret } from '../../secrets/keystore'
import { speak } from '../../ipc/emit'
import { isSafeExternalUrl } from '../../windows/external'

/**
 * Higgsfield — Bild- und Videoerzeugung.
 *
 * Die Erzeugung dauert je nach Modell zwischen einer und mehreren Minuten.
 * Genau wie bei der tiefen Recherche wird deshalb nicht blockiert: das
 * Werkzeug kehrt sofort zurück, ein Wächter fragt im Hintergrund den Status
 * ab, und James meldet sich, wenn das Ergebnis da ist.
 *
 * Der Zugang besteht aus zwei Teilen, die die API als `key:secret` erwartet.
 * Beides wird in einem Feld hinterlegt, damit die Einstellungen nicht
 * unnötig aufgebläht werden.
 */

const BASE = 'https://platform.higgsfield.ai'

/** Modelle mit dem, was sie tatsächlich gut können. */
const MODELS = {
  bild: 'higgsfield-ai/soul/standard',
  bild_hq: 'higgsfield-ai/soul/pro',
  video: 'higgsfield-ai/dop/standard',
  video_hq: 'higgsfield-ai/dop/turbo'
} as const

function authHeader(): string {
  const raw = getSecret('higgsfield')
  if (!raw) throw new Error('Für Higgsfield ist kein Zugang hinterlegt.')
  if (!raw.includes(':')) {
    throw new Error(
      'Der Higgsfield-Zugang ist unvollständig. Es werden Schlüssel und Geheimnis erwartet, ' +
        'getrennt durch einen Doppelpunkt.'
    )
  }
  return `Key ${raw}`
}

interface SubmitResponse {
  status: string
  request_id: string
  status_url?: string
}

interface StatusResponse {
  status: 'queued' | 'in_progress' | 'completed' | 'nsfw' | 'failed'
  request_id: string
  images?: { url: string }[]
  video?: { url: string }
  error?: string
}

async function submit(model: string, body: Record<string, unknown>): Promise<SubmitResponse> {
  const res = await fetch(`${BASE}/${model}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (res.status === 401 || res.status === 403) {
    throw new Error('Higgsfield akzeptiert den Zugang nicht. Prüf Schlüssel und Geheimnis.')
  }
  if (res.status === 402) {
    throw new Error('Das Higgsfield-Guthaben ist aufgebraucht.')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Higgsfield antwortet mit Fehler ${res.status}. ${text.slice(0, 160)}`)
  }

  return (await res.json()) as SubmitResponse
}

async function fetchStatus(requestId: string): Promise<StatusResponse> {
  const res = await fetch(`${BASE}/requests/${requestId}/status`, {
    headers: { Authorization: authHeader(), Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`Statusabfrage fehlgeschlagen (${res.status}).`)
  return (await res.json()) as StatusResponse
}

const pending = new Map<string, { kind: 'Bild' | 'Video'; prompt: string }>()

/**
 * Fragt den Status ab, bis etwas Endgültiges herauskommt.
 *
 * Das Intervall wächst schrittweise: am Anfang häufiger, weil kurze Aufträge
 * schnell fertig sind, später seltener, um die API nicht unnötig zu belasten.
 */
function watchJob(requestId: string, kind: 'Bild' | 'Video', prompt: string): void {
  pending.set(requestId, { kind, prompt })

  let attempt = 0
  const maxAttempts = 90 // deckt gut zwanzig Minuten ab

  const poll = async (): Promise<void> => {
    attempt++
    if (attempt > maxAttempts) {
      pending.delete(requestId)
      speak(`Sag dem Nutzer, dass das ${kind} zu lange braucht und du es aufgibst.`)
      return
    }

    try {
      const status = await fetchStatus(requestId)

      if (status.status === 'completed') {
        pending.delete(requestId)
        const url = status.video?.url ?? status.images?.[0]?.url
        if (url) {
          speak(
            `Sag dem Nutzer, dass sein ${kind} fertig ist. Es ging um: ${prompt.slice(0, 80)}. ` +
              `Frag, ob du es aufmachen sollst. Die Adresse ist ${url}`
          )
        }
        return
      }

      if (status.status === 'nsfw') {
        pending.delete(requestId)
        speak(`Sag dem Nutzer, dass das ${kind} von den Inhaltsfiltern abgelehnt wurde.`)
        return
      }

      if (status.status === 'failed') {
        pending.delete(requestId)
        speak(`Sag dem Nutzer, dass das ${kind} fehlgeschlagen ist.`)
        return
      }
    } catch (err) {
      // Einzelne fehlgeschlagene Abfragen sind normal — weiterversuchen.
      console.debug('[higgsfield] Statusabfrage fehlgeschlagen:', err)
    }

    const delay = attempt < 10 ? 5000 : attempt < 30 ? 12_000 : 25_000
    setTimeout(() => void poll(), delay)
  }

  setTimeout(() => void poll(), 4000)
}

const generateImage = defineTool({
  name: 'higgsfield_image',
  group: 'media',
  description:
    'Erzeugt ein Bild aus einer Beschreibung. Dauert etwa eine Minute und läuft im Hintergrund — ' +
    'du kannst normal weiterreden und meldest dich, wenn es fertig ist.',
  schema: z.object({
    prompt: z.string().describe('Beschreibung des Bildes, gern ausführlich und auf Englisch.'),
    aspectRatio: z
      .enum(['1:1', '16:9', '9:16', '4:3', '3:4'])
      .optional()
      .describe('Seitenverhältnis, Standard sechzehn zu neun.'),
    quality: z.enum(['standard', 'hoch']).optional().describe('Standard ist schneller und günstiger.')
  }),
  requiresSecret: 'higgsfield',
  spokenHint: 'Okay.',
  async execute({ prompt, aspectRatio, quality }) {
    const model = quality === 'hoch' ? MODELS.bild_hq : MODELS.bild
    const response = await submit(model, {
      prompt,
      aspect_ratio: aspectRatio ?? '16:9',
      resolution: '1080p'
    })

    watchJob(response.request_id, 'Bild', prompt)

    return {
      gestartet: true,
      id: response.request_id,
      hinweis:
        'Sag kurz, dass du dran bist und dich meldest, sobald es fertig ist. Frag nicht nach.'
    }
  }
}) as ToolDefinition

const generateVideo = defineTool({
  name: 'higgsfield_video',
  group: 'media',
  description:
    'Erzeugt ein Video aus einer Beschreibung oder aus einem Startbild. ' +
    'Dauert mehrere Minuten und läuft im Hintergrund.',
  schema: z.object({
    prompt: z.string().describe('Beschreibung der Szene und der Bewegung, gern auf Englisch.'),
    imageUrl: z
      .string()
      .optional()
      .describe('Adresse eines Startbildes, wenn daraus ein Video werden soll.'),
    aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(),
    quality: z.enum(['standard', 'hoch']).optional()
  }),
  requiresSecret: 'higgsfield',
  spokenHint: 'Mhm.',
  async execute({ prompt, imageUrl, aspectRatio, quality }) {
    const model = quality === 'hoch' ? MODELS.video_hq : MODELS.video
    const body: Record<string, unknown> = {
      prompt,
      aspect_ratio: aspectRatio ?? '16:9',
      resolution: '720p'
    }
    if (imageUrl) body.image_url = imageUrl

    const response = await submit(model, body)
    watchJob(response.request_id, 'Video', prompt)

    return {
      gestartet: true,
      id: response.request_id,
      hinweis:
        'Videos brauchen mehrere Minuten. Sag das dem Nutzer und rede normal weiter.'
    }
  }
}) as ToolDefinition

const jobStatus = defineTool({
  name: 'higgsfield_status',
  group: 'media',
  description: 'Sagt, wie weit eine laufende Bild- oder Videoerzeugung ist.',
  schema: z.object({
    id: z.string().optional().describe('Kennung des Auftrags. Ohne Angabe alle laufenden.')
  }),
  requiresSecret: 'higgsfield',
  async execute({ id }) {
    if (!id) {
      if (pending.size === 0) return { laufend: 0, note: 'Es läuft gerade nichts.' }
      return {
        laufend: pending.size,
        aufträge: [...pending.entries()].map(([key, value]) => ({
          id: key,
          art: value.kind,
          beschreibung: value.prompt.slice(0, 60)
        }))
      }
    }

    const status = await fetchStatus(id)
    const url = status.video?.url ?? status.images?.[0]?.url

    return {
      status:
        status.status === 'completed'
          ? 'fertig'
          : status.status === 'queued'
            ? 'in der Warteschlange'
            : status.status === 'in_progress'
              ? 'läuft'
              : 'fehlgeschlagen',
      url
    }
  }
}) as ToolDefinition

const openResult = defineTool({
  name: 'higgsfield_open',
  group: 'media',
  description: 'Öffnet ein fertiges Bild oder Video im Browser.',
  schema: z.object({
    url: z.string().describe('Die Adresse aus der Fertigmeldung.')
  }),
  requiresSecret: 'higgsfield',
  async execute({ url }) {
    // Die Adresse kommt vom Modell. Ohne diese Prüfung öffnete ein
    // untergeschobenes `file:` oder `ms-msdt:` beliebige Programme.
    if (!isSafeExternalUrl(url)) throw new Error('Das ist keine Webadresse.')
    await shell.openExternal(url)
    return { geöffnet: true }
  }
}) as ToolDefinition

export const higgsfieldTools: ToolDefinition[] = [
  generateImage,
  generateVideo,
  jobStatus,
  openResult
]
