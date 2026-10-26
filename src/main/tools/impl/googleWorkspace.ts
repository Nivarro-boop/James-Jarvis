import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { friendlyGoogleError, googleClient, hasGoogleAuth, hasWorkspaceAuth } from '../../providers/googleAuth'
import { limitedNodeStreamText } from '../../providers/httpBody'

/**
 * Google Workspace jenseits von Gmail und Kalender: Drive, Docs, Tabellen,
 * Aufgaben und Kontakte — alles über dieselbe Anmeldung.
 */

const MAX_TEXT = 12_000
// Both ordinary downloads and Google exports are limited during streaming.
const MAX_DOWNLOAD = 5 * 1024 * 1024

async function withGoogle<T>(fn: (google: any, auth: any) => Promise<T>): Promise<T> {
  if (hasGoogleAuth() && !hasWorkspaceAuth()) {
    throw new Error('Die Google-Anmeldung deckt Drive, Docs, Tabellen und Aufgaben noch nicht ab. Sag dem Nutzer: Einstellungen → Konten → „Neu anmelden“ drücken und bei Google alle Häkchen stehen lassen.')
  }
  const { google } = await import('googleapis')
  const auth = await googleClient(false)
  try {
    return await fn(google, auth)
  } catch (err) {
    throw new Error(friendlyGoogleError(err))
  }
}

const GOOGLE_TYPES: Record<string, string> = {
  'application/vnd.google-apps.document': 'Dokument',
  'application/vnd.google-apps.spreadsheet': 'Tabelle',
  'application/vnd.google-apps.presentation': 'Präsentation',
  'application/vnd.google-apps.folder': 'Ordner'
}

const driveSearch = defineTool({
  name: 'drive_search',
  group: 'workspace',
  description: 'Sucht Dateien in Google Drive nach Name oder Inhalt. Liefert Name, Art, Änderungsdatum, Link und ID für drive_read.',
  schema: z.object({
    suche: z.string().describe('Suchbegriff. Leer für die zuletzt geänderten Dateien.'),
    anzahl: z.number().int().min(1).max(30).optional()
  }),
  requiresSecret: 'googleOAuthClientId',
  readOnly: true,
  spokenHint: 'Ich schaue in deinem Drive nach.',
  async execute({ suche, anzahl }) {
    return withGoogle(async (google, auth) => {
      const drive = google.drive({ version: 'v3', auth, timeout: 20_000, retry: false })
      const term = suche.trim().replace(/['\\]/g, '')
      const res = await drive.files.list({
        q: `trashed = false${term ? ` and (name contains '${term}' or fullText contains '${term}')` : ''}`,
        orderBy: term ? undefined : 'modifiedTime desc',
        pageSize: anzahl ?? 10,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)'
      })
      const files = res.data.files ?? []
      return files.length
        ? files.map((f: any) => ({ id: f.id, name: f.name, art: GOOGLE_TYPES[f.mimeType] ?? f.mimeType, geaendert: f.modifiedTime, link: f.webViewLink }))
        : { hinweis: 'Nichts gefunden.' }
    })
  }
}) as ToolDefinition

const driveRead = defineTool({
  name: 'drive_read',
  group: 'workspace',
  description: 'Liest den Text einer Drive-Datei: Google-Dokumente als Text, Tabellen als CSV, Präsentationen als Text, sonst Textdateien direkt.',
  schema: z.object({ id: z.string().describe('Datei-ID aus drive_search.') }),
  requiresSecret: 'googleOAuthClientId',
  readOnly: true,
  async execute({ id }, ctx) {
    return withGoogle(async (google, auth) => {
      const drive = google.drive({ version: 'v3', auth, timeout: 20_000, retry: false })
      const options = { timeout: 20_000, retry: false, signal: ctx.signal }
      const meta = await drive.files.get({ fileId: id, fields: 'name,mimeType,size' }, options)
      const type = String(meta.data.mimeType ?? '')
      const exportAs = type === 'application/vnd.google-apps.spreadsheet' ? 'text/csv'
        : ['application/vnd.google-apps.document', 'application/vnd.google-apps.presentation'].includes(type) ? 'text/plain' : null
      let text: string
      if (exportAs) {
        const response = await drive.files.export({ fileId: id, mimeType: exportAs }, { ...options, responseType: 'stream' })
        text = await limitedNodeStreamText(response.data, MAX_DOWNLOAD, ctx.signal)
      } else if (Number(meta.data.size) > MAX_DOWNLOAD) {
        return { name: meta.data.name, art: type, hinweis: 'Datei zu groß zum Vorlesen; bitte in Drive öffnen.' }
      } else if (type.startsWith('text/') || type === 'application/json') {
        const response = await drive.files.get({ fileId: id, alt: 'media' }, { ...options, responseType: 'stream' })
        text = await limitedNodeStreamText(response.data, MAX_DOWNLOAD, ctx.signal)
      } else {
        return { name: meta.data.name, art: type, hinweis: 'Keine Textdatei; Inhalt kann nicht gelesen werden.' }
      }
      return { name: meta.data.name, text: text.slice(0, MAX_TEXT), gekuerzt: text.length > MAX_TEXT }
    })
  }
}) as ToolDefinition

const docsCreate = defineTool({
  name: 'docs_create',
  group: 'workspace',
  description: 'Legt ein neues Google-Dokument mit Titel und Text an und gibt den Link zurück.',
  schema: z.object({ titel: z.string().min(1), text: z.string().describe('Inhalt; Absätze mit Leerzeilen trennen.') }),
  requiresSecret: 'googleOAuthClientId',
  spokenHint: 'Ich lege das Dokument an.',
  async execute({ titel, text }, ctx) {
    return withGoogle(async (google, auth) => {
      const docs = google.docs({ version: 'v1', auth, timeout: 20_000, retry: false })
      const options = { timeout: 20_000, retry: false, signal: ctx.signal }
      const created = await docs.documents.create({ requestBody: { title: titel } }, options)
      const documentId = created.data.documentId
      if (text.trim()) {
        try { await docs.documents.batchUpdate({ documentId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text } }] } }, options) }
        catch { return { id: documentId, link: `https://docs.google.com/document/d/${documentId}/edit`, teilweise: true, hinweis: 'Das Dokument wurde angelegt. Ob der Inhalt vollständig gespeichert wurde, ist unklar. Dieses Dokument prüfen und weiterverwenden; nicht erneut anlegen.' } }
      }
      return { id: documentId, link: `https://docs.google.com/document/d/${documentId}/edit` }
    })
  }
}) as ToolDefinition

