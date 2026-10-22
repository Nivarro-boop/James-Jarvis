import type { IncomingMessage, ServerResponse } from 'node:http'
import { app } from 'electron'
import { getSecret } from '../secrets/keystore'
import { runAlexaTurn } from './turn'
import { verifyAlexaRequest, type AlexaEnvelope } from './verify'
import { createRequestDeduper, RequestDeduperFullError } from './idempotency'
import { createRequestJournal, ReplayAfterRestartError, RequestJournalError } from './requestJournal'

/**
 * Der Endpunkt, den Amazon anruft.
 *
 * Der Ablauf ist kurz: Der Nutzer sagt „Alexa, frag James, …", Amazon
 * transkribiert, schickt die Wörter als JSON hierher, bekommt einen Satz
 * zurück und liest ihn vor. Alles Interessante steckt in dem, was drumherum
 * eingehalten werden muss.
 *
 * ── Das Weckwort bleibt „Alexa" ──
 *
 * Das ist die eine Einschränkung, die niemand wegprogrammieren kann. Amazon
 * lässt Dritte das Weckwort nicht ändern; jede fremde Skill wird über „frag
 * <Name>" angesprochen. Wer „Hey James" sagen will, sagt es dem Rechner —
 * dafür gibt es das Weckwort dort. Der Echo ist die zweite Tür, nicht dieselbe.
 *
 * ── Warum der rohe Rumpf gelesen wird ──
 *
 * Amazon unterschreibt die Bytes, nicht das Objekt. Ein `JSON.parse` mit
 * anschließendem `JSON.stringify` liefert oft ein anderes Byte für Byte
 * gleiches Objekt — und eine Unterschrift, die nicht mehr passt. Deshalb wird
 * hier gesammelt, geprüft, und erst danach ausgewertet.
 */

/** Mehr als das schickt Amazon nie. Alles darüber ist ein Angriff oder ein Fehler. */
const MAX_BODY_BYTES = 128 * 1024
let requestJournal: ReturnType<typeof createRequestJournal> | undefined
function journalForAuthenticatedRequest(): ReturnType<typeof createRequestJournal> {
  // Constructing the handle is cheap; its first disk access is claim(), which
  // only runs after signature, timestamp, skill ID and requestId validation.
  requestJournal ??= createRequestJournal(app.getPath('userData'))
  return requestJournal
}
const requestDeduper = createRequestDeduper({
  maxEntries: 512,
  ttlMs: 10 * 60_000,
  claim: (requestId) => journalForAuthenticatedRequest().claim(requestId)
})

function speech(text: string, endSession: boolean): string {
  return JSON.stringify({
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      /*
       * Die Sitzung bleibt offen, wenn eine Rückfrage sinnvoll ist.
       *
       * Sonst müsste der Nutzer vor jedem Satz wieder „Alexa, frag James"
       * sagen. Offen bleibt sie nur, wenn auch ein Nachsatz kommt — Alexa
       * hört sonst acht Sekunden ins Leere, und das Lämpchen bleibt an.
       */
      ...(endSession
        ? {}
        : {
            reprompt: { outputSpeech: { type: 'PlainText', text: 'Noch etwas?' } }
          }),
      shouldEndSession: endSession
    }
  })
}

/** Den Rumpf einsammeln, mit Deckel. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Rumpf zu groß.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Die Frage aus dem Umschlag holen.
 *
 * Der Slot heißt `frage` und ist im Skill-Bauplan ein `AMAZON.SearchQuery` —
 * der einzige Slottyp, der einen ganzen Satz durchlässt statt ihn gegen eine
 * Werteliste zu prüfen. Ohne ihn käme von „wie wird das Wetter morgen" nur ein
 * Bruchstück an.
 */
