import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { describeHealth } from '@shared/health'
import { latestHealth } from '../../health/store'

/**
 * Apple Health — nur lesen, nur was das iPhone geschickt hat.
 *
 * James stellt keine Diagnosen. Das Werkzeug liefert Zahlen und ihr Alter;
 * die Beschreibung sagt dem Modell, dass es bei Beschwerden auf einen Arzt
 * verweist, statt Werte zu deuten.
 */
const healthToday = defineTool({
  name: 'health_today',
  group: 'memory',
  description:
    'Liest die Apple-Health-Werte, die die James-App auf dem iPhone geschickt hat: Schritte, Strecke, ' +
    'aktive Kalorien, Training, Stockwerke, Schlaf, Ruhepuls, letzter Puls, Gewicht — heute und die ' +
    'sechs Tage davor. Für „wie viele Schritte heute", „wie hab ich geschlafen", „wie aktiv war ich diese ' +
    'Woche". Nur lesen. Keine Diagnosen; bei Beschwerden auf einen Arzt verweisen.',
  schema: z.object({}),
  readOnly: true,
  async execute() {
    const snapshot = latestHealth()
    if (!snapshot) {
      return {
        verfügbar: false,
        hinweis:
          'Noch keine Apple-Health-Daten. Sag dem Nutzer: In der James-App auf dem iPhone oben auf ' +
          '„Apple Health teilen" tippen und den Zugriff erlauben. Die Werte kommen dann bei jedem Öffnen der App.'
      }
    }
    return { verfügbar: true, zusammenfassung: describeHealth(snapshot) }
  }
})

export const healthTools: ToolDefinition[] = [healthToday as ToolDefinition]
