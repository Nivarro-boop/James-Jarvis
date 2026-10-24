import * as SecureStore from 'expo-secure-store'
import type { WakeTarget } from '../modules/jarvis-wake'
import { parsePairing, type Pairing } from './pairing'

/**
 * Kopplung und Weckziel liegen im Schlüsselbund, nicht im WebView-Speicher:
 * Die Marke öffnet einen Rechner, der Mails verschickt.
 */
const PAIRING = 'james.pairing'
const WAKE = 'james.wake'

export async function loadPairing(): Promise<Pairing | null> {
  const raw = await SecureStore.getItemAsync(PAIRING)
  if (!raw) return null
  const result = parsePairing(raw)
  return result.ok ? result.pairing : null
}

export async function savePairing(pairing: Pairing): Promise<void> {
  await SecureStore.setItemAsync(PAIRING, pairing.url)
}

export async function forget(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRING)
  await SecureStore.deleteItemAsync(WAKE)
}

const MAC = /^[0-9a-f]{2}([:-]?[0-9a-f]{2}){5}$/i
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/

/** Nimmt nur an, was wirklich nach Weckziel aussieht — die Daten kommen aus der WebView. */
export function asWakeTarget(value: unknown): WakeTarget | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const mac = typeof v.mac === 'string' ? v.mac.trim() : ''
  const broadcast = typeof v.broadcast === 'string' ? v.broadcast.trim() : ''
  const address = typeof v.address === 'string' ? v.address.trim() : ''
  if (!MAC.test(mac) || !IPV4.test(broadcast)) return null
  return { mac, broadcast, address: IPV4.test(address) ? address : '' }
}

export async function loadWake(): Promise<WakeTarget | null> {
  const raw = await SecureStore.getItemAsync(WAKE)
  if (!raw) return null
  try {
    return asWakeTarget(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function saveWake(target: WakeTarget): Promise<void> {
  await SecureStore.setItemAsync(WAKE, JSON.stringify(target))
}
