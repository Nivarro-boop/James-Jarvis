import type { SipStatus } from '@shared/types'
import { getSettings, onSettingsChanged } from '../../store/settings'
import { getSecret } from '../../secrets/keystore'
import { LiveCall } from '../liveCall'
import { sameAddress, SipPhone, type SipCallHandle } from './phone'

/**
 * Linphone: kostenlos telefonieren zwischen dem Nutzer und James.
 *
 * James meldet sich mit eigenem Konto bei sip.linphone.org an. Der Nutzer hat
 * auf dem iPhone die Linphone-App mit seinem Konto. Ruft er James' Adresse an,
 * nimmt James ab; ist James mit etwas fertig, ruft er die Adresse des Nutzers
 * an, und das iPhone klingelt wie bei einem normalen Anruf.
 *
 * Das Gespräch selbst führt dieselbe `LiveCall` wie bei Twilio — der Ton hat
 * dasselbe Format, nur der Weg dorthin ist ein anderer.
 *
 * Angenommen wird nur, was von der eingetragenen Adresse des Nutzers kommt.
 * Linphone lässt angemeldete Konten nur unter ihrer eigenen Adresse anrufen,
 * die Absenderadresse ist damit belastbar — anders als eine Rufnummer.
 */


let phone: SipPhone | null = null
let status: SipStatus = { enabled: false, registered: false, detail: 'Aus.', inCall: false }
let configKey = ''
/** Was James beim nächsten ausgehenden Anruf als Erstes sagt. */
let nextOpening = ''

function key(): string {
  const s = getSettings().sip
  return JSON.stringify([s.enabled, s.username, s.domain, getSecret('sipPassword') ?? ''])
}

export function startSip(): SipStatus {
  const settings = getSettings().sip
  const password = getSecret('sipPassword')
  configKey = key()
  phone?.stop()
  phone = null

  if (!settings.enabled) {
    status = { enabled: false, registered: false, detail: 'Aus.', inCall: false }
    return status
  }
  if (!settings.username || !settings.domain || !password) {
    status = {
      enabled: true,
      registered: false,
      detail: 'Benutzername, Domain oder Passwort von James’ Linphone-Konto fehlt.',
      inCall: false
    }
    return status
  }

  status = { enabled: true, registered: false, detail: 'Melde an …', inCall: false }
  phone = new SipPhone(
    { username: settings.username, password, domain: settings.domain },
    {
      onIncoming: (from) => {
        const user = getSettings().sip.userAddress
        const allowed = Boolean(user) && sameAddress(from, user)
        console.info(`[sip] Anruf von ${from} — ${allowed ? 'nehme an' : 'abgewiesen (nicht die eingetragene Adresse)'}`)
        return allowed
      },
      onAnswered: (handle, incoming) => attachConversation(handle, incoming),
      onRegistration: (ok, detail) => {
        status = { ...status, registered: ok, detail }
        console.info(`[sip] ${detail}`)
      }
    }
  )
  phone.start()
  return status
}

export function stopSip(): void {
  phone?.stop()
  phone = null
  status = { ...status, registered: false, inCall: false, detail: 'Aus.' }
}

export function sipStatus(): SipStatus {
  return { ...status, inCall: Boolean(phone?.busy), lastCall: phone?.lastCall || undefined }
}

/** Neu anmelden, sobald sich Konto oder Schalter ändern. */
export function watchSipSettings(): void {
  onSettingsChanged(() => {
    if (key() !== configKey) startSip()
  })
}

/**
 * Den Nutzer anrufen. Löst auf, sobald er abgenommen hat — dann läuft das
 * Gespräch schon, und `opening` ist das Erste, was er hört.
 */
export async function callUser(opening: string): Promise<void> {
  const user = getSettings().sip.userAddress.trim()
  if (!phone || !status.registered) {
    throw new Error(status.enabled ? `Linphone ist nicht bereit: ${status.detail}` : 'Linphone ist ausgeschaltet.')
  }
  if (!user) throw new Error('Deine Linphone-Adresse ist nicht eingetragen.')
  nextOpening = opening
  try {
    await phone.call(user.startsWith('sip') ? user : `sip:${user}`)
  } finally {
    nextOpening = ''
  }
}

function attachConversation(handle: SipCallHandle, incoming: boolean): void {
  const opening = incoming
    ? 'Hier ist James. Was brauchst du?'
    : nextOpening || 'Hier ist James. Ich wollte mich bei dir melden.'
  const call = new LiveCall(
    {
      onAudio: (frame) => handle.sendAudio(frame),
      onClear: () => handle.clearAudio(),
      onTranscript: (role, text) => console.info(`[sip] ${role === 'caller' ? 'Nutzer' : 'James'}: ${text.slice(0, 200)}`),
      onClosed: (reason) => {
        console.info(`[sip] Gespräch beendet: ${reason}`)
        handle.hangup()
      }
    },
    opening,
    'Nutzer',
    true,
    getSettings().sip.fullAccess
  )
  handle.onAudio = (audio) => call.pushCallerAudio(audio)
  handle.onEnded = (reason) => call.stop(reason)
  call.start().catch((err) => {
    console.error('[sip] Live-Sitzung ließ sich nicht aufbauen:', err)
    handle.hangup()
  })
}
