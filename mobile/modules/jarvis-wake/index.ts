import { requireOptionalNativeModule } from 'expo'

export interface WakeTarget {
  mac: string
  broadcast: string
  /** Letzte Adresse des Rechners; Ausweichweg, wenn iOS den Broadcast sperrt. */
  address: string
}

interface NativeWake {
  configureWatch?(link: string | null): Promise<void>
  watchStatus?(): { supported: boolean; paired?: boolean; installed?: boolean; reachable?: boolean; configured?: boolean }
  wake(mac: string, broadcast: string, address: string): Promise<void>
  healthAvailable?(): boolean
  requestHealth?(): Promise<boolean>
  healthSummary?(days: number): Promise<Record<string, unknown>>
}

// Fehlt in Expo Go und im Web: Dort gibt es keinen eingebauten UDP-Versand.
const native = requireOptionalNativeModule<NativeWake>('JarvisWake')

export const canWake = native !== null

export async function wake(target: WakeTarget): Promise<void> {
  if (!native) throw new Error('Wecken geht nur in der gebauten App, nicht in Expo Go.')
  await native.wake(target.mac, target.broadcast, target.address ?? '')
}

export async function configureWatch(link: string | null): Promise<void> {
  if (native?.configureWatch) await native.configureWatch(link)
}
export function watchStatus() {
  return native?.watchStatus?.() ?? { supported: false }
}

/** Apple Health gibt es nur in der gebauten App auf einem iPhone, nicht in Expo Go oder auf dem iPad. */
export function healthAvailable(): boolean {
  return native?.healthAvailable?.() ?? false
}

/** Zeigt Apples Freigabedialog. `false`, wenn Health hier nicht geht. */
export async function requestHealth(): Promise<boolean> {
  if (!native?.requestHealth) return false
  return native.requestHealth()
}

/** Tageswerte der letzten sieben Tage, im Format von `src/shared/health.ts` am Rechner. */
export async function healthSummary(): Promise<Record<string, unknown> | null> {
  if (!native?.healthSummary) return null
  return native.healthSummary(7)
}
