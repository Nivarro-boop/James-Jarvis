import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { friendlyGoogleError, googleClient } from '../../providers/googleAuth'

/**
 * Gmail.
 *
 * Alles außer dem Versand läuft ohne Rückfrage — Mails lesen ist harmlos.
 * `gmail_send` ist dagegen fest auf Rückfrage gesetzt und nicht abschaltbar:
 * eine versehentlich verschickte Mail bekommt man nicht zurück. Endgültig
 * gelöscht wird nichts; der Papierkorb ist die einzige Löschstufe, die es
 * hier gibt.
 */

async function gmailApi(): Promise<any> {
  const { google } = await import('googleapis')
  const auth = await googleClient(false)
  return google.gmail({ version: 'v1', auth })
}

/**
 * Google-Fehler in einen vorlesbaren Satz übersetzen.
 *
 * Ohne das liest James dem Nutzer "Error: invalid_grant" vor, was ihm
 * genau nichts sagt — dabei ist die Abhilfe immer dieselbe: neu verbinden.
 */
async function withGmail<T>(fn: (gmail: any) => Promise<T>): Promise<T> {
  const gmail = await gmailApi()
  try {
    return await fn(gmail)
  } catch (err) {
    throw new Error(friendlyGoogleError(err))
  }
}

/** Kopfzeilen kommen als Liste von Name-Wert-Paaren. */
function header(message: any, name: string): string {
  const headers = message?.payload?.headers ?? []
  const found = headers.find((h: { name: string }) => h.name.toLowerCase() === name.toLowerCase())
  return found?.value ?? ''
}

/** Klartext aus der teils tief verschachtelten MIME-Struktur ziehen. */
function extractBody(payload: any, depth = 0): string {
  if (!payload || depth > 8) return ''

  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, 'base64url').toString('utf-8')
    if (payload.mimeType === 'text/plain') return decoded
    if (payload.mimeType === 'text/html') {
      // Grobe Entkernung reicht: der Text wird ohnehin nur zusammengefasst.
      return decoded
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s{2,}/g, ' ')
    }
  }

  for (const part of payload.parts ?? []) {
    // Klartext bevorzugen, HTML nur als Rückfall.
    if (part.mimeType === 'text/plain') {
      const text = extractBody(part, depth + 1)
      if (text) return text
    }
  }
  for (const part of payload.parts ?? []) {
    const text = extractBody(part, depth + 1)
    if (text) return text
  }
  return ''
}

const search = defineTool({
  name: 'gmail_search',
  group: 'gmail',
  description:
    'Durchsucht das Postfach und liefert Absender, Betreff und Datum. ' +
    'Nutzt die Gmail-Suchsyntax, etwa "is:unread", "from:amazon", "newer_than:2d".',
  schema: z.object({
    query: z.string().describe('Die Suchanfrage in Gmail-Syntax.'),
    maxResults: z.number().optional().describe('Wie viele Treffer, Standard zehn.')
  }),
  requiresSecret: 'googleOAuthClientId',
  async execute({ query, maxResults }) {
    return withGmail(async (gmail) => {
      const list = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: Math.min(25, Math.max(1, maxResults ?? 10))
      })

      const ids = list.data.messages ?? []
      if (ids.length === 0) return { anzahl: 0, note: 'Dazu gibt es keine Mails.' }

      // Nur Kopfzeilen holen — der vollständige Abruf wäre um ein Vielfaches
      // langsamer und für eine Übersicht unnötig.
      const messages = await Promise.all(
        ids.map((m: { id: string }) =>
          gmail.users.messages.get({
            userId: 'me',
            id: m.id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date']
          })
        )
      )

      return {
        anzahl: messages.length,
        mails: messages.map((res: any) => ({
          id: res.data.id,
          von: header(res.data, 'From').replace(/<[^>]+>/, '').trim() || header(res.data, 'From'),
          betreff: header(res.data, 'Subject') || '(kein Betreff)',
          datum: header(res.data, 'Date'),
          ungelesen: (res.data.labelIds ?? []).includes('UNREAD'),
          vorschau: res.data.snippet?.slice(0, 160) ?? ''
        }))
      }
    })
  }
}) as ToolDefinition

