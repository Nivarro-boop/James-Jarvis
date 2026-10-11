import { costSince, recordCost } from '../db'
import { getSettings } from '../store/settings'

/**
 * Tageslimit für die Dinge, die wirklich Geld kosten.
 *
 * Gemeint ist nicht die Sprachverbindung — die rechnet pro Sekunde ab und
 * lässt sich lokal nicht beziffern. Gemeint sind die Posten mit einem
 * bekannten Preisschild, und das ist derzeit die tiefe Recherche: ein Lauf
 * kostet je nach Tiefe zwei bis sieben Dollar, und ein Sprachmodell, das
 * "schau mal nach" großzügig auslegt, kann davon an einem Nachmittag mehrere
 * starten.
 *
 * Die Grenze steht in den Einstellungen und ist standardmäßig aus. Sie wird
 * *vor* der Ausgabe geprüft, nicht danach — hinterher davon zu erfahren wäre
 * keine Bremse, sondern eine Quittung.
 */

export interface BudgetVerdict {
  ok: boolean
  /** Was heute schon zusammengekommen ist. */
  spentUsd: number
  limitUsd: number
  /** Fertiger Satz für das Modell, wenn die Grenze erreicht ist. */
  reason?: string
}

function startOfToday(): number {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return start.getTime()
}

export function spentToday(): number {
  return costSince(startOfToday())
}

/**
 * Prüft, ob eine Ausgabe in dieser Höhe heute noch hineinpasst.
 *
 * Der erwartete Betrag geht mit ein, statt nur den bisherigen Stand zu
 * vergleichen: Bei einem Limit von fünf Dollar und vier bereits ausgegebenen
 * wäre eine weitere Recherche für drei sonst erlaubt und die Grenze am Ende
 * um mehr als die Hälfte überschritten.
 */
export function checkBudget(expectedUsd: number): BudgetVerdict {
  if (!Number.isFinite(expectedUsd) || expectedUsd < 0) throw new Error('Ungültige Kostenschätzung.')
  const limitUsd = getSettings().dailyCostLimitUsd
  const spentUsd = spentToday()

  if (!limitUsd || limitUsd <= 0) return { ok: true, spentUsd, limitUsd: 0 }

  if (spentUsd + expectedUsd <= limitUsd) return { ok: true, spentUsd, limitUsd }

  const money = (value: number): string => value.toFixed(2).replace('.', ',')
  return {
    ok: false,
    spentUsd,
    limitUsd,
    // "Wäre überschritten", nicht "ist erreicht": Geprüft wird vor der Ausgabe,
    // und bei einem Limit von fünf Dollar kann der Stand bei fünfzig Cent
    // stehen und der Lauf trotzdem nicht hineinpassen. "Erreicht" wäre an
    // dieser Stelle schlicht falsch — und es ist ein Satz, den James laut
    // sagt.
    reason:
      `Das Tageslimit von ${money(limitUsd)} Dollar wäre damit überschritten — heute sind schon ` +
      `${money(spentUsd)} Dollar zusammengekommen, und das hier käme mit rund ` +
      `${money(expectedUsd)} Dollar dazu. Sag dem Nutzer das in einem Satz. Er kann die Grenze ` +
      'in den Einstellungen unter Über anheben oder abschalten.'
  }
}

/** Synchronous admission and durable estimate: concurrent background starts
 * see this reservation immediately, including after restarting James.
 * Kept after cancellation because an accepted cloud job may already be billed. */
export function reserveBudget(expectedUsd: number, kind: string, detail: string): void {
  const verdict = checkBudget(expectedUsd)
  if (!verdict.ok) throw new Error(verdict.reason)
  recordCost(kind, expectedUsd, detail)
}
