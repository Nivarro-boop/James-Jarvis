import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { z } from 'zod'
import { toJsonSchema, type JsonSchema } from '@main/tools/registry'
import type { ToolDefinition } from '@main/tools/registry'

import { calendarTools } from '@main/tools/impl/calendar'
import { chromeTools } from '@main/tools/impl/chrome'
import { computerTools } from '@main/tools/impl/computer'
import { contactTools } from '@main/tools/impl/contacts'
import { fileTools } from '@main/tools/impl/files'
import { gmailTools } from '@main/tools/impl/gmail'
import { gmailWebTools } from '@main/tools/impl/gmailWeb'
import { higgsfieldTools } from '@main/tools/impl/higgsfield'
import { introspectionTools } from '@main/tools/impl/tokens'
import { knowledgeTools } from '@main/tools/impl/knowledge'
import { memoryTools } from '@main/tools/impl/memory'
import { minecraftTools } from '@main/tools/impl/minecraft'
import { pcTools } from '@main/tools/impl/pc'
import { priceWatchTools } from '@main/tools/impl/priceWatch'
import { quietTools } from '@main/tools/impl/quiet'
import { researchTools } from '@main/tools/impl/research'
import { selfHealTools } from '@main/tools/impl/selfheal'
import { shellTools } from '@main/tools/impl/shell'
import { shoppingTools } from '@main/tools/impl/shopping'
import { stocksTools } from '@main/tools/impl/stocks'
import { systemTools } from '@main/tools/impl/system'
import { timerTools } from '@main/tools/impl/timers'
import { utilityTools } from '@main/tools/impl/utility'
import { placeTools } from '@main/tools/impl/places'
import { webTools } from '@main/tools/impl/web'
import { yahooTools } from '@main/tools/impl/yahoo'
import { windowTools } from '@main/tools/impl/window'
import { officeTools } from '@main/tools/impl/office'
import { cameraTools } from '@main/tools/impl/camera'
import { organizeTools } from '@main/tools/impl/organize'
import { whatsappTools } from '@main/tools/impl/whatsapp'
import { smartHomeTools } from '@main/tools/impl/smarthome'
import { musicTools } from '@main/tools/impl/music'
import { monitorTools } from '@main/tools/impl/monitor'

/**
 * Der Zod→JSON-Schema-Konverter, gegen die echten Werkzeuge.
 *
 * Der Konverter ist die Stelle, an der aus einem Zod-Schema das wird, was
 * Gemini von einem Werkzeug zu sehen bekommt. Geht dort etwas verloren, gibt
 * es keine Fehlermeldung: Das Modell ruft das Werkzeug bloß falsch auf, oder
 * gar nicht, weil es die Beschreibung des Feldes nie gesehen hat. Am Kristall
 * sieht das aus wie ein dummes Modell.
 *
 * Bewusst gegen alle Werkzeuge und nicht gegen ausgedachte Schemata: Was der
 * Konverter können muss, entscheidet sich daran, was in `impl/` tatsächlich
 * steht. Kommt ein Werkzeug mit einem Konstrukt dazu, das er nicht kennt,
 * soll das hier auffallen und nicht im Gespräch.
 *
 * Die Liste wird von Hand gepflegt, parallel zu `tools/index.ts`. Über die
 * Registry zu gehen wäre kürzer und zeigte weniger: Sie überspringt jedes
 * Werkzeug, dessen Zugang fehlt — Kalender, Twitch und Gmail fielen im Test
 * also stillschweigend heraus, und zwar genau die mit den größten Schemata.
 */

const ALL_TOOLS: ToolDefinition[] = [
  ...calendarTools,
  ...chromeTools,
  ...computerTools,
  ...contactTools,
  ...fileTools,
  ...gmailTools,
  ...gmailWebTools,
  ...higgsfieldTools,
  ...introspectionTools,
  ...knowledgeTools,
  ...memoryTools,
  ...minecraftTools,
  ...pcTools,
  ...priceWatchTools,
  ...quietTools,
  ...researchTools,
  ...selfHealTools,
  ...shellTools,
  ...shoppingTools,
  ...stocksTools,
  ...systemTools,
  ...timerTools,
  ...utilityTools,
  ...placeTools,
  ...webTools,
  ...yahooTools,
  ...windowTools,
  ...officeTools,
  ...cameraTools,
  ...organizeTools,
  ...whatsappTools,
  ...smartHomeTools,
  ...musicTools,
  ...monitorTools
]

/**
 * Zods Innenleben, so weit der Test es braucht.
 *
 * In Zod 4 hängt der Typname an `_zod.def.type`; die `instanceof`-Prüfungen
 * aus Version 3 gibt es nicht mehr. Der Konverter geht denselben Weg — hier
 * wird er nur zum Gegenlesen benutzt.
 */
