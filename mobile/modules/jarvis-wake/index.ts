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
