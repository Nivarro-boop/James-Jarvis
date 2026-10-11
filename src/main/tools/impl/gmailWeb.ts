import { clipboard } from 'electron'
import { z } from 'zod'
import type { Page } from 'playwright-core'
import { defineTool, type ToolDefinition } from '../registry'
import { detectBlock, findOrOpen, getContext } from '../../automation/chromeCdp'

/**
 * Gmail über den James-Browser — ohne OAuth.
 *
 * Warum das nötig ist: der API-Weg verlangt einen eigenen OAuth-Client aus
 * der Google Cloud Console. Wer den nicht anlegen will (und das sind fast
 * alle), hat sonst schlicht kein Gmail. Hier reicht eine einmalige Anmeldung
 * im Browserfenster, das James benutzt.
 *
 * Grenze: verschickt wird nichts von selbst. `mail_compose` legt das Fenster
 * mit ausgefüllten Feldern an und übergibt an Void; auf Senden drückt er
 * selbst. Beim API-Weg prüft der Hauptprozess eine Zusage, hier gibt es diese
 * Kette nicht — also wird gar nicht erst versendet.
 */

const INBOX = 'https://mail.google.com/mail/u/0/#inbox'

async function gmailPage(): Promise<Page> {
  const page = await findOrOpen('mail.google.com', INBOX)
  const blocked = await detectBlock(page)
  if (blocked) throw new Error(blocked)

  if (page.url().includes('accounts.google.com')) {
    throw new Error(
      'Im James-Browser ist kein Google-Konto angemeldet. Sag dem Nutzer, er soll sich dort ' +
        'einmal anmelden — der Knopf dafür steht in den Einstellungen unter Verbindungen. ' +
        'Danach läuft es von allein.'
    )
  }
  return page
}

/**
 * Gmails Klassennamen sind kurz und wirken zufällig, sind aber seit Jahren
 * stabil: `tr.zA` ist eine Zeile, `.bog` der Betreff, `.y2` die Vorschau.
 * Trotzdem mehrere Kandidaten pro Feld — bricht einer weg, trägt der nächste.
 */
async function readRows(page: Page, limit: number): Promise<
  { von: string; betreff: string; vorschau: string; zeit: string; ungelesen: boolean }[]
> {
  await page.waitForSelector('tr.zA', { timeout: 15_000 }).catch(() => undefined)

  return page.evaluate((max) => {
    const pick = (row: Element, selectors: string[]): string => {
      for (const selector of selectors) {
        const text = row.querySelector(selector)?.textContent?.trim()
        if (text) return text
      }
      return ''
    }

    const out: {
      von: string
      betreff: string
      vorschau: string
      zeit: string
      ungelesen: boolean
    }[] = []

    const rows = document.querySelectorAll('tr.zA')
    for (let i = 0; i < rows.length && out.length < max; i++) {
      const row = rows[i]
      const betreff = pick(row, ['.bog', '.y6 span[id]', '.y6 span'])
      if (!betreff) continue
      out.push({
        von: pick(row, ['.yW span[email]', '.yW span', '.zF', '.yP']),
        betreff,
        vorschau: pick(row, ['.y2']).replace(/^\s*-\s*/, ''),
        zeit: pick(row, ['.xW span', 'td.xW']),
        // Ungelesene Zeilen tragen die Klasse zE, gelesene yO.
        ungelesen: row.classList.contains('zE')
      })
    }
    return out
  }, limit)
}

const inbox = defineTool({
  name: 'mail_inbox',
  group: 'gmail',
  description:
    'Liest den Posteingang im angemeldeten Chrome. Braucht keine Einrichtung. ' +
    'Für "was ist reingekommen" oder "hab ich neue Mails".',
  schema: z.object({
    onlyUnread: z.boolean().optional().describe('Nur ungelesene zeigen.'),
    maxResults: z.number().optional().describe('Wie viele Mails, Standard zehn.')
  }),
  async execute({ onlyUnread, maxResults }) {
    const page = await gmailPage()
    const limit = Math.min(25, Math.max(1, maxResults ?? 10))

    await page.goto(
      onlyUnread ? 'https://mail.google.com/mail/u/0/#search/is%3Aunread' : INBOX,
      { waitUntil: 'domcontentloaded' }
    )

    const rows = await readRows(page, limit)
    if (rows.length === 0) {
      return { anzahl: 0, note: onlyUnread ? 'Nichts Ungelesenes.' : 'Der Posteingang ist leer.' }
    }

    return {
      anzahl: rows.length,
      mails: rows,
      hinweis:
        'Fass das in zwei bis drei Sätzen zusammen. Nenne Absender und worum es geht, nicht ' +
        'jede Mail einzeln.'
    }
  }
}) as ToolDefinition