const docsAppend = defineTool({
  name: 'docs_append',
  group: 'workspace',
  description: 'Hängt Text ans Ende eines bestehenden Google-Dokuments an.',
  schema: z.object({ id: z.string().describe('Dokument-ID'), text: z.string().min(1) }),
  requiresSecret: 'googleOAuthClientId',
  async execute({ id, text }) {
    return withGoogle(async (google, auth) => {
      const docs = google.docs({ version: 'v1', auth, timeout: 20_000, retry: false })
      await docs.documents.batchUpdate({ documentId: id, requestBody: { requests: [{ insertText: { endOfSegmentLocation: {}, text: `\n${text}` } }] } })
      return { ok: true, link: `https://docs.google.com/document/d/${id}/edit` }
    })
  }
}) as ToolDefinition

const sheetsRead = defineTool({
  name: 'sheets_read',
  group: 'workspace',
  description: 'Liest Zellen aus einer Google-Tabelle. Ohne Bereich das erste Blatt.',
  schema: z.object({ id: z.string().describe('Tabellen-ID'), bereich: z.string().optional().describe('z. B. "Blatt1!A1:D20"') }),
  requiresSecret: 'googleOAuthClientId',
  readOnly: true,
  async execute({ id, bereich }) {
    return withGoogle(async (google, auth) => {
      const sheets = google.sheets({ version: 'v4', auth, timeout: 20_000, retry: false })
      let range = bereich
      if (!range) {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets(properties(title))' })
        range = `${meta.data.sheets?.[0]?.properties?.title ?? 'Sheet1'}!A1:Z200`
      }
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range })
      return { bereich: res.data.range, zeilen: (res.data.values ?? []).slice(0, 200) }
    })
  }
}) as ToolDefinition

const sheetsAppend = defineTool({
  name: 'sheets_append',
  group: 'workspace',
  description: 'Hängt Zeilen unten an eine Google-Tabelle an.',
  schema: z.object({
    id: z.string().describe('Tabellen-ID'),
    bereich: z.string().optional().describe('Blatt, z. B. "Blatt1". Standard erstes Blatt.'),
    zeilen: z.array(z.array(z.union([z.string(), z.number()]))).min(1)
  }),
  requiresSecret: 'googleOAuthClientId',
  async execute({ id, bereich, zeilen }) {
    return withGoogle(async (google, auth) => {
      const sheets = google.sheets({ version: 'v4', auth, timeout: 20_000, retry: false })
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: id, range: bereich ?? 'A1', valueInputOption: 'USER_ENTERED', requestBody: { values: zeilen }
      })
      return { ok: true, aktualisiert: res.data.updates?.updatedRange }
    })
  }
}) as ToolDefinition