const inbox = defineTool({
  name: 'gmail_summarize_inbox',
  group: 'gmail',
  description:
    'Verschafft einen Überblick über die neuesten ungelesenen Mails. ' +
    'Das richtige Werkzeug für "was ist heute reingekommen" oder "hab ich neue Mails".',
  schema: z.object({
    hours: z.number().optional().describe('Zeitraum in Stunden, Standard vierundzwanzig.')
  }),
  requiresSecret: 'googleOAuthClientId',
  async execute({ hours }) {
    return withGmail(async (gmail) => {
      const span = Math.max(1, hours ?? 24)
      // Gmail rechnet newer_than nur in Tagen, deshalb aufrunden.
      const days = Math.max(1, Math.ceil(span / 24))

      const list = await gmail.users.messages.list({
        userId: 'me',
        q: `is:unread newer_than:${days}d -category:promotions -category:social`,
        maxResults: 15
      })

      const ids = list.data.messages ?? []
      if (ids.length === 0) {
        return { anzahl: 0, note: 'Es sind keine neuen wichtigen Mails da.' }
      }

      const messages = await Promise.all(
        ids.map((m: { id: string }) =>
          gmail.users.messages.get({
            userId: 'me',
            id: m.id,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date']
          })
        )
      )

      return {
        anzahl: messages.length,
        mails: messages.map((res: any) => ({
          von: header(res.data, 'From').replace(/<[^>]+>/, '').trim() || header(res.data, 'From'),
          betreff: header(res.data, 'Subject') || '(kein Betreff)',
          vorschau: res.data.snippet?.slice(0, 140) ?? ''
        })),
        hinweis:
          'Fass das in zwei bis drei Sätzen zusammen. Nenne Absender und worum es geht, ' +
          'nicht jede Mail einzeln.'
      }
    })
  }
}) as ToolDefinition

const read = defineTool({
  name: 'gmail_read',
  group: 'gmail',
  description: 'Liest eine einzelne Mail vollständig. Die Kennung kommt aus gmail_search.',
  schema: z.object({
    id: z.string().describe('Die Kennung der Mail.')
  }),
  requiresSecret: 'googleOAuthClientId',
  async execute({ id }) {
    return withGmail(async (gmail) => {
      const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
      const body = extractBody(res.data.payload).trim()

      return {
        von: header(res.data, 'From'),
        an: header(res.data, 'To'),
        betreff: header(res.data, 'Subject'),
        datum: header(res.data, 'Date'),
        inhalt: body.slice(0, 6000),
        gekürzt: body.length > 6000
      }
    })
  }
}) as ToolDefinition

const draft = defineTool({
  name: 'gmail_draft',
  group: 'gmail',
  description:
    'Legt einen Entwurf an, ohne ihn zu verschicken. Nutze das, wenn der Nutzer die Mail noch ' +
    'selbst durchsehen will.',
  schema: z.object({
    to: z.string().describe('Empfängeradresse.'),
    subject: z.string().describe('Betreff.'),
    body: z.string().describe('Der Text der Mail.')
  }),
  requiresSecret: 'googleOAuthClientId',
  async execute({ to, subject, body }) {
    return withGmail(async (gmail) => {
      const raw = buildRawMessage(to, subject, body)
      const res = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: { message: { raw } }
      })
      return { entwurfAngelegt: true, id: res.data.id, an: to, betreff: subject }
    })
  }
}) as ToolDefinition

const send = defineTool({
  name: 'gmail_send',
  group: 'gmail',
  description:
    'Verschickt eine Mail. Fragt immer vorher nach und liest dabei Empfänger und Betreff vor.',
  schema: z.object({
    to: z.string().describe('Empfängeradresse.'),
    subject: z.string().describe('Betreff.'),
    body: z.string().describe('Der Text der Mail.')
  }),
  alwaysAsk: true,
  requiresSecret: 'googleOAuthClientId',
  async execute({ to, subject, body }) {
    return withGmail(async (gmail) => {
      const raw = buildRawMessage(to, subject, body)
      const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
      return { verschickt: true, id: res.data.id, an: to }
    })
  }
}) as ToolDefinition

const archive = defineTool({
  name: 'gmail_archive',
  group: 'gmail',
  description: 'Verschiebt eine Mail aus dem Posteingang ins Archiv.',
  schema: z.object({
    id: z.string().describe('Die Kennung der Mail.')
  }),
  requiresSecret: 'googleOAuthClientId',
  async execute({ id }) {
    return withGmail(async (gmail) => {
      await gmail.users.messages.modify({
        userId: 'me',
        id,
        requestBody: { removeLabelIds: ['INBOX'] }
      })
      return { archiviert: true }
    })
  }
}) as ToolDefinition

const markRead = defineTool({
  name: 'gmail_mark_read',
  group: 'gmail',
  description: 'Markiert eine Mail als gelesen.',
  schema: z.object({
    id: z.string().describe('Die Kennung der Mail.')
  }),
  requiresSecret: 'googleOAuthClientId',
  async execute({ id }) {
    return withGmail(async (gmail) => {
      await gmail.users.messages.modify({
        userId: 'me',
        id,
        requestBody: { removeLabelIds: ['UNREAD'] }
      })
      return { alsGelesenMarkiert: true }
    })
  }
}) as ToolDefinition

/**
 * Antworten.
 *
 * Ohne `In-Reply-To` und `References` hängt die Antwort nicht am Gespräch,
 * sondern steht als neue Mail daneben — beim Empfänger sieht das aus, als
 * hätte man den Verlauf nicht gelesen.
 */
