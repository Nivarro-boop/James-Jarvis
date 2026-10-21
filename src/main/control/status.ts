import type { IpcInvokeMap } from '@shared/ipc'
import { inputBackendStatus } from '../automation/desktop'
import { isTwilioConfigured } from '../providers/twilio'
import { getSettings } from '../store/settings'
import { telephonyStatus } from '../telephony'

type Status = IpcInvokeMap['control:status']['res']
interface StatusSources {
  phoneConfigured(): boolean
  settings(): { conversation: boolean; incoming: boolean }
  telephony(): Status['telephony']
  computer(): Promise<Status['computer']>
}
const sources: StatusSources = {
  phoneConfigured: isTwilioConfigured,
  settings: () => {
    const phone = getSettings().telephony
    return { conversation: phone?.conversation === true, incoming: phone?.incoming === true }
  },
  telephony: telephonyStatus,
  computer: inputBackendStatus
}

/** Capability probes only: never starts a tunnel, provider call, or desktop action. */
export async function controlStatus(dependencies: StatusSources = sources): Promise<Status> {
  const settings = dependencies.settings()
  const phoneConfigured = dependencies.phoneConfigured()
  const telephony = dependencies.telephony()
  let computer: Status['computer']
  try { computer = await dependencies.computer() }
  catch (error) { computer = { name: 'nicht verfügbar', grund: error instanceof Error ? error.message : String(error) } }
  return { telephony, phoneConfigured, conversationEnabled: settings.conversation,
    incomingEnabled: settings.incoming, computer }
}
