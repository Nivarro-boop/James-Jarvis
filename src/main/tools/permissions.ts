import { createHash } from 'node:crypto'
import type { ToolPermission } from '@shared/types'
import { getSettings } from '../store/settings'
import { getTool } from './registry'

/**
 * Rechte-Engine mit Rückfrage über den Gesprächsfluss.
 *
 * Naheliegend wäre, die Rückfrage über eine zweite Sprachausgabe einzuspielen.
 * Das klingt aber wie ein Fremdkörper: andere Stimme, andere Latenz, und man
 * kann nicht natürlich darauf antworten.
 *
 * Stattdessen bekommt das Modell beim ersten Aufruf eines heiklen Werkzeugs
 * keine Ausführung, sondern eine Aufforderung: frag den Nutzer wörtlich das
 * hier. Es stellt die Frage in seiner eigenen Stimme, der Nutzer antwortet
 * normal, und das Modell ruft das Werkzeug erneut auf.
 *
 * Damit das Modell die Zustimmung nicht einfach erfinden kann, gilt beim
 * zweiten Aufruf:
 *   - es muss vorher eine Rückfrage für exakt diese Argumente gegeben haben
 *   - der Nutzer muss seitdem tatsächlich etwas gesagt haben
 *   - das Gesagte muss eine ausdrückliche Zustimmung sein
 * Alle drei Punkte prüfen wir hier, nicht das Modell.
 */

/**
 * In einem Profil mit Bestätigungen immer nachfragen.
 *
 * Die Liste ist bewusst kurz und enthält nur, was nach außen geht oder sich
 * nicht zurücknehmen lässt. Die Bildschirmsteuerung stand hier ursprünglich
 * auch drin und wurde entfernt: bei jedem "mach mal eben" erst nachzufragen
 * hat das Werkzeug im Alltag unbrauchbar gemacht. Sie ist weiterhin über die
 * Einstellungen auf "fragt nach" stellbar, und die harten Sperren
 * (Banking-, Passwort- und Bezahlfenster, keine Zugangsdaten tippen, kein
 * Kaufabschluss) gelten unverändert.
 */
const FORCED_ASK = new Set([
  'gmail_send',
  'gmail_reply',
  'gmail_trash',
  'yahoo_send',
  'amazon_cart_add',
  'amazon_cart_remove',
  'amazon_open_checkout',
  'file_write',
  'file_trash',
  'run_command',
  'schedule_task',
  'price_watch_create',
  'contact_call',
  // Eine Chatnachricht ist sofort auf dem Telefon eines Menschen und nicht
  // zurückholbar. `whatsapp_compose` steht bewusst nicht hier: Das legt den
  // Text nur ins Fenster, gedrückt wird von Hand.
  'whatsapp_send',
  // Verschiebt Dateien im Dutzend. Rückgängig zu machen ist es
  // (`file_organize_undo`), überraschend wäre es trotzdem.
  'file_organize'
])

/** Wird nie ausgeführt, egal was das Modell will. */
const HARD_DENY = new Set(['amazon_place_order', 'enter_payment_details'])

/** Eine Rückfrage verfällt, wenn nicht zeitnah darauf reagiert wird. */
const CHALLENGE_TTL_MS = 3 * 60 * 1000

/**
 * Wie lange eine bereits erteilte Zustimmung einen zweiten Versuch deckt.
 *
 * Kürzer als die Rückfrage selbst: Das soll den Fall auffangen, dass die
 * Ausführung an etwas Äußerem gescheitert ist (Netz weg, Browser nicht da) und
 * das Modell es gleich noch einmal versucht — nicht eine halbe Unterhaltung
 * später erneut greifen.
 */
const GRANT_TTL_MS = 2 * 60 * 1000

interface Challenge {
  toolName: string
  argsHash: string
  issuedAt: number
}

const challenges = new Map<string, Challenge>()

/**
 * Zustimmungen, die einmal erteilt und dabei verbraucht wurden, deren Aktion
 * aber fehlgeschlagen ist. Siehe `regrantConfirmation`.
 */
