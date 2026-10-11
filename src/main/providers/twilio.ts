import { getSecret, hasSecret } from '../secrets/keystore'
import { findContacts, listContacts } from '../db'
import { getSettings } from '../store/settings'
import { PHONE_COUNTRIES, type PhoneCountry, type TwilioAccountInfo } from '@shared/types'
import { prepareConversation } from '../telephony'
import { createStateGate } from '@shared/stateGate'

/**
 * Twilio API Integration für Anrufe und SMS.
 *
 * Verwendet native Node fetch API mit Basic Authentication.
 */

/** Wie lange ein Aufruf an Twilio höchstens dauern darf. */
const TWILIO_TIMEOUT_MS = 15_000

/**
 * Ein Aufruf an Twilio, mit Zeitgrenze und abbrechbar.
 *
 * Diese Datei war die einzige im Projekt, die ohne `signal` ins Netz ging —
 * überall sonst steht eine Grenze, von den zwei Sekunden für Ollama bis zu den
 * fünfzehn für die Schlüsselprüfung. Ohne sie wartet `fetch` bis zu Undicis
 * Vorgabe von fünf Minuten, und das ist hier nicht bloß langsam:
 *
 * Ein hängender Anruf lässt `runTool` nie zurückkehren. Damit leert sich
 * `running` nicht, der Kristall bleibt auf "arbeitet", das `Promise.all` in
 * `LiveSession.handleToolCalls` löst nie auf, es geht keine `functionResponse`
 * hinaus — und James verstummt mitten im Zug. Dreimal Escape half nicht: Der
 * Not-Aus bricht den Controller ab, aber ein `fetch` ohne `signal` merkt davon
 * nichts, `hasRunningTools()` bleibt wahr, und die Escape-Taste blieb dem
 * ganzen Rechner entzogen, solange das dauerte.
 *
 * Deshalb beides: eine eigene Grenze, und der Griff des Aufrufers dazu.
 * `AbortSignal.any` lässt den ersten von beiden gewinnen.
 */
async function twilioFetch(
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<Response> {
  const timeout = AbortSignal.timeout(TWILIO_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout
    })
  } catch (err) {
    // Ein Abbruch kommt als AbortError oder TimeoutError herein. Beides würde
    // sonst als "This operation was aborted" beim Nutzer landen — richtig, aber
    // auf Englisch und ohne zu sagen, was er davon halten soll.
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      if (signal?.aborted) throw new Error('Vom Nutzer abgebrochen.')
      throw new Error(
        'Twilio hat innerhalb von fünfzehn Sekunden nicht geantwortet. ' +
          'Meist steht das für eine gestörte Internetverbindung — später noch einmal versuchen.'
      )
    }
    throw err
  }
}

/**
 * Twilios Antwort lesen, auch wenn sie kein JSON ist.
 *
 * Eigentlich antwortet die API immer mit JSON. "Eigentlich" ist das Wort, das
 * man bereut, wenn dazwischen ein Proxy, ein Captive Portal oder eine halb
 * abgebrochene Leitung sitzt — dann kommt HTML oder gar nichts, und
 * `response.json()` wirft einen englischen Syntaxfehler, der nichts mit dem
 * eigentlichen Problem zu tun hat. Diese Funktion macht daraus in beiden
 * Fällen eine Meldung, mit der der Nutzer etwas anfangen kann.
 */
async function readTwilioJson(response: Response): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  let data: Record<string, unknown> = {}
  try {
    data = (await response.json()) as Record<string, unknown>
  } catch {
    if (!response.ok) {
      throw new Error(
        `Twilio hat mit Status ${response.status} geantwortet, aber ohne lesbaren Inhalt. ` +
          'Meist steht ein Proxy oder eine gestörte Verbindung dazwischen — später noch einmal versuchen.'
      )
    }
    // Erfolg ohne Inhalt: ungewöhnlich, aber kein Fehler.
    return { ok: true, data }
  }
  return { ok: response.ok, data }
}

