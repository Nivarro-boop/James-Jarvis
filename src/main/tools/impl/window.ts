import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { BLOCKED_INPUT, BLOCKED_PATTERNS } from './computer'
import {
  uiaExpand,
  uiaFocus,
  uiaInvoke,
  uiaRead,
  uiaSetValue,
  uiaToggle,
  type UiaElement
} from '../../automation/uia'

/**
 * Ein Fenster bedienen, statt auf ein Bild davon zu klicken.
 *
 * Der Gegenentwurf zu `computer_task` — und für alles mit einer gewöhnlichen
 * Oberfläche der bessere Weg. Windows führt zu jedem Fenster einen Baum aus
 * Rollen, Namen und Fähigkeiten; drei Dinge folgen daraus, die das Bild nicht
 * bieten kann.
 *
 * **Es braucht keinen Vordergrund.** Ein Mausklick, den man einem nicht aktiven
 * Fenster schickt, verpufft — nachgemessen, zehn Sekunden gewartet, nichts
 * passiert. Ein Druck über den Bedienbaum kommt an. Damit arbeitet James,
 * während Void etwas anderes tut, statt ihm die Maus wegzunehmen.
 *
 * **Es rät nicht.** "Drücke Settings" trifft immer; "klicke bei 487, 203"
 * trifft, bis jemand das Fenster verschiebt.
 *
 * **Es kostet fast nichts.** Der Baum eines Fensters sind ein paar hundert
 * Token, ein Bildschirmfoto mit zwei Kacheln rund sechzehnhundert — und das
 * bei jedem einzelnen Schritt. Genau daran geht ein Kontingent zugrunde.
 *
 * Was der Baum nicht kann: Zeichenflächen, Spiele, Videobilder, alles ohne
 * benannte Bedienelemente. Dafür bleibt `computer_task` mit Auge und Zeiger.
 */

/** Wie viele Elemente höchstens zurückkommen. */
const LIMIT_DEFAULT = 120
const LIMIT_MAX = 300

/**
 * Die Nummern des zuletzt gelesenen Fensters.
 *
 * Der Bedienbaum hält seine Verweise in einer einzigen Tabelle, die jedes
 * Lesen ersetzt — und die Nummern fangen dabei wieder bei eins an. Wer nach
 * dem Lesen eines zweiten Fensters eine Nummer aus dem ersten bedient, greift
 * deshalb nicht ins Leere, sondern trifft das gleichnummerige Element im
 * neuen Fenster.
 *
 * Für die Sperrliste ist das der Unterschied zwischen Schutz und Anschein:
 * Der Baum wird gelesen, bevor sein Titel geprüft werden kann — die Tabelle
 * steht danach auf dem gesperrten Fenster, auch wenn das Lesen abgewiesen
 * wurde. Ohne diese Menge genügte eine geratene Zahl, um an einem Fenster zu
 * handeln, dessen Inhalt das Modell nie zu sehen bekam.
 *
 * Sie wird deshalb vor jedem Lesen geleert und nur von einem erlaubten wieder
 * gefüllt. Ein abgewiesenes oder fehlgeschlagenes Lesen lässt sie leer, und
 * danach ist keine einzige Nummer mehr bedienbar.
 */
let bekannteRefs = new Set<number>()

/** Nach einem erlaubten Lesen: genau diese Nummern sind bedienbar. */
function merkeRefs(refs: number[]): void {
  bekannteRefs = new Set(refs)
}

/** Vor jedem Lesen — und damit auch nach jedem, das abgewiesen wurde. */
function vergissRefs(): void {
  bekannteRefs = new Set()
}

function refBekannt(ref: number): boolean {
  return bekannteRefs.has(ref)
}

/**
 * Ein gesperrtes Fenster bleibt gesperrt, auch auf diesem Weg.
 *
 * Der Bedienbaum ist der bequemere Zugang, nicht der erlaubtere: Was per
 * Bildschirmsteuerung tabu ist — Bankgeschäfte, Passwortspeicher, Bezahlseiten
 * —, ist es hier genauso. Geprüft wird der Fenstertitel, wie drüben auch.
 */
function pruefeFenster(titel: string): void {
  for (const muster of BLOCKED_PATTERNS) {
    if (muster.test(titel)) {
      throw new Error(
        `Das Fenster "${titel}" fasse ich nicht an. Sag dem Nutzer, dass er das selbst machen muss.`
      )
    }
  }
}

/** Was ein Element hergibt, in einer Zeile — kurz, weil es viele sind. */
function zeile(e: UiaElement): string {
  const teile = [`${e.ref}:`, `[${e.rolle}]`, `"${e.name}"`]
  if (e.wert) teile.push(`= "${e.wert.slice(0, 60)}"`)
  if (e.zustand) teile.push(`(${e.zustand})`)
  if (e.kann.length > 0) teile.push(`| ${e.kann.join(',')}`)
  return teile.join(' ')
}