const grants = new Map<string, number>()

/** Der Nutzer-Turn, den der Renderer beim Tool-Aufruf mitschickt. */
export interface UserTurnContext {
  lastUserTextAt: number
  lastUserText: string
}

function hashArgs(toolName: string, args: unknown): string {
  // Stabile Schlüsselreihenfolge, sonst hasht dieselbe Anfrage zweimal
  // unterschiedlich und die Bestätigung greift nie.
  const stable = JSON.stringify(args, Object.keys(flatten(args)).sort())
  return createHash('sha256').update(`${toolName}:${stable}`).digest('hex').slice(0, 24)
}

/**
 * Sammelt jeden Schlüsselnamen, der irgendwo im Argumentbaum vorkommt.
 *
 * Listen müssen mit durchlaufen werden, und das ist keine Feinheit: Die Liste
 * oben ist für `JSON.stringify` die Positivliste der Felder, die überhaupt
 * ausgegeben werden. Fehlt ein Name darin, wird das Objekt, in dem er steckt,
 * als leeres `{}` serialisiert — sein Inhalt verschwindet aus dem Hash. Zwei
 * Aufrufe, die sich nur innerhalb einer Liste unterscheiden, bekämen damit
 * denselben Fingerabdruck, und eine Zustimmung zu dem einen würde den anderen
 * decken. MCP-Werkzeuge fragen grundsätzlich nach und nehmen beliebige
 * Argumente entgegen — der Fall ist also erreichbar, nicht theoretisch.
 */
function flatten(value: unknown, prefix = '', out: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, prefix, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = true
      flatten((value as Record<string, unknown>)[key], `${prefix}${key}.`, out)
    }
  }
  return out
}

export function permissionFor(toolName: string): ToolPermission {
  if (HARD_DENY.has(toolName)) return 'deny'
  const settings = getSettings()
  const configured = settings.permissions[toolName]
  if (configured === 'deny') return 'deny'
  if (!settings.confirmActions) return 'allow'
  if (FORCED_ASK.has(toolName)) return 'ask'
  const tool = getTool(toolName)
  if (tool?.alwaysAsk) return 'ask'
  if (configured) return configured
  return defaultPermission(toolName)
}

/**
 * Was ohne Rückfrage durchläuft.
 *
 * Nur was Dateien schreibt, Befehle ausführt oder von einem Konto aus nach
 * außen wirkt, fragt nach. Alles andere darf laufen — eine Rückfrage vor dem
 * Fensterwechsel nervt bloß und schützt niemanden.
 *
 * `close_app` stand hier und ist bewusst herausgenommen worden. Der Satz
 * lautet „mach das Fenster zu", und darauf „soll ich das Fenster zumachen?"
 * zu antworten, ist keine Absicherung, sondern eine Wiederholung der Frage,
 * die gerade gestellt wurde. Es kostete zwei Gesprächszüge für eine Aktion,
 * die ein Klick auf das Kreuz auch ohne Rückfrage erledigt. Zurückgenommen
 * wird dabei nichts, was nicht ohnehin zurückgenommen würde: geschlossen wird
 * über `CloseMainWindow`, also so, als hätte man das Kreuz gedrückt — ein
 * Editor mit ungesicherter Arbeit fragt dann selbst nach und bleibt offen,
 * wenn man ablehnt. Kein Kill, kein Datenverlust.
 *
 * `lock_screen` bleibt stehen. Nicht weil es gefährlich wäre, sondern weil ein
 * versehentliches Sperren mitten im Spiel bedeutet, dass man sich neu anmelden
 * muss, und das dauert länger als jede Rückfrage.
 */
const SYSTEM_NEEDS_ASK = new Set(['run_command', 'file_write', 'file_trash', 'lock_screen'])