/** Eine Zeichenkette aus einer JSON-Antwort holen — oder nichts, wenn keine dasteht. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export interface TwilioCallOptions {
  to: string
  message?: string
  twiml?: string
  /**
   * Ein Gespräch statt einer Ansage.
   *
   * Dann geht kein fertiges TwiML mit, sondern eine Adresse: Twilio holt sich
   * die Anweisung beim Abheben von diesem Rechner ab und öffnet danach den
   * Medienstrom. Braucht den Telefondienst und einen Tunnel — siehe
   * `telephony/callServer.ts`.
   */
  conversation?: boolean
  /**
   * Der Griff des Not-Aus.
   *
   * `runTool` reicht ihn jedem Werkzeug herein, und dreimal Escape bricht ihn
   * ab. Ohne dass er bis hierher durchkommt, endet der Abbruch am `fetch`: Die
   * Anfrage läuft weiter, das Werkzeug gilt weiter als beschäftigt, und der
   * Not-Aus hat genau das nicht getan, wofür es ihn gibt.
   */
  signal?: AbortSignal
}

export interface TwilioSmsOptions {
  to: string
  message: string
  /** Siehe `TwilioCallOptions.signal` — der Griff des Not-Aus. */
  signal?: AbortSignal
}

export interface TwilioCallResult {
  ok: boolean
  callSid?: string
  to?: string
  from?: string
  status?: string
  error?: string
}