function questionOf(envelope: AlexaEnvelope): string {
  const slots = envelope.request?.intent?.slots ?? {}
  const named = slots.frage?.value ?? slots.query?.value ?? slots.text?.value
  return (named ?? '').trim()
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, body: string): void => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
  }

  if (req.method !== 'POST') {
    send(405, JSON.stringify({ error: 'Nur POST.' }))
    return
  }

  let raw: Buffer
  try {
    raw = await readBody(req)
  } catch {
    send(413, JSON.stringify({ error: 'Rumpf zu groß.' }))
    return
  }

  const skillId = getSecret('alexaSkillId') ?? ''
  const check = await verifyAlexaRequest(raw, req.headers, skillId)
  if (!check.ok) {
    /*
     * Abgelehnt wird mit 400 und ohne Einzelheiten.
     *
     * Der Grund steht im Protokoll, wo er hingehört, und nicht in der Antwort:
     * Wer hier klopft und kein Amazon ist, soll nicht auch noch erfahren,
     * woran es gelegen hat.
     */
    console.warn('[alexa] Anfrage abgewiesen:', check.reason)
    send(400, JSON.stringify({ error: 'Nicht zulässig.' }))
    return
  }

  const envelope = JSON.parse(raw.toString('utf8')) as AlexaEnvelope
  const requestId = envelope.request?.requestId
  if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 512) {
    // Alexa IDs are part of the signed payload. Without one an action cannot
    // be safely shared or replayed, so do not dispatch the request to tools.
    send(200, speech('Diese Anfrage hat keine gültige Kennung. Ich habe nichts ausgeführt.', true))
    return
  }

  try {
    const body = await requestDeduper.run(requestId, async () => {
      try {
        return await responseFor(envelope)
      } catch (err) {
        // Preserve a terminal answer for this ID even if execution became
        // ambiguous; Alexa retries must not launch the same work a second time.
        console.error('[alexa] Anfrage fehlgeschlagen:', err)
        return speech('Der Ausgang ist unklar. Ich wiederhole die Aktion nicht automatisch.', true)
      }
    })
    send(200, body)
  } catch (err) {
    if (err instanceof RequestDeduperFullError) {
      send(503, JSON.stringify({ error: 'Vorübergehend ausgelastet; es wurde nichts gestartet.' }))
      return
    }
    if (err instanceof ReplayAfterRestartError) {
      send(200, speech('Diese Anfrage wurde bereits verarbeitet oder ihr Ausgang ist unklar. Ich wiederhole die Aktion nicht.', true))
      return
    }
    if (err instanceof RequestJournalError) {
      console.error('[alexa] Anfragejournal nicht verfügbar:', err)
      send(503, JSON.stringify({ error: 'Die Aktion konnte nicht sicher vorbereitet werden; es wurde nichts gestartet.' }))
      return
    }
    throw err
  }
}

async function responseFor(envelope: AlexaEnvelope): Promise<string> {
  const type = envelope.request?.type ?? ''
  const intent = envelope.request?.intent?.name ?? ''

  // „Alexa, öffne James" ohne Frage dahinter.
  if (type === 'LaunchRequest') {
    return speech('Ich bin da. Was brauchst du?', false)
  }

  if (type === 'SessionEndedRequest') {
    return speech('', true)
  }

  if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent') {
    return speech('Bis dann.', true)
  }

  if (intent === 'AMAZON.HelpIntent') {
    return speech(
      'Sag einfach, was du wissen willst. Zum Beispiel: frag James, was heute ansteht. ' +
        'Oder: sag James, er soll Musik anmachen.',
      false
    )
  }

  const question = questionOf(envelope)
  if (!question) {
    return speech('Das habe ich nicht verstanden. Sag es nochmal in einem Satz.', false)
  }

  const answer = await runAlexaTurn(question)
  // Never restart a timed-out/over-budget turn: the first attempt may already
  // have completed an external action, and its outcome can be uncertain.
  return speech(answer.text, false)
}

/**
 * Der Pfad, unter dem Amazon anklopft.
 *
 * Angemeldet wird er am öffentlichen Server der Telefonie, nicht an einem
 * eigenen — die Begründung steht bei `registerPublicRoute`: Es gibt nur einen
 * Weg von außen herein, und zwei Dienste, die sich je einen Tunnel aufmachen,
 * nehmen sich gegenseitig den Verkehr weg.
 */
export const ALEXA_PATH = '/alexa'

/**
 * Die Anfrage bearbeiten — als Route, nicht als eigener Server.
 *
 * Ein Fehler wird zu einer sprechbaren Antwort statt zu einem 500: Amazon
 * macht aus jedem Fehlercode beim Nutzer „James antwortet gerade nicht", und
 * das ist die eine Rückmeldung, die nichts sagt.
 */
export const alexaRoute = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  try {
    await handle(req, res)
  } catch (err) {
    console.error('[alexa] Anfrage fehlgeschlagen:', err)
    if (res.headersSent) return
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(speech('Da ist mir etwas dazwischengekommen. Versuch es nochmal.', true))
  }
}