async function defaultTaskList(tasks: any): Promise<string> {
  const lists = await tasks.tasklists.list({ maxResults: 1 })
  return lists.data.items?.[0]?.id ?? '@default'
}

const tasksList = defineTool({
  name: 'tasks_list',
  group: 'workspace',
  description: 'Zeigt offene Google-Aufgaben (Google Tasks) mit Fälligkeit.',
  schema: z.object({ erledigte: z.boolean().optional() }),
  requiresSecret: 'googleOAuthClientId',
  readOnly: true,
  async execute({ erledigte }) {
    return withGoogle(async (google, auth) => {
      const tasks = google.tasks({ version: 'v1', auth, timeout: 20_000, retry: false })
      const res = await tasks.tasks.list({ tasklist: await defaultTaskList(tasks), showCompleted: Boolean(erledigte), maxResults: 50 })
      return (res.data.items ?? []).map((t: any) => ({ id: t.id, titel: t.title, faellig: t.due, notiz: t.notes, erledigt: t.status === 'completed' }))
    })
  }
}) as ToolDefinition

const tasksAdd = defineTool({
  name: 'tasks_add',
  group: 'workspace',
  description: 'Legt eine Google-Aufgabe an, optional mit Fälligkeitsdatum (YYYY-MM-DD) und Notiz.',
  schema: z.object({ titel: z.string().min(1), faellig: z.string().optional(), notiz: z.string().optional() }),
  requiresSecret: 'googleOAuthClientId',
  async execute({ titel, faellig, notiz }) {
    return withGoogle(async (google, auth) => {
      const tasks = google.tasks({ version: 'v1', auth, timeout: 20_000, retry: false })
      const due = faellig && /^\d{4}-\d{2}-\d{2}$/.test(faellig) ? `${faellig}T00:00:00.000Z` : undefined
      const res = await tasks.tasks.insert({ tasklist: await defaultTaskList(tasks), requestBody: { title: titel, notes: notiz, due } })
      return { ok: true, id: res.data.id }
    })
  }
}) as ToolDefinition

const tasksComplete = defineTool({
  name: 'tasks_complete',
  group: 'workspace',
  description: 'Hakt eine Google-Aufgabe ab. ID aus tasks_list.',
  schema: z.object({ id: z.string() }),
  requiresSecret: 'googleOAuthClientId',
  async execute({ id }) {
    return withGoogle(async (google, auth) => {
      const tasks = google.tasks({ version: 'v1', auth, timeout: 20_000, retry: false })
      await tasks.tasks.patch({ tasklist: await defaultTaskList(tasks), task: id, requestBody: { status: 'completed' } })
      return { ok: true }
    })
  }
}) as ToolDefinition

const googleContacts = defineTool({
  name: 'google_contacts_search',
  group: 'workspace',
  description: 'Sucht in den Google-Kontakten nach Name, E-Mail oder Telefonnummer.',
  schema: z.object({ suche: z.string().min(1) }),
  requiresSecret: 'googleOAuthClientId',
  readOnly: true,
  async execute({ suche }) {
    return withGoogle(async (google, auth) => {
      const people = google.people({ version: 'v1', auth, timeout: 20_000, retry: false })
      // Die Suche braucht einmal eine leere Anfrage zum Aufwärmen des Caches.
      await people.people.searchContacts({ query: '', readMask: 'names' }).catch(() => undefined)
      const res = await people.people.searchContacts({ query: suche, readMask: 'names,emailAddresses,phoneNumbers', pageSize: 10 })
      return (res.data.results ?? []).map((r: any) => ({
        name: r.person?.names?.[0]?.displayName,
        mails: (r.person?.emailAddresses ?? []).map((e: any) => e.value),
        telefon: (r.person?.phoneNumbers ?? []).map((p: any) => p.value)
      }))
    })
  }
}) as ToolDefinition

export const googleWorkspaceTools: ToolDefinition[] = [
  driveSearch, driveRead, docsCreate, docsAppend, sheetsRead, sheetsAppend, tasksList, tasksAdd, tasksComplete, googleContacts
]