export interface TwilioSmsResult {
  ok: boolean
  messageSid?: string
  to?: string
  from?: string
  status?: string
  error?: string
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function dialCodeOf(country: PhoneCountry): string {
  return PHONE_COUNTRIES.find((c) => c.code === country)?.dial ?? '+43'
}

function configuredCountry(): PhoneCountry {
  return getSettings().telephony?.country ?? 'AT'
}

/**
 * Eine beliebig notierte Nummer in das Format bringen, das Twilio verlangt.
 *
 * Twilio nimmt ausschließlich E.164 — `+` und dann Land, Vorwahl, Anschluss,
 * ohne Trennzeichen und ohne die nationale Verkehrsausscheidungsziffer. Alles
 * andere lehnt es mit Fehler 21211 ab, dessen Text den Grund nicht nennt.
 *
 * Der Knackpunkt ist die führende Null. Sie ist keine Ziffer der Nummer,
 * sondern ein Wählzeichen für "jetzt kommt eine Vorwahl", und sie muss beim
 * Umsetzen wegfallen: aus `0664 1234567` wird `+436641234567`, nicht
 * `+4306641234567`. Welches Land davorgehört, steht in den Einstellungen —
 * aus der Ziffernfolge allein ist es nicht zu erraten.
 */
export function normalizePhone(raw: string, country: PhoneCountry = configuredCountry()): string | null {
  // Alles, was beim Notieren üblich ist, aber nicht zur Nummer gehört:
  // Leerzeichen, Klammern, Striche, Schrägstriche, das Präfix "tel:".
  const cleaned = raw.trim().replace(/^tel:/i, '').replace(/[^\d+]/g, '')
  if (cleaned.length === 0) return null

  const dial = dialCodeOf(country)
  let e164: string

  if (cleaned.startsWith('+')) {
    e164 = cleaned
  } else if (cleaned.startsWith('00')) {
    // Internationale Vorwahl in europäischer Schreibweise.
    e164 = '+' + cleaned.slice(2)
  } else if (cleaned.startsWith('0')) {
    // National notiert: führende Null weg, Landesvorwahl davor.
    e164 = dial + cleaned.slice(1)
  } else if (cleaned.startsWith(dial.slice(1))) {
    // Schon mit Landesvorwahl, nur ohne Plus — etwa "436641234567".
    e164 = '+' + cleaned
  } else {
    // Ohne Null und ohne Landesvorwahl: eine Nummer im eigenen Land, bei der
    // jemand die Null weggelassen hat.
    e164 = dial + cleaned
  }

  // Ein zweites Plus mitten in der Nummer wäre ein Tippfehler, kein Format.
  e164 = '+' + e164.slice(1).replace(/\+/g, '')

  // E.164 erlaubt höchstens fünfzehn Ziffern; unter sieben ist keine
  // vollständige Rufnummer, sondern eine Kurzwahl oder ein Vertipper.
  const digits = e164.slice(1)
  if (digits.length < 7 || digits.length > 15) return null

  return e164
}

/**
 * Der Kontakt, der den Nutzer selbst meint.
 *
 * Erkannt wird er am Namen oder an einer Notiz — und ersatzweise daran, dass
 * er der einzige Eintrag mit Telefonnummer ist. Diese Zuordnung entschied
 * bisher nur, wen "ruf mich an" meint. Seit James auch Anrufe annimmt,
 * entscheidet sie mehr: ob am anderen Ende jemand ist, dem der Kalender
 * vorgelesen werden darf, oder jemand, der bloß im Adressbuch steht.
 *
 * ── Warum `strict` ──
 *
 * Genau deshalb gibt es die Ersatzregel nicht mehr überall. Sie ist eine
 * Vermutung, und für "ruf mich an" ist sie eine gute: Wer einen einzigen
 * Kontakt mit Nummer angelegt hat, hat höchstwahrscheinlich sich selbst
 * eingetragen, und rät James falsch, merkt er es sofort — er hat den Anruf ja
 * ausgelöst.
 *
 * Bei einem eingehenden Anruf steht dieselbe Vermutung auf dem Kopf. Da fragt
 * niemand nach, da ruft jemand an. Ist der einzige Eintrag nicht der Nutzer,
 * sondern die Werkstatt, bekäme die Werkstatt den Kalender vorgelesen, das
 * Gedächtnis dazu — und niemand erführe davon. Eine Bequemlichkeit, die als
 * Rechtevergabe missverstanden wird, ist keine mehr wert als das, was sie
 * hergibt. Deshalb verlangt der eingehende Weg die ausdrückliche Markierung.
 */
export function ownerContact(strict = false): { phone: string; name: string } | null {
  const all = listContacts().filter((c) => Boolean(c.phone))
  const marked = all.find(
    (c) =>
      ['ich', 'me', 'nutzer', 'owner'].includes(c.name.toLowerCase()) ||
      (c.note?.toLowerCase().includes('nutzer') ?? false)
  )
  const self = marked ?? (strict ? null : all.length === 1 ? all[0] : null)
  if (!self) return null
  const phone = normalizePhone(self.phone)
  return phone ? { phone, name: self.name } : null
}

/**
 * Ist diese Nummer der Nutzer selbst? Erwartet E.164 oder etwas, das sich dazu
 * machen lässt.
 *
 * `strict` reicht bis zu `ownerContact` durch und ist dort erklärt. Der
 * eingehende Anruf setzt es, der ausgehende nicht.
 */
export function isOwnerPhone(phone: string, strict = false): boolean {
  const owner = ownerContact(strict)
  if (!owner) return false
  const normalized = normalizePhone(phone)
  return Boolean(normalized) && normalized === owner.phone
}

/**
 * Löst Namen, "mich" oder Telefonnummern auf.
 */
export function resolvePhoneNumber(toOrName: string): { phone: string; name?: string } | null {
  const trimmed = toOrName.trim()

  // Direkte Telefonnummer (z. B. "+491701234567", "0664 123 45 67", "00436641234")
  if (/^\+?[0-9()/\s-]{6,}$/.test(trimmed)) {
    const phone = normalizePhone(trimmed)
    return phone ? { phone } : null
  }

  const lower = trimmed.toLowerCase()
  const isMeQuery = ['mich', 'me', 'mir', 'mein handy', 'meine nummer'].includes(lower)

  if (isMeQuery) {
    const owner = ownerContact()
    if (owner) return owner
  }

  const hits = findContacts(trimmed).filter((c) => Boolean(c.phone))
  if (hits.length > 0) {
    const exact = hits.find((c) => c.name.toLowerCase() === lower)
    const contact = exact || hits[0]
    const phone = normalizePhone(contact.phone)
    if (phone) return { phone, name: contact.name }
  }

  return null
}

/**
 * Warum eine Eingabe nicht zu einer Nummer wurde.
 *
 * Die alte Meldung nannte beide Möglichkeiten in einem Satz und half damit bei
 * keiner. Wer einen Namen gesagt hat, muss einen Kontakt anlegen; wer eine
 * Nummer getippt hat, hat sich vertippt oder das Land steht falsch. Das sind
 * zwei verschiedene Handgriffe.
 */
function unresolvableHint(input: string): string {
  const looksNumeric = /^\+?[0-9()/\s-]{4,}$/.test(input.trim())
  const country = configuredCountry()
  if (looksNumeric) {
    return (
      `"${input}" ergibt keine gültige Rufnummer. Eingestellt ist ${country} ` +
      `(${dialCodeOf(country)}) — steht das Land in den Einstellungen richtig?`
    )
  }
  return `Für "${input}" gibt es im Adressbuch keinen Kontakt mit Telefonnummer.`
}

export function isTwilioConfigured(): boolean {
  return (
    hasSecret('twilioAccountSid') &&
    (hasSecret('twilioAuthToken') || (hasSecret('twilioApiKeySid') && hasSecret('twilioApiSecret'))) &&
    hasSecret('twilioPhoneNumber')
  )
}

function getCredentials() {
  const accountSid = getSecret('twilioAccountSid')
  const authToken = getSecret('twilioAuthToken')
  const apiKeySid = getSecret('twilioApiKeySid')
  const apiSecret = getSecret('twilioApiSecret')
  const fromNumber = getSecret('twilioPhoneNumber')

  if (!accountSid) {
    throw new Error('Twilio Account SID fehlt in den Zugängen.')
  }
  if (!fromNumber) {
    throw new Error('Twilio Telefonnummer fehlt in den Zugängen.')
  }

  // Nur als Paar: API-Key-SID mit API-Secret, sonst Account-SID mit Auth
  // Token. Gemischt (Key-SID mit Auth Token oder Account-SID mit API-Secret)
  // lehnt Twilio ab — „The authorization with Key failed". Genau das passierte,
  // sobald von einem Key-Paar nur eine Hälfte eingetragen war.
  const useKey = Boolean(apiKeySid && apiSecret)
  const username = useKey ? apiKeySid! : accountSid
  const password = useKey ? apiSecret! : authToken

  if (!password) {
    throw new Error(
      apiKeySid || apiSecret
        ? 'Twilio: API-Key-SID und API-Secret gehören zusammen — eins davon fehlt, und ein Auth Token ist auch nicht eingetragen.'
        : 'Twilio Auth Token fehlt in den Zugängen.'
    )
  }

  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`

  return {
    accountSid,
    fromNumber,
    authHeader
  }
}

const AUTH_REFUSED =
  'Twilio lehnt die Zugangsdaten ab. Prüfe in den Zugängen Account SID und Auth Token — ' +
  'oder, falls ein API-Key benutzt wird, API-Key-SID und API-Secret: Beide müssen zusammengehören ' +
  'und zum selben Konto gehören.'

/**
 * Was zuletzt über den Eingangs-Webhook ins Protokoll ging.
 *
 * Wer die Zugänge nicht korrigiert, bekommt bei jedem Start und bei jedem
 * Prüfen denselben Fehler — als Protokollzeile reicht er einmal je Stunde.
 */
const quiet = createStateGate(60 * 60 * 1000)

/**
 * Twilios Fehlernummern in Sätze übersetzen, die sagen, was zu tun ist.
 *
 * Twilio antwortet mit Meldungen wie "The number +43… is unverified" und einem
 * Link auf eine englische Hilfeseite. Der eigentliche Grund — das Konto ist ein
 * Testkonto — steht dort nicht im ersten Satz, und genau der entscheidet, ob
 * jemand seine Nummer verifiziert oder Guthaben auflädt.
 */
export function friendlyTwilioError(raw: unknown, status: number): string {
  const data =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const code = typeof data.code === 'number' ? data.code : undefined
  // Mit einem API-Key antwortet Twilio bei falschem Paar mit „The authorization
  // with Key failed“ — Status 401, aber ohne die Fehlernummer 20003. Ohne diese
  // Zeile landete der englische Satz unübersetzt beim Nutzer und im Protokoll.
  if (code === undefined && (status === 401 || /authorization with key failed/i.test(str(data.message) ?? ''))) {
    return AUTH_REFUSED
  }
  switch (code) {
    case 21219:
    case 21608:
      return (
        'Das ist ein Twilio-Testkonto. Damit lassen sich nur Nummern erreichen, die in der ' +
        'Twilio-Konsole unter "Verified Caller IDs" bestätigt wurden. Bestätige die Zielnummer ' +
        'dort — oder lade das Konto auf, dann fällt die Beschränkung weg.'
      )
    case 21215:
    case 21216:
      return (
        'Für dieses Land sind Anrufe im Twilio-Konto nicht freigeschaltet. In der Konsole unter ' +
        'Voice → Geographic Permissions das Zielland einschalten.'
      )
    case 21211:
    case 21214:
      return (
        'Twilio hält die Zielnummer für ungültig. Prüfe die Landesvorwahl in den Einstellungen — ' +
        'eine national notierte Nummer wird mit dem dort eingestellten Land umgesetzt.'
      )
    case 21210:
    case 21212:
      return (
        'Die Absendernummer wird von Twilio nicht akzeptiert. Sie muss eine Nummer sein, die dem ' +
        'Konto gehört, im Format +43…'
      )
    case 20003:
      return AUTH_REFUSED
    case 21606:
      return 'Die Absendernummer kann keine SMS verschicken. Twilio-Nummern aus den USA erreichen europäische Mobilnummern oft nicht.'
    default:
      return str(data.message) || str(data.detail) || `Twilio API Fehler (${status})`
  }
}

/**
 * Was für ein Konto das ist.
 *
 * Ohne diese Auskunft ist ein Testkonto von außen nicht zu erkennen: Anrufe
 * gehen raus, Twilio meldet `completed`, und trotzdem hört der Angerufene
 * zuerst eine englische Ansage und muss eine Taste drücken, bevor die eigene
 * Nachricht kommt. Wer das nicht weiß, sucht den Fehler im eigenen Code.
 */
export async function twilioAccountInfo(): Promise<TwilioAccountInfo> {
  let credentials: ReturnType<typeof getCredentials>
  try {
    credentials = getCredentials()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const { accountSid, fromNumber, authHeader } = credentials

  const get = async (path: string): Promise<Record<string, unknown>> => {
    const response = await twilioFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}${path}`,
      { headers: { Authorization: authHeader } }
    )
    const data = (await readTwilioJson(response)).data
    if (!response.ok) {
      throw new Error(friendlyTwilioError(data, response.status))
    }
    return data
  }

  try {
    const account = await get('.json')
    const trial = account.type === 'Trial'

    let balance: string | undefined
    let currency: string | undefined
    try {
      const bal = await get('/Balance.json')
      balance = String(bal.balance ?? '')
      currency = String(bal.currency ?? '')
    } catch {
      // Guthaben ist ein Zusatz, kein Grund die ganze Auskunft fallenzulassen.
    }

    let verifiedNumbers: string[] | undefined
    if (trial) {
      try {
        const list = (await get('/OutgoingCallerIds.json?PageSize=50')) as {
          outgoing_caller_ids?: { phone_number?: string }[]
        }
        verifiedNumbers = (list.outgoing_caller_ids ?? [])
          .map((c) => c.phone_number)
          .filter((n): n is string => Boolean(n))
      } catch {
        // Auch hier: lieber ohne Liste berichten als gar nicht.
      }
    }

    return {
      ok: true,
      trial,
      friendlyName: typeof account.friendly_name === 'string' ? account.friendly_name : undefined,
      balance,
      currency,
      fromNumber,
      verifiedNumbers
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Die Adresse eintragen, an die Twilio eingehende Anrufe meldet.
 *
 * Ohne das gibt es keine eingehenden Anrufe: Twilio muss wissen, wen es
 * fragen soll, wenn jemand die Nummer wählt. In der Konsole ließe sich das
 * von Hand eintragen — aber ein cloudflared-Quick-Tunnel bekommt bei jedem
 * Start eine neue Adresse, und ein von Hand eingetragener Webhook zeigte
 * spätestens beim zweiten Start ins Leere. Deshalb wird sie hier bei jedem
 * Hochfahren nachgezogen.
 *
 * Das ist ein Schreibzugriff auf die Twilio-Konfiguration des Nutzers, und er
 * passiert nur, wenn eingehende Anrufe in den Einstellungen eingeschaltet
 * sind. Steht die richtige Adresse schon dort, wird nichts geschrieben.
 */
export async function setIncomingWebhook(publicUrl: string): Promise<{ ok: boolean; error?: string }> {
  let credentials: ReturnType<typeof getCredentials>
  try {
    credentials = getCredentials()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const { accountSid, fromNumber, authHeader } = credentials
  const voiceUrl = `${publicUrl.replace(/\/+$/, '')}/twilio/incoming`

  try {
    const listRes = await twilioFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json` +
        `?PhoneNumber=${encodeURIComponent(fromNumber)}`,
      { headers: { Authorization: authHeader } }
    )
    const list = (await readTwilioJson(listRes)).data as {
      incoming_phone_numbers?: { sid?: string; voice_url?: string; voice_method?: string }[]
    }
    if (!listRes.ok) {
      return webhookRefused(friendlyTwilioError(list, listRes.status))
    }

    const number = list.incoming_phone_numbers?.[0]
    if (!number?.sid) {
      return {
        ok: false,
        error:
          `Die Nummer ${fromNumber} gehört diesem Twilio-Konto nicht. Eingehende Anrufe gehen nur ` +
          'auf eine gekaufte Twilio-Nummer — eine bloß verifizierte Nummer reicht dafür nicht.'
      }
    }

    // Steht es schon richtig, nichts anfassen. Spart einen Schreibzugriff bei
    // jedem Start, wenn die Adresse fest ist.
    if (number.voice_url === voiceUrl && number.voice_method === 'POST') {
      quiet.forget('webhook')
      return { ok: true }
    }

    const body = new URLSearchParams({ VoiceUrl: voiceUrl, VoiceMethod: 'POST' })
    const res = await twilioFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${number.sid}.json`,
      {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      }
    )
    const data = (await readTwilioJson(res)).data
    if (!res.ok) return webhookRefused(friendlyTwilioError(data, res.status))

    quiet.forget('webhook')
    console.info(`[telefonie] Twilio meldet eingehende Anrufe jetzt an ${voiceUrl}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Twilio hat den Webhook abgelehnt: der Grund geht zurück und, einmal je Zustand, ins Protokoll. */
function webhookRefused(error: string): { ok: false; error: string } {
  if (quiet.changed('webhook', error)) console.warn('[telefonie] Eingehende Anrufe nicht erreichbar:', error)
  return { ok: false, error }
}

/**
 * Die Adresse wieder austragen.
 *
 * Wird gerufen, wenn eingehende Anrufe abgeschaltet werden. Bliebe sie
 * stehen, zeigte sie auf einen Tunnel, den es nicht mehr gibt — der Anrufer
 * hörte eine Twilio-Fehlermeldung statt eines Besetztzeichens.
 */
export async function clearIncomingWebhook(): Promise<void> {
  try {
    const { accountSid, fromNumber, authHeader } = getCredentials()
    const listRes = await twilioFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json` +
        `?PhoneNumber=${encodeURIComponent(fromNumber)}`,
      { headers: { Authorization: authHeader } }
    )
    const list = (await readTwilioJson(listRes)).data as {
      incoming_phone_numbers?: { sid?: string; voice_url?: string }[]
    }
    const number = list.incoming_phone_numbers?.[0]
    if (!number?.sid) return
    if (!String(number.voice_url ?? '').includes('/twilio/incoming')) return

    await twilioFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${number.sid}.json`,
      {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ VoiceUrl: '' }).toString()
      }
    )
  } catch (err) {
    // Beim Abschalten ist das kein Grund, irgendetwas anzuhalten.
    console.info('[telefonie] Webhook-Austragung:', String(err).slice(0, 200))
  }
}

/**
 * Tätigt einen ausgehenden Anruf über Twilio.
 */
export async function makeTwilioCall(options: TwilioCallOptions): Promise<TwilioCallResult> {
  const { accountSid, fromNumber, authHeader } = getCredentials()

  const targetPhone = resolvePhoneNumber(options.to)?.phone ?? null

  if (!targetPhone) {
    return { ok: false, error: unresolvableHint(options.to) }
  }

  const bodyParams = new URLSearchParams()
  bodyParams.append('To', targetPhone)
  bodyParams.append('From', fromNumber)

  if (options.conversation) {
    // Gespräch: Twilio bekommt eine Adresse statt eines Textes und holt sich
    // die Anweisung beim Abheben ab. Alles Weitere steht in `telephony/`.
    let url: string
    try {
      url = await prepareConversation(targetPhone, options.message)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    bodyParams.append('Url', url)
    bodyParams.append('Method', 'POST')
  } else {
    let twiml = options.twiml
    if (!twiml) {
      // Gesprochen wird das wörtlich von Twilio, nicht vom Modell — die Haltung
      // aus dem System-Prompt greift hier nicht. Deshalb ohne Anrede: Wer hier
      // abhebt, ist nicht zwingend Void, und geduzt wird am Telefon niemand.
      const spokenMessage = options.message || 'Hallo, hier spricht James, ein sprachgesteuerter Assistent.'
      const voice = getSettings().telephony?.voice || 'Polly.Vicki'
      twiml = `<Response><Say voice="${escapeXml(voice)}" language="de-DE">${escapeXml(spokenMessage)}</Say></Response>`
    }
    bodyParams.append('Twiml', twiml)
  }

  try {
    const response = await twilioFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: bodyParams.toString()
      },
      options.signal
    )

    const data = (await readTwilioJson(response)).data

    if (!response.ok) {
      return {
        ok: false,
        error: friendlyTwilioError(data, response.status)
      }
    }

    return {
      ok: true,
      callSid: str(data.sid),
      to: str(data.to),
      from: str(data.from),
      status: str(data.status)
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Sendet eine SMS über Twilio.
 */
export async function sendTwilioSms(options: TwilioSmsOptions): Promise<TwilioSmsResult> {
  const { accountSid, fromNumber, authHeader } = getCredentials()

  const targetPhone = resolvePhoneNumber(options.to)?.phone ?? null

  if (!targetPhone) {
    return { ok: false, error: unresolvableHint(options.to) }
  }

  const bodyParams = new URLSearchParams()
  bodyParams.append('To', targetPhone)
  bodyParams.append('From', fromNumber)
  bodyParams.append('Body', options.message)

  try {
    const response = await twilioFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: bodyParams.toString()
      },
      options.signal
    )

    const data = (await readTwilioJson(response)).data

    if (!response.ok) {
      return {
        ok: false,
        error: friendlyTwilioError(data, response.status)
      }
    }

    return {
      ok: true,
      messageSid: str(data.sid),
      to: str(data.to),
      from: str(data.from),
      status: str(data.status)
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
