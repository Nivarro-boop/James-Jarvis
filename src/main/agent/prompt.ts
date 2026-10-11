import { systemPromptDe, buildMemoryBlock, buildUnavailableBlock } from '@shared/prompts/system.de'
import { hasSecret } from '../secrets/keystore'
import { baselineMemories } from './memory'
import { getSettings } from '../store/settings'
import { skillIndexForPrompt } from './skills'
import { lazyToolsEnabled } from './tokenSaver'

/**
 * Wie James längere Aufgaben angeht — Plan, Fertigkeiten, Unteragenten.
 *
 * Kurz gehalten, weil es bei jeder Verbindung mitgeht. Die Einzelheiten
 * stehen in den Werkzeugbeschreibungen, die das Modell ohnehin bekommt.
 */
const AGENT_BLOCK = [
  '',
  '## Wie du längere Aufgaben angehst',
  '',
  '- Nutze plan_update bei längeren Aufgaben, deren Fortschritt der Nutzer verfolgen muss.',
  '  Bündele Updates; einfache Handgriffe brauchen keinen zusätzlichen Planaufruf.',
  '- Passt eine deiner Fertigkeiten, lies sie mit skill_view und folge ihr. Lief es anders als',
  '  beschrieben, verbessere sie danach mit skill_save.',
  '- delegate_tasks lohnt sich für umfangreiche unabhängige Recherchen oder auf ausdrücklichen Wunsch.',
  '  Erledige kurze Aufgaben selbst; vermeide doppelte Modellarbeit.',
  '- Bei Fragen nach früheren Gesprächen nutze session_search statt Inhalte zu erfinden.',
  '- Für Erinnerungen an einen Zeitpunkt nutze reminder_set; für spätere ausführbare Aufträge schedule_task.',
  '- Prüfe Werkzeugergebnisse. Wiederhole keinen unveränderten fehlgeschlagenen Aufruf endlos; korrigiere den Ansatz.',
  '- Führe ausführbare Aufträge mit Werkzeugen aus. Kündige Arbeit nicht nur an: arbeite bis zum Ergebnis oder einer konkreten Blockade.',
  '- Bei mehreren Schritten halte den Plan aktuell: markiere laufende, erledigte und fehlgeschlagene Schritte ehrlich.',
  '- Berichte zum Schluss das überprüfte Ergebnis und noch offene Schritte. Ein gestartetes Werkzeug ist noch kein erledigter Auftrag.',
  '- Ein neuer Nutzerbeitrag kann den bisherigen Auftrag ändern. Folge der Korrektur; sprich nicht die alte Antwort weiter.',
  ''
].join('\n')

/**
 * Nur nötig, wenn der Sparmodus Werkzeuge nachlädt. Ohne den Satz hält das
 * Modell die kurze Liste für alles, was es kann, und sagt „geht nicht".
 */
const LAZY_TOOLS_BLOCK = [
  '',
  '## Weitere Werkzeuge',
  '',
  'Du siehst nur die häufigsten Werkzeuge direkt. Alles andere (Mail, Einkauf, Dateien, Fenster,',
  'Chrome, Office, WhatsApp, Kontakte, Termine, Orte und Routen, Skills, Unteragenten …) findest du mit tool_search',
  'und rufst es mit tool_use auf. Sag nie, dass du etwas nicht kannst, bevor du gesucht hast.',
  'Werkzeugnamen, die hier im Text vorkommen, rufst du ebenfalls über tool_use auf.',
  ''
].join('\n')

/**
 * Setzt den System-Prompt für die Live-Session zusammen.
 *
 * Der Block über fehlende Zugänge ist wichtiger als er aussieht: ohne ihn
 * behauptet das Modell fröhlich, es könne Mails lesen, obwohl das Tool wegen
 * fehlendem OAuth gar nicht registriert ist.
 */

/**
 * Was ohne den jeweiligen Zugang wirklich wegfällt.
 *
 * Die Formulierungen waren einmal deutlich gröber, und das hat James Dinge
 * ausschlagen lassen, die er konnte. "Gmail" ohne OAuth-Client hieß für ihn:
 * gar kein Gmail — dabei laufen lesen, suchen, öffnen und eine Mail vorbereiten
 * über den Browserweg, der überhaupt keine Einrichtung braucht. Weg ist nur das
 * eigenständige Verschicken.
 *
 * OpenRouter steht bewusst nicht mehr in der Liste: ohne den Zugang übersetzt
 * James über Gemini weiter, es fällt also nichts weg.
 */