type ZodInternals = { _zod?: { def?: { type?: string; shape?: Record<string, z.ZodTypeAny> } } }

const defOf = (schema: unknown): { type?: string; shape?: Record<string, z.ZodTypeAny> } =>
  (schema as ZodInternals)?._zod?.def ?? {}

/** Optionale Felder erkennt man daran, dass Zod ein fehlendes annimmt. */
function acceptsUndefined(schema: z.ZodTypeAny): boolean {
  return (schema as unknown as { safeParse?: (v: unknown) => { success: boolean } })
    .safeParse?.(undefined)?.success === true
}

describe('toJsonSchema', () => {
  it('kennt überhaupt Werkzeuge', () => {
    // Fängt den Fall, dass ein Umbau in `impl/` die Importe hier leerlaufen
    // lässt — ohne das liefe die ganze Datei grün durch, ohne etwas zu prüfen.
    assert.ok(ALL_TOOLS.length > 50, `nur ${ALL_TOOLS.length} Werkzeuge gefunden`)
  })

  it('vergibt jeden Namen nur einmal', () => {
    const seen = new Set<string>()
    const doubled = ALL_TOOLS.map((t) => t.name).filter((n) => !seen.add(n))
    assert.deepEqual(doubled, [], 'doppelt vergebene Werkzeugnamen')
  })

  for (const tool of ALL_TOOLS) {
    describe(tool.name, () => {
      const schema = tool.schema as z.ZodTypeAny
      const shape = defOf(schema).shape
      const out: JsonSchema = toJsonSchema(schema)

      it('bleibt ein Objekt', () => {
        // Der Standardzweig des Konverters macht aus allem Unbekannten
        // "string". Ein Werkzeugschema, das hier als string herauskommt, hat
        // damit sämtliche Felder verloren — der auffälligste Weg, wie eine
        // Zod-Umstellung schiefgehen kann.
        assert.equal(defOf(schema).type, 'object', 'Zod-Schema ist kein Objekt')
        assert.equal(out.type, 'object', `zu "${out.type}" degradiert`)
      })

      it('trägt alle Felder hinüber', () => {
        assert.deepEqual(
          Object.keys(out.properties ?? {}).sort(),
          Object.keys(shape ?? {}).sort()
        )
      })

      for (const [key, field] of Object.entries(shape ?? {})) {
        describe(key, () => {
          const sub = out.properties?.[key]

          it('hat einen Typ', () => {
            assert.ok(sub, 'Feld fehlt')
            assert.ok(sub?.type, 'kein type gesetzt')
          })

          it('behält den Grundtyp', () => {
            // Durch Hüllen wie optional/default hindurch: Eine Zahl darf
            // unterwegs nicht zu einer Zeichenkette werden, sonst schickt das
            // Modell "5" statt 5.
            let inner: unknown = field
            for (let i = 0; i < 8; i++) {
              const next = (inner as { _zod?: { def?: { innerType?: unknown } } })?._zod?.def
                ?.innerType
              if (!next) break
              inner = next
            }
            const base = defOf(inner).type
            if (base === 'number' || base === 'boolean') {
              assert.equal(sub?.type, base)
            }
          })

          it('behält die Beschreibung', () => {
            // Die Beschreibungen sind der halbe Grund, warum das Modell ein
            // Werkzeug richtig bedient. Sie hängen an der äußersten Hülle und
            // gingen beim Abschälen schon einmal verloren.
            const described = (field as unknown as { description?: string }).description
            if (described) assert.equal(sub?.description, described)
          })

          it('steht auf der richtigen Seite von required', () => {
            const required = out.required ?? []
            assert.equal(
              required.includes(key),
              !acceptsUndefined(field),
              acceptsUndefined(field)
                ? 'optional, steht aber in required'
                : 'Pflichtfeld fehlt in required'
            )
          })
        })
      }

      it('gibt Enum-Werte als Zeichenketten aus', () => {
        // Geminis `Schema.enum` ist `string[]`. Eine Zahl darin wird ohne
        // Vorwarnung abgelehnt — mit einem 400, in dem das Werkzeug nicht
        // vorkommt.
        const walk = (node: JsonSchema | undefined): void => {
          if (!node) return
          if (node.enum) {
            for (const value of node.enum) {
              assert.equal(typeof value, 'string', `enum-Wert ${String(value)} ist keine Zeichenkette`)
            }
          }
          walk(node.items)
          for (const child of Object.values(node.properties ?? {})) walk(child)
        }
        walk(out)
      })
    })
  }
})
