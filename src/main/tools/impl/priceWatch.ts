import { Notification } from 'electron'
import { z } from 'zod'
import type { PriceWatch } from '@shared/types'
import { defineTool, type ToolDefinition } from '../registry'
import { deleteWatch, insertWatch, listWatches, recordWatchPrice } from '../../db'
import { detectBlock, withPage } from '../../automation/chromeCdp'
import { extractPrice } from '../../automation/priceParser'
import { speak } from '../../ipc/emit'

/**
 * Preiswächter.
 *
 * Die Prüfung läuft gebündelt alle dreißig Minuten über den Zeitplaner —
 * nicht pro Eintrag mit eigenem Intervall. Das hält die Zahl der Zugriffe pro
 * Shop niedrig, was der einzige wirksame Schutz davor ist, als Bot eingestuft
 * zu werden.
 */

export async function checkWatch(watch: PriceWatch): Promise<number | null> {
  return withPage(watch.url, async (page) => {
    const blocked = await detectBlock(page)
    if (blocked) {
      console.warn(`[preiswächter] ${watch.productName}: ${blocked}`)
      return null
    }

    const parsed = await extractPrice(page)
    if (!parsed) {
      console.warn(`[preiswächter] Kein Preis lesbar auf ${watch.url}`)
      return null
    }

    const hitTarget = parsed.price <= watch.targetPrice
    // Nur einmal melden, bis der Preis wieder über die Schwelle steigt —
    // sonst weckt der Wächter alle halbe Stunde mit derselben Nachricht.
    const shouldNotify = hitTarget && !watch.notified

    recordWatchPrice(watch.id, parsed.price, hitTarget)

    if (shouldNotify) {
      const message = `${watch.productName} kostet jetzt ${formatPrice(parsed.price)}. Dein Zielpreis war ${formatPrice(watch.targetPrice)}.`

      new Notification({
        title: 'Preisalarm',
        body: message,
        urgency: 'normal'
      }).show()

      speak(
        `Sag dem Nutzer Bescheid: ${message} Frag, ob du die Seite aufmachen sollst. ` +
          `Die Adresse ist ${watch.url}`
      )
    }

    return parsed.price
  })
}

function formatPrice(value: number): string {
  return `${value.toFixed(2).replace('.', ',')} Euro`
}

// ─────────────────────────────────────────────────────────────

const createWatch = defineTool({
  name: 'price_watch_create',
  group: 'shopping',
  description:
    'Beobachtet den Preis eines Produkts und meldet sich von selbst, sobald er unter den ' +
    'Zielpreis fällt. Geprüft wird alle halbe Stunde. Nutze das für "sag mir Bescheid wenn X ' +
    'billiger wird".',
  schema: z.object({
    url: z.string().describe('Die Produktseite, am besten aus einer vorherigen Preissuche.'),
    productName: z.string().describe('Wie das Produkt heißen soll, wenn du dich meldest.'),
    targetPrice: z.number().describe('Der Preis in Euro, ab dem gemeldet wird.')
  }),
  async execute({ url, productName, targetPrice }) {
    const id = insertWatch({ url, productName, targetPrice })

    // Sofort einmal prüfen: liegt der Preis schon darunter, soll James das
    // direkt sagen statt eine halbe Stunde zu warten.
    const watch = listWatches().find((w) => w.id === id)
    let current: number | null = null
    if (watch) {
      try {
        current = await checkWatch(watch)
      } catch {
        // Erste Prüfung darf fehlschlagen — der Wächter läuft trotzdem.
      }
    }

    return {
      eingerichtet: true,
      id,
      aktuellerPreis: current ? formatPrice(current) : 'noch nicht ermittelt',
      zielpreis: formatPrice(targetPrice)
    }
  }
}) as ToolDefinition

const listWatchesTool = defineTool({
  name: 'price_watch_list',
  group: 'shopping',
  description: 'Zählt auf, welche Produkte gerade beobachtet werden und was sie kosten.',
  schema: z.object({}),
  async execute() {
    const list = listWatches()
    if (list.length === 0) return { anzahl: 0, note: 'Ich beobachte gerade nichts.' }
    return {
      anzahl: list.length,
      beobachtet: list.map((w) => ({
        id: w.id,
        produkt: w.productName,
        zielpreis: formatPrice(w.targetPrice),
        aktuell: w.lastPrice ? formatPrice(w.lastPrice) : 'noch unbekannt',
        erreicht: w.notified
      }))
    }
  }
}) as ToolDefinition

const removeWatch = defineTool({
  name: 'price_watch_remove',
  group: 'shopping',
  description: 'Beendet die Beobachtung eines Produkts.',
  schema: z.object({
    id: z.number().describe('Die Kennung aus price_watch_list.')
  }),
  async execute({ id }) {
    const watch = listWatches().find((w) => w.id === id)
    if (!watch) throw new Error('Diese Beobachtung gibt es nicht.')
    deleteWatch(id)
    return { beendet: watch.productName }
  }
}) as ToolDefinition

export const priceWatchTools: ToolDefinition[] = [createWatch, listWatchesTool, removeWatch]
