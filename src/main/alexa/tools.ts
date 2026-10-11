import { allTools, getTool, toJsonSchema } from '../tools/registry'
import { phoneToolNames } from '../telephony/phoneTools'

/**
 * Was James über den Echo Dot darf.
 *
 * Die Liste beginnt bei der des Telefons und wächst um das, was im eigenen
 * Wohnzimmer sinnvoll ist. Warum überhaupt eine eigene Liste und nicht alle
 * Werkzeuge, hat zwei Gründe, und beide sind wichtiger als beim Telefon:
 *
 * ── Acht Sekunden ──
 *
 * Alexa wartet nicht länger auf eine Antwort. Ein Werkzeug, das eine Webseite
 * lädt oder eine tiefe Recherche startet, ist damit nicht langsam, sondern
 * unbrauchbar: Der Echo sagt „James antwortet gerade nicht", und der Rest
 * läuft ins Leere. Zugelassen ist deshalb nur, was in ein, zwei Sekunden
 * fertig ist.
 *
 * ── Wer alles mitreden kann ──
 *
 * Das ist die eigentliche Entscheidung. Ein Echo Dot steht im Wohnzimmer und
 * hört jeden, der im Raum ist — Besuch, Kinder, den Fernseher. Es gibt keine
 * Anmeldung und keine Stimmerkennung, auf die man sich verlassen könnte.
 * Dieselbe Überlegung wie beim Smart Home, nur schärfer: Was hier
 * durchgelassen wird, kann jeder auslösen, der in der Wohnung steht.
 *
 * Also: Auskünfte ja, Musik ja, Licht ja — alles zurücknehmbar oder öffentlich.
 * Mails, Dateien, Einkäufe, Bildschirmsteuerung und Telefonate nein, und zwar
 * ohne Schalter zum Einschalten. Ein Werkzeug ist über Alexa stumm, bis es hier
 * steht; das ist die richtige Voreinstellung.
 */

/**
 * Was zum Telefon dazukommt.
 *
 * Musik ist der Grund, warum die meisten überhaupt mit einem Echo reden, und
 * sie ist in dem Moment zurückgenommen, in dem jemand „aus" sagt. Das Licht
 * aus demselben Grund — und `home_control` sperrt Schlösser, Tore und
 * Alarmanlagen ohnehin selbst, solange sie in den Einstellungen nicht
 * freigegeben sind.
 */
const ECHO_EXTRA = [
  'music_play',
  'music_control',
  'music_volume',
  'music_devices',
  'music_switch_device',
  'music_now_playing',
  'home_devices',
  'home_control',
  'system_status'
] as const

/**
 * Die Namen, die über Alexa erlaubt sind.
 *
 * `owner: true`, weil der Echo im Zuhause des Nutzers steht — der Kalender ist
 * dort dieselbe Auskunft wie am Rechner. Wer das anders sieht, hat einen Echo
 * an einem Ort stehen, an dem er keinen stehen haben sollte.
 */
export function alexaToolNames(): string[] {
  const names = [...phoneToolNames(true), ...ECHO_EXTRA]
  // Gegen die wirklich registrierten prüfen: Ein Werkzeug, dessen Zugang
  // fehlt, existiert gar nicht — es hier zu deklarieren hieße, James etwas
  // anbieten zu lassen, das mit einem Fehler antwortet.
  return [...new Set(names)].filter((name) => getTool(name) !== undefined)
}

/** Dieselben Deklarationen, wie sie `generateContent` erwartet. */
export function alexaToolDeclarations(): unknown[] {
  const allowed = new Set(alexaToolNames())
  if (allowed.size === 0) return []

  const declarations = allTools()
    .filter((t) => allowed.has(t.name))
    .map((t) => {
      const schema = toJsonSchema(t.schema)
      return {
        name: t.name,
        description: t.description,
        // Wie überall sonst: Gemini lehnt ein leeres properties-Objekt ab.
        ...(schema.properties && Object.keys(schema.properties).length > 0
          ? { parameters: schema }
          : {})
      }
    })

  return [{ functionDeclarations: declarations }]
}