function defaultPermission(toolName: string): ToolPermission {
  const tool = getTool(toolName)
  if (!tool) return 'ask'
  switch (tool.group) {
    case 'research':
    case 'web':
    case 'memory':
    case 'minecraft':
    case 'timer':
    case 'chrome':
      return 'allow'
    case 'system':
      return SYSTEM_NEEDS_ASK.has(toolName) ? 'ask' : 'allow'
    case 'shopping':
      // Nachsehen ist harmlos, ändern nicht. `_list` gehört ausdrücklich dazu:
      // ohne das musste der Nutzer eine Rückfrage beantworten, um zu erfahren,
      // welche Preise überhaupt beobachtet werden.
      return toolName.startsWith('find_') ||
        toolName.endsWith('_search') ||
        toolName.endsWith('_view') ||
        toolName.endsWith('_list') ||
        toolName === 'check_price'
        ? 'allow'
        : 'ask'
    case 'gmail':
      // Lesen ist harmlos. Versenden und Papierkorb stehen ohnehin in
      // FORCED_ASK und kommen hier gar nicht erst an.
      return 'allow'
    case 'mail':
      // Dasselbe für Yahoo: Aufmachen und Ausfüllen ändert nichts, was
      // jemand anderes sieht. `yahoo_send` steht in FORCED_ASK.
      return 'allow'
    case 'calendar':
      // Nachsehen ist harmlos, und eine Rückfrage vor „was habe ich heute"
      // wäre genau die Reibung, die einen Sprachassistenten unbenutzbar macht:
      // zwei Sätze Genehmigungsverfahren für eine Auskunft, die auch auf dem
      // Telefon steht. Eintragen, Verschieben und Absagen tragen `alwaysAsk`
      // und kommen hier gar nicht erst an.
      return 'allow'
    case 'contacts':
      // Das Adressbuch liegt lokal und ist jederzeit im Einstellungsfenster
      // zu überschreiben. Nachschlagen und Eintragen laufen deshalb durch;
      // `contact_remove` hat alwaysAsk und kommt hier nicht an.
      return 'allow'
    case 'schedule':
      // Nachsehen ist harmlos, einrichten und löschen nicht. Dieselbe Trennung
      // wie beim Einkaufen: Ohne sie musste der Nutzer eine Rückfrage
      // beantworten, nur um zu erfahren, was überhaupt eingeplant ist.
      // `schedule_task` steht in FORCED_ASK, `cancel_schedule` hat alwaysAsk —
      // beide kommen hier gar nicht erst an.
      return toolName.startsWith('list_') ? 'allow' : 'ask'
    case 'media':
      // Erzeugen kostet Guthaben, nachsehen und aufmachen nicht.
      return toolName.endsWith('_status') || toolName.endsWith('_open') ? 'allow' : 'ask'
    case 'agent':
      // Plan schreiben, Anleitungen lesen und speichern, Unteragenten
      // starten: alles nur James' eigene Arbeitsweise, nichts nach außen.
      // Unteragenten dürfen ihrerseits nur, was ohne Rückfrage läuft.
      // `skill_delete` trägt alwaysAsk und kommt hier nicht an.
      return 'allow'
    case 'mcp':
      // Der Server sagt selbst, was nur liest (`readOnlyHint`). Alles andere
      // fragt nach, bis es jemand unter „Rechte" freigibt.
      return tool.readOnly ? 'allow' : 'ask'
    case 'office':
      /*
       * Anlegen läuft durch.
       *
       * Anders als `file_write`, das hier ausdrücklich nachfragt, und der
       * Unterschied ist nicht Bequemlichkeit: Diese Werkzeuge können nichts
       * überschreiben. Sie zählen einen freien Namen hoch, wenn schon etwas
       * so heißt (`office/save.ts`), und sie fassen nie eine bestehende Datei
       * an. Was bleibt, ist eine neue Datei in Dokumente — und darauf „soll
       * ich eine Präsentation machen?" zu antworten, nachdem der Nutzer
       * gerade um eine gebeten hat, ist keine Absicherung, sondern eine
       * Wiederholung seiner eigenen Frage.
       */
      return 'allow'
    case 'messaging':
      // Lesen und vorbereiten ja, verschicken nicht — `whatsapp_send` steht
      // in FORCED_ASK und kommt hier gar nicht erst an.
      return 'allow'
    case 'smarthome':
      /*
       * Licht an und aus, ohne Rückfrage.
       *
       * Es ist die zurücknehmbarste Handlung, die dieser Assistent kennt: Wer
       * sich vertut, sagt es noch einmal andersherum, und das Ergebnis steht
       * im Zimmer. Eine Rückfrage davor kostet zwei Gesprächszüge für etwas,
       * das der Lichtschalter auch ohne erledigt.
       *
       * Das Gefährliche ist damit nicht ungesichert, sondern anders gesichert:
       * Schlösser, Tore und Alarmanlagen schaltet `home_control` überhaupt
       * nicht, solange sie nicht in den Einstellungen freigegeben sind. Ein
       * Haken, den jemand bewusst setzt, ist an dieser Stelle die bessere
       * Sicherung als ein gesprochenes Ja — was dieses Mikrofon hört, kann
       * auch aus dem Fernseher kommen.
       */
      return 'allow'
    case 'music':
      /*
       * Musik läuft durch, alles davon.
       *
       * Es ist die zurücknehmbarste Sorte Handlung nach dem Licht: Wer den
       * falschen Titel hört, sagt „nächster", und die Sache ist erledigt.
       * Eine Rückfrage vor „mach Musik an" wäre die Reibung, die einen
       * Sprachassistenten unbenutzbar macht.
       *
       * Auch `music_switch_device`, obwohl das beim Umstellen des
       * Windows-Ausgangs mehr trifft als nur die Musik — dort kommt danach
       * auch James' Stimme heraus. Das Werkzeug sagt es beim Umschalten
       * dazu, und ein zurückgenommener Satz ist die bessere Sicherung als
       * eine Rückfrage, die man bei jedem Wechsel zwischen Kopfhörer und
       * Lautsprecher beantworten müsste.
       */
      return 'allow'
    default:
      return 'ask'
  }
}