const readWindow = defineTool({
  name: 'read_window',
  group: 'system',
  description:
    'Liest die Bedienelemente eines Fensters: Knöpfe, Textfelder, Links, Kästchen — mit Namen und ' +
    'einer Nummer, über die du sie danach mit window_action bedienst. ' +
    'Nimm das VOR computer_task, wann immer das Ziel ein gewöhnliches Programm ist: Es braucht das ' +
    'Fenster nicht im Vordergrund, es trifft genau, und es kostet einen Bruchteil. ' +
    'Ohne Angabe wird das aktive Fenster gelesen. Bleibt die Liste leer oder fehlt, was du suchst ' +
    '(Zeichenflächen, Spiele, Videobilder), nimm computer_task.',
  schema: z.object({
    window: z
      .string()
      .optional()
      .describe('Titel des Fensters oder ein Teil davon. Leer oder "aktiv" nimmt das vorderste.'),
    limit: z.number().optional().describe(`Höchstens so viele Elemente, Standard ${LIMIT_DEFAULT}.`)
  }),
  async execute({ window, limit }) {
    const grenze = Math.min(LIMIT_MAX, Math.max(5, limit ?? LIMIT_DEFAULT))

    // Erst räumen, dann lesen: Was danach gilt, entscheidet allein dieser
    // Aufruf. Bricht er ab — abgewiesenes Fenster, Zeitüberschreitung, toter
    // Server —, bleibt nichts Bedienbares zurück.
    vergissRefs()

    const baum = await uiaRead(window ?? 'aktiv', grenze)
    pruefeFenster(baum.fenster)
    merkeRefs(baum.elemente.map((e) => e.ref))

    return {
      fenster: baum.fenster,
      elemente: baum.elemente.map(zeile),
      ...(baum.gefunden > baum.gezeigt
        ? { hinweis: `${baum.gefunden - baum.gezeigt} weitere Elemente nicht gezeigt.` }
        : {}),
      ...(baum.elemente.length === 0
        ? {
            hinweis:
              'Dieses Fenster gibt keine Bedienelemente her. Nimm computer_task mit Bild und Zeiger.'
          }
        : {})
    }
  }
}) as ToolDefinition

const windowAction = defineTool({
  name: 'window_action',
  group: 'system',
  description:
    'Bedient ein Element, das read_window gefunden hat — über seine Nummer. ' +
    'druecken drückt Knöpfe und öffnet Links, schreiben setzt den Inhalt eines Textfeldes ' +
    '(ersetzt ihn ganz), umschalten kippt ein Kästchen, aufklappen und zuklappen öffnen Menüs und ' +
    'Baumeinträge, fokus setzt die Schreibmarke hinein. ' +
    'Wirkt auch, wenn das Fenster nicht im Vordergrund ist. ' +
    'Nach jeder Aktion, die die Oberfläche verändert, erst wieder read_window aufrufen: Die ' +
    'Nummern gelten nur für den zuletzt gelesenen Stand.',
  schema: z.object({
    ref: z.number().describe('Die Nummer aus read_window.'),
    action: z
      .enum(['druecken', 'schreiben', 'umschalten', 'aufklappen', 'zuklappen', 'fokus'])
      .describe('Was mit dem Element geschehen soll.'),
    text: z.string().optional().describe('Nur für schreiben: der neue Inhalt des Feldes.')
  }),
  spokenHint: 'Einen Moment.',
  async execute({ ref, action, text }) {
    if (!refBekannt(ref)) {
      throw new Error(
        `Die Nummer ${ref} gehört nicht zum zuletzt gelesenen Fenster. Lies es erst mit ` +
          'read_window — die Nummern gelten immer nur für den letzten Stand.'
      )
    }

    if (action === 'schreiben') {
      if (typeof text !== 'string') throw new Error('Zum Schreiben fehlt der Text.')
      // Dieselbe Grenze wie beim Tippen über die Bildschirmsteuerung: Was
      // niemals getippt wird, wird auch niemals gesetzt.
      if (BLOCKED_INPUT.test(text)) {
        throw new Error('Diesen Text gebe ich nicht ein. Sag dem Nutzer, dass er das selbst tippt.')
      }
      await uiaSetValue(ref, text)
      return { getan: 'geschrieben', ref }
    }

    switch (action) {
      case 'druecken': {
        // Was tatsächlich geschah, kommt zurück: Nicht jedes Element lässt
        // sich drücken — bei einem Listeneintrag wird gewählt, bei einem
        // Kästchen umgeschaltet. Das Modell soll das erfahren und nicht raten.
        const wie = await uiaInvoke(ref)
        return { getan: wie, ref }
      }
      case 'umschalten':
        await uiaToggle(ref)
        return { getan: 'umgeschaltet', ref }
      case 'aufklappen':
        await uiaExpand(ref, false)
        return { getan: 'aufgeklappt', ref }
      case 'zuklappen':
        await uiaExpand(ref, true)
        return { getan: 'zugeklappt', ref }
      case 'fokus':
        await uiaFocus(ref)
        return { getan: 'fokussiert', ref }
    }
  }
}) as ToolDefinition

/**
 * Kein eigenes `list_windows` — das gibt es schon.
 *
 * `system.ts` zählt die offenen Fenster bereits auf, und ein zweites Werkzeug
 * desselben Namens hat die Registrierung schlicht abgebrochen: "Tool doppelt
 * registriert", und zwar mittendrin, womit alles danach fehlte. Wer den Titel
 * für `read_window` sucht, nimmt das vorhandene.
 */
export const windowTools: ToolDefinition[] = [readWindow, windowAction]

/** Nur zum Testen. */
export const __internals = { pruefeFenster, merkeRefs, vergissRefs, refBekannt }
