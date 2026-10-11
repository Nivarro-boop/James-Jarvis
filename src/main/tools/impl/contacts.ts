import { z } from 'zod'
import { shell } from 'electron'
import type { Contact } from '@shared/types'
import { defineTool, type ToolDefinition } from '../registry'
import { deleteContact, findContacts, listContacts, upsertContact } from '../../db'
import { hasSecret } from '../../secrets/keystore'

/**
 * Das Adressbuch.
 * Enthält Namen, E-Mail-Adressen und Telefonnummern.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PHONE = /^\+?[0-9][0-9 ()\-./\s]{3,}$/

export function looksLikeEmail(value: string): boolean {
  return EMAIL.test(value.trim())
}

function normalizePhone(value: string): string | null {
  const trimmed = value.trim()
  if (!PHONE.test(trimmed)) return null
  const normalized = `${trimmed.startsWith('+') ? '+' : ''}${trimmed.replace(/\D/g, '')}`
  return normalized.length >= 4 ? normalized : null
}

function describe(c: Contact): Record<string, unknown> {
  return { id: c.id, name: c.name, adresse: c.email || undefined, telefon: c.phone || undefined, notiz: c.note || undefined }
}

const saveContact = defineTool({
  name: 'contact_save',
  group: 'contacts',
  description:
    'Legt einen Kontakt mit Mailadresse und/oder Telefonnummer an oder ändert ihn. Nutze das, wenn der Nutzer ' +
    'einen Kontakt anlegen oder Kontaktdaten (Mail, Telefonnummer) speichern oder ändern möchte.',
  schema: z.object({
    name: z.string().describe('Wie der Nutzer die Person nennt, etwa "Anna".'),
    email: z.string().optional().describe('Die Mailadresse (optional).'),
    phone: z.string().optional().describe('Die Telefonnummer (optional).'),
    note: z.string().optional().describe('Kurze Unterscheidung oder Notiz.')
  }),
  async execute({ name, email, phone, note }) {
    const address = email?.trim()
    const phoneNumber = phone?.trim()

    if (!address && !phoneNumber) {
      throw new Error('Ein Kontakt braucht eine Mailadresse oder eine Telefonnummer.')
    }
    if (address && !looksLikeEmail(address)) {
      throw new Error(
        `"${address}" sieht nicht nach einer Mailadresse aus. Lass sie dir buchstabieren oder ` +
          'verweise auf die Seite Kontakte in den Einstellungen.'
      )
    }
    let normalizedPhone: string | undefined = undefined
    if (phoneNumber) {
      const norm = normalizePhone(phoneNumber)
      if (!norm) {
        throw new Error(
          `"${phoneNumber}" sieht nicht nach einer gültigen Telefonnummer aus. Verweise eventuell auf die Einstellungen.`
        )
      }
      normalizedPhone = norm
    }

    const saved = upsertContact({
      name,
      email: address || undefined,
      phone: normalizedPhone || phoneNumber || undefined,
      note
    })
    return {
      gespeichert: true,
      ...describe(saved),
      hinweis: 'Lies die gespeicherten Daten zur Kontrolle einmal vor.'
    }
  }
}) as ToolDefinition

const lookupContact = defineTool({
  name: 'contact_lookup',
  group: 'contacts',
  description:
    'Sucht die Mailadresse oder Telefonnummer zu einem Namen. Der Versand/Anruf macht das von selbst — nimm es nur, wenn ' +
    'der Nutzer direkt fragt, ob oder unter welcher Adresse/Nummer jemand im Buch steht.',
  schema: z.object({
    name: z.string().describe('Der Name oder ein Teil davon.')
  }),
  async execute({ name }) {
    const hits = findContacts(name)
    if (hits.length === 0) {
      return {
        gefunden: 0,
        hinweis: `Zu "${name}" steht nichts im Kontaktbuch. Frag den Nutzer nach der Adresse oder Nummer.`
      }
    }
    return { gefunden: hits.length, kontakte: hits.map(describe) }
  }
}) as ToolDefinition

const listContactsTool = defineTool({
  name: 'contact_list',
  group: 'contacts',
  description: 'Zählt auf, wer im Kontaktbuch steht.',
  schema: z.object({}),
  async execute() {
    const all = listContacts()
    if (all.length === 0) {
      return {
        anzahl: 0,
        note: 'Das Kontaktbuch ist leer. Einträge macht der Nutzer unter Einstellungen, Kontakte.'
      }
    }
    return {
      anzahl: all.length,
      kontakte: all.map(describe),
      hinweis: 'Nenne nur die Namen, nicht die Adressen — außer es wurde danach gefragt.'
    }
  }
}) as ToolDefinition

const removeContact = defineTool({
  name: 'contact_remove',
  group: 'contacts',
  description: 'Löscht einen Kontakt aus dem Adressbuch.',
  schema: z.object({
    id: z.number().describe('Die Kennung aus contact_lookup oder contact_list.')
  }),
  alwaysAsk: true,
  async execute({ id }) {
    const hit = listContacts().find((c) => c.id === id)
    if (!hit) throw new Error('Diesen Kontakt gibt es nicht.')
    deleteContact(id)
    return { gelöscht: hit.name }
  }
}) as ToolDefinition

const callContact = defineTool({
  name: 'contact_call',
  group: 'contacts',
  description:
    'Startet einen Anruf zu einem Kontakt aus dem Adressbuch. Öffnet dafür die Telefonie-App am Rechner.',
  schema: z.object({
    name: z.string().describe('Name des Kontakts im Adressbuch oder "mich".')
  }),
  alwaysAsk: true,
  async execute({ name }) {
    const hits = findContacts(name).filter((contact) => Boolean(contact.phone))
    if (hits.length === 0) {
      throw new Error(`Zu "${name}" steht keine Telefonnummer im Kontaktbuch.`)
    }
    const exact = hits.filter((contact) => contact.name.toLowerCase() === name.trim().toLowerCase())
    const contact = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null
    if (!contact) {
      throw new Error(`Zu "${name}" gibt es mehere anrufbare Kontakte. Frag, welchen davon der Nutzer meint.`)
    }
    const phone = normalizePhone(contact.phone)
    if (!phone) throw new Error(`Die Telefonnummer von ${contact.name} ist ungültig.`)
    await shell.openExternal(`tel:${phone}`)
    return { gestartet: true, an: contact.name, telefon: contact.phone, hinweis: 'Die Telefonie-App wurde geöffnet.' }
  }
}) as ToolDefinition

export const contactTools: ToolDefinition[] = [
  saveContact,
  lookupContact,
  listContactsTool,
  callContact,
  removeContact
]

/**
 * Löst einen gesprochenen Namen in genau einen Kontakt auf.
 */
export type Resolution =
  | { kind: 'one'; contact: Contact }
  | { kind: 'many'; matches: Contact[] }
  | { kind: 'none' }

export function resolveRecipient(nameOrAddress: string): Resolution {
  const raw = nameOrAddress.trim()

  if (looksLikeEmail(raw)) {
    const known = findContacts(raw).find((c) => c.email === raw.toLowerCase())
    return {
      kind: 'one',
      contact: known ?? { id: 0, name: raw, email: raw.toLowerCase(), phone: '', note: '', createdAt: 0 }
    }
  }

  const hits = findContacts(raw)
  if (hits.length === 0) return { kind: 'none' }
  if (hits.length === 1) return { kind: 'one', contact: hits[0] }

  const exact = hits.filter((c) => c.name.toLowerCase() === raw.toLowerCase())
  if (exact.length === 1) return { kind: 'one', contact: exact[0] }

  return { kind: 'many', matches: hits }
}