const search = defineTool({
  name: 'mail_search',
  group: 'gmail',
  description:
    'Durchsucht das Postfach im angemeldeten Chrome. Versteht die Gmail-Syntax, etwa ' +
    '"from:amazon" oder "newer_than:2d".',
  schema: z.object({
    query: z.string().describe('Wonach gesucht wird.'),
    maxResults: z.number().optional().describe('Wie viele Treffer, Standard zehn.')
  }),
  async execute({ query, maxResults }) {
    const page = await gmailPage()
    await page.goto(
      `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded' }
    )

    const rows = await readRows(page, Math.min(25, Math.max(1, maxResults ?? 10)))
    if (rows.length === 0) return { anzahl: 0, note: 'Dazu gibt es keine Mails.' }
    return { anzahl: rows.length, mails: rows }
  }
}) as ToolDefinition

const open = defineTool({
  name: 'mail_open',
  group: 'gmail',
  description:
    'Öffnet eine Mail im Browser und liest sie vollständig vor. Gesucht wird über Betreff ' +
    'oder Absender, so wie es in mail_inbox stand.',
  schema: z.object({
    match: z.string().describe('Teil des Betreffs oder des Absendernamens.'),
    maxChars: z.number().optional().describe('Wie viel Text höchstens, Standard viertausend.')
  }),
  async execute({ match, maxChars }) {
    const page = await gmailPage()

    const opened = await page.evaluate((needle) => {
      const rows = Array.from(document.querySelectorAll('tr.zA'))
      const lower = needle.toLowerCase()
      for (const row of rows) {
        if ((row.textContent ?? '').toLowerCase().includes(lower)) {
          ;(row.querySelector('.bog, .y6') as HTMLElement | null)?.click()
          return true
        }
      }
      return false
    }, match)

    if (!opened) throw new Error(`Im Postfach finde ich nichts, das auf "${match}" passt.`)

    // Der geöffnete Text steht in .a3s. Der Aufbau wechselt zwischen
    // Einzelmail und Gesprächsfaden, deshalb warten statt raten.
    await page.waitForSelector('.a3s', { timeout: 12_000 }).catch(() => undefined)
    await page.bringToFront()

    const mail = await page.evaluate(() => {
      const subject = document.querySelector('h2.hP')?.textContent?.trim() ?? ''
      const sender = document.querySelector('.gD')?.getAttribute('name') ?? ''
      const address = document.querySelector('.gD')?.getAttribute('email') ?? ''
      const date = document.querySelector('.g3, span.g3')?.getAttribute('title') ?? ''
      const bodies = Array.from(document.querySelectorAll('.a3s'))
        .map((n) => (n as HTMLElement).innerText.trim())
        .filter(Boolean)
      return { subject, sender, address, date, body: bodies.join('\n\n---\n\n') }
    })

    const limit = Math.min(12_000, Math.max(200, maxChars ?? 4000))
    return {
      betreff: mail.subject || '(kein Betreff)',
      von: mail.sender || mail.address,
      datum: mail.date,
      inhalt: mail.body.slice(0, limit),
      gekürzt: mail.body.length > limit
    }
  }
}) as ToolDefinition

const copyOut = defineTool({
  name: 'mail_copy',
  group: 'gmail',
  description:
    'Kopiert den Text der gerade geöffneten Mail in die Zwischenablage, damit der Nutzer ihn ' +
    'irgendwo einfügen kann. Vorher mit mail_open die Mail öffnen.',
  schema: z.object({
    part: z
      .enum(['alles', 'text', 'absender', 'betreff'])
      .optional()
      .describe('Was kopiert werden soll. Ohne Angabe der ganze Text.')
  }),
  async execute({ part }) {
    const ctx = await getContext()
    const page = ctx.pages().find((p) => p.url().includes('mail.google.com'))
    if (!page) throw new Error('Es ist gerade keine Mail offen.')

    const mail = await page.evaluate(() => ({
      subject: document.querySelector('h2.hP')?.textContent?.trim() ?? '',
      sender: document.querySelector('.gD')?.getAttribute('email') ?? '',
      body: Array.from(document.querySelectorAll('.a3s'))
        .map((n) => (n as HTMLElement).innerText.trim())
        .filter(Boolean)
        .join('\n\n')
    }))

    if (!mail.subject && !mail.body) throw new Error('Es ist gerade keine Mail geöffnet.')

    const payload =
      part === 'absender'
        ? mail.sender
        : part === 'betreff'
          ? mail.subject
          : part === 'text'
            ? mail.body
            : `Betreff: ${mail.subject}\nVon: ${mail.sender}\n\n${mail.body}`

    clipboard.writeText(payload)
    return { kopiert: payload.length, was: part ?? 'alles' }
  }
}) as ToolDefinition

const compose = defineTool({
  name: 'mail_compose',
  group: 'gmail',
  description:
    'Öffnet ein neues Mailfenster mit ausgefüllten Feldern. Verschickt wird nichts — auf ' +
    'Senden drückt der Nutzer selbst. Für "schreib eine Mail an X".',
  schema: z.object({
    to: z.string().optional().describe('Empfängeradresse.'),
    subject: z.string().optional().describe('Betreff.'),
    body: z.string().optional().describe('Der Text der Mail.')
  }),
  async execute({ to, subject, body }) {
    const params = new URLSearchParams({ view: 'cm', fs: '1', tf: '1' })
    if (to) params.set('to', to)
    if (subject) params.set('su', subject)
    if (body) params.set('body', body)

    const ctx = await getContext()
    const page = await ctx.newPage()
    await page.goto(`https://mail.google.com/mail/u/0/?${params.toString()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    })
    await page.bringToFront()

    return {
      geöffnet: true,
      an: to ?? '(offen)',
      betreff: subject ?? '(offen)',
      hinweis:
        'Sag dem Nutzer, dass die Mail fertig ausgefüllt im Browser steht und er nur noch auf ' +
        'Senden drücken muss. Du verschickst sie nicht.'
    }
  }
}) as ToolDefinition

export const gmailWebTools: ToolDefinition[] = [inbox, search, open, copyOut, compose]