/** Legt eine Rückfrage an und liefert den Text, den das Modell stellen soll. */
export function issueChallenge(toolName: string, args: unknown, question: string): string {
  const argsHash = hashArgs(toolName, args)
  challenges.set(argsHash, { toolName, argsHash, issuedAt: Date.now() })
  pruneChallenges()

  return [
    'BESTÄTIGUNG NÖTIG — die Aktion wurde noch nicht ausgeführt.',
    `Frag den Nutzer jetzt genau das, in deinen eigenen Worten aber inhaltlich unverändert: "${question}"`,
    'Warte seine Antwort ab.',
    'Stimmt er zu, rufe dasselbe Werkzeug mit exakt denselben Argumenten erneut auf und setze zusätzlich confirmed auf true (bei tool_use innerhalb von args_json).',
    'Lehnt er ab, rufe es nicht erneut auf und bestätige ihm kurz, dass du es gelassen hast.'
  ].join(' ')
}

export type ConfirmVerdict =
  | { ok: true }
  /**
   * `reissue` heißt: Es liegt keine Ablehnung vor, sondern gar kein Vorgang.
   * Der Aufrufer soll dann neu fragen statt abzulehnen — siehe unten.
   */
  | { ok: false; reason: string; reissue?: boolean }

/**
 * Hält eine bereits erteilte Zustimmung kurz am Leben.
 *
 * Der Anlass steht im Aktionslog vom 28. Juli 2026: Ein bestätigtes
 * `chrome_open_tab` lief los, scheiterte an etwas ganz anderem, und weil die
 * Zustimmung beim Ausführen verbraucht wird, war sie beim Wiederholen weg. Das
 * Modell schickte viermal `confirmed: true` und bekam viermal "dafür gab es
 * keine Rückfrage" — eine Sackgasse, aus der es nicht herausfand.
 *
 * Bewusst nur nach einem *gescheiterten* Versuch. Nach einem erfolgreichen
 * wäre es die Erlaubnis, dieselbe Mail zweimal zu verschicken.
 */