const reply = defineTool({
  name: 'gmail_reply',
  group: 'gmail',
  description:
    'Antwortet auf eine Mail im selben Gesprächsfaden. Die Kennung kommt aus gmail_search. ' +
    'Fragt immer vorher nach.',
  schema: z.object({
    id: z.string().describe('Die Kennung der Mail, auf die geantwortet wird.'),
    body: z.string().describe('Der Text der Antwort.'),
    replyAll: z.boolean().optional().describe('Auch an alle weiteren Empfänger.')
  }),
  alwaysAsk: true,
  requiresSecret: 'googleOAuthClientId',
  async execute({ id, body, replyAll }) {
    return withGmail(async (gmail) => {
      const original = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-Id', 'References']
      })

      const from = header(original.data, 'From')
      const subject = header(original.data, 'Subject')
      const messageId = header(original.data, 'Message-Id')
      const references = header(original.data, 'References')

      const recipients = [from]
      if (replyAll) {
        for (const extra of [header(original.data, 'To'), header(original.data, 'Cc')]) {
          if (extra) recipients.push(extra)
        }
      }

      const raw = buildRawMessage(
        recipients.join(', '),
        /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        body,
        {
          inReplyTo: messageId,
          references: [references, messageId].filter(Boolean).join(' ')
        }
      )

      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw, threadId: original.data.threadId }
      })
      return { geantwortet: true, id: res.data.id, an: from }
    })
  }
}) as ToolDefinition

/**
 * Papierkorb statt endgültig löschen.
 *
 * Es gibt bewusst kein Werkzeug, das eine Mail unwiederbringlich entfernt.
 * Der Papierkorb hält sie dreißig Tage — das reicht, um einen Irrtum des
 * Modells zu bemerken.
 */
const trash = defineTool({
  name: 'gmail_trash',
  group: 'gmail',
  description:
    'Verschiebt eine Mail in den Papierkorb. Von dort ist sie dreißig Tage lang ' +
    'wiederherstellbar. Endgültig gelöscht wird nichts.',
  schema: z.object({
    id: z.string().describe('Die Kennung der Mail.')
  }),
  alwaysAsk: true,
  requiresSecret: 'googleOAuthClientId',
  async execute({ id }) {
    return withGmail(async (gmail) => {
      await gmail.users.messages.trash({ userId: 'me', id })
      return { imPapierkorb: true, hinweis: 'Wiederherstellbar über den Papierkorb in Gmail.' }
    })
  }
}) as ToolDefinition

const unreadCount = defineTool({
  name: 'gmail_unread_count',
  group: 'gmail',
  description:
    'Sagt, wie viele ungelesene Mails im Posteingang liegen. Das schnellste Werkzeug für ' +
    '"hab ich neue Mails" — es holt keine Inhalte.',
  schema: z.object({}),
  requiresSecret: 'googleOAuthClientId',
  async execute() {
    return withGmail(async (gmail) => {
      const res = await gmail.users.labels.get({ userId: 'me', id: 'INBOX' })
      return {
        ungelesen: res.data.messagesUnread ?? 0,
        gesamt: res.data.messagesTotal ?? 0
      }
    })
  }
}) as ToolDefinition

/**
 * RFC-2822-Nachricht in base64url.
 *
 * Betreff und Text werden MIME-kodiert, sonst kommen Umlaute beim Empfänger
 * als Fragezeichen an — bei einem deutschen Nutzer also ständig.
 */
function buildRawMessage(
  to: string,
  subject: string,
  body: string,
  thread?: { inReplyTo?: string; references?: string }
): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
  const lines = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64'
  ]
  if (thread?.inReplyTo) lines.push(`In-Reply-To: ${thread.inReplyTo}`)
  if (thread?.references) lines.push(`References: ${thread.references}`)
  lines.push('', wrapBase64(Buffer.from(body, 'utf-8').toString('base64')))

  return Buffer.from(lines.join('\r\n'), 'utf-8').toString('base64url')
}

/**
 * Base64-Rumpf auf 76 Zeichen je Zeile umbrechen.
 *
 * RFC 2045 schreibt das vor, und zwar nicht als Formsache: Mailserver dürfen
 * überlange Zeilen abweisen oder von sich aus umbrechen — im zweiten Fall
 * kommt der Text beim Empfänger zerstört an. Bei kurzen Mails fällt das nie
 * auf, bei einer längeren Antwort schon.
 */
function wrapBase64(value: string): string {
  const chunks: string[] = []
  for (let i = 0; i < value.length; i += 76) chunks.push(value.slice(i, i + 76))
  return chunks.join('\r\n')
}

/** Nur zum Prüfen des Nachrichtenaufbaus. */
export const __internals = { buildRawMessage, wrapBase64 }

export const gmailTools: ToolDefinition[] = [
  search,
  inbox,
  unreadCount,
  read,
  draft,
  send,
  reply,
  archive,
  markRead,
  trash
]
