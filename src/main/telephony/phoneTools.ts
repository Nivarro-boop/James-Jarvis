import { allTools, getTool, toJsonSchema } from '../tools/registry'
import type { ToolListUnion } from '@google/genai'

/**
 * Was James am Telefon darf.
 *
 * Lange: nichts. Der Grund dafür stand in `liveCall.ts` und war gut — ein
 * Anruf, bei dem fünf Sekunden Stille herrscht, weil im Hintergrund eine
 * Webseite geladen wird, klingt wie ein Verbindungsabbruch, und der andere
 * legt auf. Nur folgt daraus nicht "keine Werkzeuge", sondern zwei andere
 * Dinge: nur schnelle, und vorher ansagen. Das Ansagen steht im Prompt, die
 * Auswahl steht hier, und der Zeitdeckel pro Aufruf in `liveCall.ts`.
 *
 * ── Warum eine Liste und keine Regel ──
 *
 * Es wäre bequemer, nach Gruppe oder nach `alwaysAsk` zu filtern. Beides
 * ginge schief. Eine Gruppe wie `system` enthält Harmloses neben
 * Bildschirmfotos; und ein Werkzeug ohne Rückfrage ist nicht deshalb
 * telefontauglich — `deep_research` fragt nichts und läuft trotzdem Minuten.
 * Was am Telefon geht, ist eine Entscheidung pro Werkzeug, und sie soll
 * sichtbar getroffen werden. Ein neues Werkzeug ist am Telefon stumm, bis es
 * hier steht: das ist die richtige Voreinstellung.
 *
 * ── Warum zwei Listen ──
 *
 * Wer anruft, steht im Adressbuch — das ist die Bedingung, um überhaupt
 * durchzukommen. Aber im Adressbuch stehen auch die Schwiegermutter und der
 * Installateur, und denen den Kalender vorzulesen wäre etwas anderes als dem
 * Besitzer. Deshalb hängt die zweite Liste daran, ob der Anrufer der Nutzer
 * selbst ist (siehe `ownerContact` in `providers/twilio.ts`).
 */

/**
 * Auskünfte, die niemandem gehören.
 *
 * Wetter, Rechnen, Kurse, Übersetzen — nichts davon verrät etwas über den
 * Nutzer, und alles davon ist in ein, zwei Sekunden da.
 */
const PUBLIC_TOOLS = [
  'weather',
  'calculate',
  'unit_convert',
  'translate',
  'timezone_now',
  'stock_price',
  'exchange_rate',
  'web_search',
  'wikipedia',
  'news_headlines'
] as const

/**
 * Was nur der Nutzer selbst zu hören bekommt.
 *
 * Der Kalender ist der Grund, warum man überhaupt anruft. Timer und Gedächtnis
 * kommen dazu, weil beides unterwegs entsteht: "merk dir, dass ich Öl
 * nachfüllen muss" ist ein Satz, den man im Auto sagt und am Rechner vergisst.
 *
 * Mails stehen bewusst nicht hier. Ein Postfach vorzulesen dauert, und die
 * Leitung ist der falsche Ort für die Frage, ob das gerade jemand mithört.
 */
const OWNER_TOOLS = [
  'calendar_agenda',
  'calendar_search',
  'calendar_list_calendars',
  'recall',
  'remember',
  'timer_set',
  'timer_list',
  'timer_cancel',
  'contact_lookup',
  'list_schedules'
] as const

/** Die Namen, die am Telefon erlaubt sind. */
let lastMissing = ''

/**
 * Was auch mit vollem Zugriff am Telefon nicht geht.
 *
 * Die Kamera zeigt ein Bild, das am Telefon niemand sieht, und ein
 * Bildschirmfoto ebenso — beide liefern dem Modell etwas, das es dann
 * vorlesen müsste. `computer_task` und `desktop_task` bleiben dagegen: Wer
 * unterwegs „mach am Rechner OBS auf" sagt, meint genau das.
 */
// `tool_search` und `tool_use` ebenfalls nicht: Am Telefon ist die Liste
// ohnehin vollständig, und über `tool_use` liefe sonst genau das, was hier
// gesperrt ist, durch die Hintertür.
const NEVER_ON_PHONE = new Set(['camera_look', 'screenshot', 'tool_search', 'tool_use', 'call_me'])