const SECRET_LABELS: { key: Parameters<typeof hasSecret>[0]; label: string }[] = [
  { key: 'higgsfield', label: 'das Erzeugen von Bildern und Videos' },
  {
    key: 'googleOAuthClientId',
    label:
      'das eigenständige Verschicken, Beantworten und Archivieren von Mails ' +
      '(Lesen, Suchen, Öffnen und Vorbereiten über den Browser geht weiterhin) ' +
      'sowie der gesamte Kalender — Termine nachsehen, eintragen, verschieben und absagen'
  }
]

/**
 * `lazyTools: false` für Telefon und Alexa: Die deklarieren ihre eigene,
 * feste Werkzeugliste ohne `tool_search` — der Hinweis darauf schickte das
 * Modell dort zu einem Werkzeug, das es nicht gibt.
 */
export function buildSystemPrompt(options: { lazyTools?: boolean } = {}): string {
  const settings = getSettings()
  const lazy = (options.lazyTools ?? true) && lazyToolsEnabled()
  const parts = [systemPromptDe(settings.persona, lazy)]
  parts.push(settings.confirmActions
    ? 'Bestätigungsprofil: Beachte Rückfragen, die ein Werkzeug verlangt.'
    : 'Autonomes Profil: Der Nutzer möchte keine Bestätigungsfragen. Führe seine Aufträge direkt mit den erlaubten Werkzeugen aus, ohne „Soll ich?“ oder eine zweite Freigabe. Gesperrte Werkzeuge bleiben gesperrt. Frage nur nach sachlich fehlenden Angaben, die sich nicht sinnvoll aus dem Kontext ableiten lassen. Behaupte Erfolg erst nach erfolgreichem Werkzeugergebnis.')

  const memories = baselineMemories(settings.tokenSaver.enabled ? 4 : 12)
  if (memories.length > 0) parts.push(buildMemoryBlock(memories))

  parts.push(AGENT_BLOCK)
  if (lazy) parts.push(LAZY_TOOLS_BLOCK)
  const skills = settings.tokenSaver.enabled ? '' : skillIndexForPrompt()
  if (skills) parts.push(skills)
  if (settings.tokenSaver.enabled) parts.push('Sparmodus: Beantworte gewöhnliche Fragen direkt und knapp. Werkzeuge nur, wenn die Antwort oder ein ausdrücklicher Auftrag sie braucht. Keine vorsorglichen Recherchen, Pläne, Lernaufrufe oder Unteragenten. Fertigkeiten bei Bedarf über tool_search und skill_list finden. Melde unerledigte Aufgaben ehrlich; Details auf ausdrücklichen Wunsch vollständig.')

  const missing = SECRET_LABELS.filter((s) => !hasSecret(s.key)).map((s) => s.label)
  if (missing.length > 0) parts.push(buildUnavailableBlock(missing))

  /*
   * Datum und Uhrzeit mitgeben, sonst rechnet das Modell mit seinem
   * Trainingsstand.
   *
   * Die Uhrzeit kam mit dem Kalender dazu. Ohne sie sind „heute noch",
   * „in zwei Stunden" und „heute Nachmittag" nicht auflösbar — und zwar nicht
   * so, dass das Modell nachfragt, sondern so, dass es etwas annimmt.
   *
   * Dass sie veraltet, steht ausdrücklich dabei: Dieser Prompt wird beim
   * Verbindungsaufbau gebaut und dann bis zu einer Viertelstunde weiter
   * benutzt. Ein Modell, das die Zeile für die aktuelle Uhrzeit hält, rechnet
   * am Ende der Sitzung um eine Viertelstunde daneben. Für alles, wo es
   * darauf ankommt, gibt es Werkzeuge, die die echte Uhr lesen.
   */
  const now = new Date()
  const today = now.toLocaleDateString('de-DE', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
  const clock = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  parts.push(
    `\nHeute ist ${today}. Beim Verbindungsaufbau war es ${clock} Uhr (${zone}); seitdem ist ` +
      'Zeit vergangen, verlass dich also nicht auf die Minute genau.\n'
  )

  return parts.join('\n')
}