export function regrantConfirmation(toolName: string, args: unknown): void {
  grants.set(hashArgs(toolName, args), Date.now())
}

/** Prüft, ob ein `confirmed: true` wirklich gedeckt ist. */
export function verifyConfirmation(
  toolName: string,
  args: unknown,
  turn: UserTurnContext | undefined
): ConfirmVerdict {
  const argsHash = hashArgs(toolName, args)

  const granted = grants.get(argsHash)
  if (granted !== undefined) {
    grants.delete(argsHash)
    if (Date.now() - granted <= GRANT_TTL_MS) return { ok: true }
  }

  const challenge = challenges.get(argsHash)

  if (!challenge) {
    return {
      ok: false,
      reissue: true,
      reason:
        'Für diese Aktion gab es keine Rückfrage. Ruf das Werkzeug ohne confirmed auf, dann stelle ich dir die Frage.'
    }
  }

  if (Date.now() - challenge.issuedAt > CHALLENGE_TTL_MS) {
    challenges.delete(argsHash)
    return {
      ok: false,
      reissue: true,
      reason: 'Die Rückfrage ist zu lange her. Frag den Nutzer bitte erneut.'
    }
  }

  // Der Nutzer muss seit der Rückfrage tatsächlich etwas gesagt haben.
  if (!turn || turn.lastUserTextAt < challenge.issuedAt) {
    return {
      ok: false,
      reason:
        'Der Nutzer hat auf die Rückfrage noch nicht geantwortet. Warte seine Antwort ab, bevor du es erneut versuchst.'
    }
  }

  if (isNegation(turn.lastUserText)) {
    challenges.delete(argsHash)
    return {
      ok: false,
      reason:
        'Der Nutzer hat abgelehnt. Führe die Aktion nicht aus und frage nicht noch einmal danach.'
    }
  }

  if (!isAffirmation(turn.lastUserText)) {
    return { ok: false, reason: 'Keine eindeutige Zustimmung. Lass die Rückfrage offen und bitte um ein ausdrückliches Ja oder Nein.' }
  }

  challenges.delete(argsHash)
  return { ok: true }
}

/**
 * Eine klare Ablehnung verwirft den Vorgang; unklare Antworten lassen ihn offen.
 */
function isNegation(text: string): boolean {
  const t = text.toLowerCase().trim()
  if (!t) return false
  // Wortgrenzen über Buchstaben aller Schriften statt `\b`: Das kennt nur
  // a–z, und für „ö" gibt es dort keine Grenze. Ein schlichtes „Nö." galt
  // deshalb als Zustimmung — und die Aktion lief.
  return /(?<![\p{L}\p{N}])(nein|ne+|nö+|nope|no|nicht|lass|stopp?|abbrechen|abbruch|vergiss|doch nicht|lieber nicht|warte)(?![\p{L}\p{N}])/u.test(
    t
  )
}

/** Only unambiguous, standalone approvals authorize an external action. */
export function isAffirmation(text: string): boolean {
  const t = text.toLowerCase().trim().replace(/[.!]+$/u, '').trim()
  return /^(ja(?: bitte| gerne| gern| mach das| mach| tu das| genau)?|jawohl|genau|okay|ok|einverstanden|mach das|tu das|passt|yes|go ahead)$/u.test(t)
}

function pruneChallenges(): void {
  const cutoff = Date.now() - CHALLENGE_TTL_MS
  for (const [key, value] of challenges) {
    if (value.issuedAt < cutoff) challenges.delete(key)
  }
  const grantCutoff = Date.now() - GRANT_TTL_MS
  for (const [key, issuedAt] of grants) {
    if (issuedAt < grantCutoff) grants.delete(key)
  }
}

/** Not-Aus: alle offenen Rückfragen und erteilten Zustimmungen verwerfen. */
export function clearChallenges(): void {
  challenges.clear()
  grants.clear()
}

export function isHardDenied(toolName: string): boolean {
  return HARD_DENY.has(toolName)
}

export function hasOpenChallenge(): boolean {
  pruneChallenges()
  return challenges.size > 0
}