/**
 * Alle Werkzeuge — für den Besitzer, der die PIN eingetippt hat.
 *
 * Die Sicherungen bleiben dieselben wie am Rechner: Was nachfragt, fragt am
 * Telefon laut nach und braucht ein gesprochenes Ja; was gesperrt ist, bleibt
 * gesperrt. Was länger braucht, läuft im Hintergrund weiter und wird
 * nachgereicht (siehe `liveCall.ts`).
 */
export function fullPhoneToolNames(): string[] {
  return allTools()
    .map((t) => t.name)
    .filter((name) => !NEVER_ON_PHONE.has(name))
}

export function phoneToolNames(owner: boolean, full = false): string[] {
  if (full) return fullPhoneToolNames()
  const names = [...PUBLIC_TOOLS, ...(owner ? OWNER_TOOLS : [])]
  // Gegen die Liste der wirklich registrierten prüfen: Ein Werkzeug, dessen
  // Zugang fehlt, taucht gar nicht erst auf — es hier zu deklarieren hieße,
  // James am Telefon etwas anzubieten, das dann mit einem Fehler antwortet.
  // Was fehlt, wird gemeldet: Sonst steht ein Tippfehler jahrelang in dieser
  // Liste, und niemand merkt, dass das Werkzeug am Telefon nie da war. Nur
  // bei einer Änderung — die Funktion läuft bei jedem Werkzeugaufruf.
  const missing = names.filter((name) => getTool(name) === undefined).join(', ')
  if (missing && missing !== lastMissing) {
    console.warn(`[telefonie] Nicht registriert, am Telefon daher nicht verfügbar: ${missing}`)
  }
  lastMissing = missing
  return names.filter((name) => getTool(name) !== undefined)
}

/**
 * Ob am Telefon überhaupt Werkzeuge zur Verfügung stehen.
 *
 * Wird nur für den Systemhinweis gebraucht: Ohne Werkzeuge muss dort etwas
 * anderes stehen als mit.
 */
export function hasPhoneTools(owner: boolean, full = false): boolean {
  return phoneToolNames(owner, full).length > 0
}

/**
 * Die Deklarationen für den Live-Socket, auf die erlaubten gekürzt.
 *
 * Bewusst nicht über `geminiToolDeclarations()` mit anschließendem Filtern:
 * Das zählt die Ersparnis des Sparmodus mit, und die Zahlen der Telefonleitung
 * gehören nicht in die Statistik der Sitzung am Rechner.
 *
 * ── Die eine Umgehung am Ende ──
 *
 * `toJsonSchema` schreibt die Typnamen klein — "string", "object" —, so wie
 * OpenAPI und die REST-Schnittstelle sie erwarten. Der TypeScript-Typ des SDK
 * verlangt an derselben Stelle sein eigenes Aufzählungsformat in Großbuchstaben
 * ("STRING"). Beides landet als dasselbe JSON auf der Leitung; Gemini nimmt die
 * kleingeschriebene Form seit jeher an, und `geminiToolDeclarations` schickt am
 * Rechner nichts anderes.
 *
 * Der Unterschied ist nur, dass es dort nie auffiel: Diese Funktion ist die
 * einzige, die ihre Ausgabe überhaupt gegen die Typen des SDK hält — die andere
 * gibt `unknown[]` zurück. Hier stand deshalb einmal eine Hilfsfunktion über
 * `any`, die vorgab, Enum-Werte zu Zeichenketten zu machen. Das taten sie schon;
 * was sie wirklich tat, war die ganze Prüfung stillzulegen, Typnamen
 * eingeschlossen. Eine benannte Umgehung an einer Stelle ist ehrlicher als ein
 * `any`, das nebenbei alles andere mit abräumt.
 */
export function phoneToolDeclarations(owner: boolean, full = false): ToolListUnion {
  const allowed = new Set(phoneToolNames(owner, full))
  if (allowed.size === 0) return []

  const declarations = allTools()
    .filter((t) => allowed.has(t.name))
    .map((t) => {
      const schema = toJsonSchema(t.schema)
      return {
        name: t.name,
        description: t.description,
        // Wie am Rechner: Gemini lehnt ein leeres properties-Objekt ab, also
        // bekommen parameterlose Werkzeuge gar kein parameters-Feld.
        ...(schema.properties && Object.keys(schema.properties).length > 0
          ? { parameters: schema }
          : {})
      }
    })

  return [{ functionDeclarations: declarations }] as ToolListUnion
}
