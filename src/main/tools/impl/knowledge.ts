import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { getSettings } from '../../store/settings'

/**
 * Nachschlagen und Nachrichten — ohne Schlüssel, ohne Einrichtung.
 *
 * Beide Namen standen schon in `telephony/phoneTools.ts` auf der Liste dessen,
 * was am Telefon erlaubt ist. Nur gab es die Werkzeuge nicht, und weil
 * `phoneToolNames()` gegen die Registry prüft, fielen sie dort still weg — die
 * Liste versprach etwas, das nirgends existierte. Das ist der eigentliche
 * Grund, warum ausgerechnet diese zwei hier stehen und nicht zehn andere.
 *
 * ── Warum nicht einfach `web_search` ──
 *
 * Die Websuche läuft über Gemini-Grounding: ein Modellaufruf, der bezahlt wird
 * und ein paar Sekunden dauert. Für "wer war Nikola Tesla" ist das der teure
 * Weg zu einer Antwort, die als fertiger Absatz bei Wikipedia liegt, und für
 * "was gibt's Neues" liefert Grounding eine Zusammenfassung, wo man Schlagzeilen
 * wollte. Am Telefon zählt beides doppelt: Sekunden sind dort Stille.
 *
 * Beide Quellen brauchen keinen Zugang, deshalb steht an keinem der beiden
 * Werkzeuge ein `requiresSecret` — sie sind immer da.
 */

/** Die Sprache als zweibuchstabiger Code, für Wikipedia und Google News. */
function languageCode(): string {
  return (getSettings().language || 'de-DE').slice(0, 2).toLowerCase()
}

/**
 * HTML-Entitäten auflösen.
 *
 * RSS-Titel kommen mit `&#39;` und `&amp;` herein. Vorgelesen würde daraus
 * "ampersand hash neununddreißig" — im Text unschön, gesprochen unverständlich.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Zuletzt, sonst würde aus `&amp;#39;` zweimal ersetzt.
    .replace(/&amp;/g, '&')
    .trim()
}

// ─────────────────────────────────────────────────────────────
// Wikipedia
// ─────────────────────────────────────────────────────────────

interface WikiSummary {
  title: string
  extract: string
  url?: string
}

/** Die Zusammenfassung zu einem exakten Seitentitel. */
async function wikiSummary(lang: string, title: string): Promise<WikiSummary | null> {
  const url =
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/` +
    encodeURIComponent(title.replace(/ /g, '_'))

  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'VoidJarvis/1.0 (Sprachassistent)', Accept: 'application/json' }
  })
  if (!res.ok) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await res.json()) as any
  // Begriffsklärungsseiten haben einen Auszug, der nur aus "kann bedeuten"
  // besteht — als Antwort wertlos, also behandeln wir sie wie einen Fehlschlag
  // und lassen die Suche einen echten Artikel finden.
  if (data?.type === 'disambiguation') return null
  if (!data?.extract) return null

  return {
    title: data.title ?? title,
    extract: String(data.extract),
    url: data.content_urls?.desktop?.page
  }
}

/** Den passendsten Seitentitel zu einem Suchbegriff finden. */
async function wikiSearch(lang: string, query: string): Promise<string | null> {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1` +
    `&srsearch=${encodeURIComponent(query)}`

  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'VoidJarvis/1.0 (Sprachassistent)' }
  })
  if (!res.ok) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await res.json()) as any
  return data?.query?.search?.[0]?.title ?? null
}

const wikipedia = defineTool({
  name: 'wikipedia',
  group: 'web',
  description:
    'Schlägt einen Begriff, eine Person, einen Ort oder ein Ereignis bei Wikipedia nach und ' +
    'gibt die Einleitung des Artikels zurück. Das richtige Werkzeug für "wer war X", "was ist Y", ' +
    '"erklär mir Z" — also für gesichertes Wissen, das sich nicht täglich ändert. ' +
    'Für Aktuelles wie Preise, Spielstände oder Nachrichten nimm web_search oder news_headlines.',
  schema: z.object({
    begriff: z.string().describe('Wonach nachgeschlagen wird, z.B. "Nikola Tesla" oder "Photosynthese".'),
    ausfuehrlich: z
      .boolean()
      .optional()
      .describe('Den vollen Einleitungsabsatz statt der ersten zwei Sätze. Standard nein.')
  }),
  spokenHint: 'Okay.',
  async execute({ begriff, ausfuehrlich }) {
    const lang = languageCode()

    // Erst der direkte Weg: Bei "Nikola Tesla" trifft der Titel auf Anhieb und
    // spart einen Abruf. Erst wenn das danebengeht — Tippfehler, Umschreibung,
    // Begriffsklärung —, wird gesucht.
    let summary = await wikiSummary(lang, begriff)

    if (!summary) {
      const title = await wikiSearch(lang, begriff)
      if (title) summary = await wikiSummary(lang, title)
    }

    // Ein deutscher Artikel fehlt öfter, als man denkt — bei englischsprachigen
    // Fachbegriffen etwa. Lieber eine Antwort aus der englischen Wikipedia als
    // gar keine.
    if (!summary && lang !== 'en') {
      const title = await wikiSearch('en', begriff)
      if (title) summary = await wikiSummary('en', title)
    }

    if (!summary) {
      throw new Error(
        `Zu "${begriff}" gibt es bei Wikipedia keinen Artikel, den ich eindeutig zuordnen kann. ` +
          'Sag dem Nutzer das und biete an, stattdessen im Web zu suchen.'
      )
    }

    // Gesprochen ist ein ganzer Absatz zu lang. Zwei Sätze beantworten die
    // Frage, und wer mehr will, fragt nach — das ist der Vorteil eines
    // Gesprächs gegenüber einer Textseite.
    const text = ausfuehrlich
      ? summary.extract
      : (summary.extract.match(/[^.!?]+[.!?]+/g)?.slice(0, 2).join(' ').trim() ?? summary.extract)

    return {
      titel: summary.title,
      text,
      quelle: 'Wikipedia',
      url: summary.url,
      hinweis: 'Fass das in eigenen Worten zusammen. Nenne Wikipedia als Quelle, aber keine URL.'
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Nachrichten
// ─────────────────────────────────────────────────────────────

/**
 * Schlagzeilen über den RSS-Dienst von Google News.
 *
 * Kein Schlüssel, keine Anmeldung, keine Kontingentgrenze — der Grund, warum
 * hier RSS steht und nicht eine der Nachrichten-APIs, die alle eine
 * Registrierung verlangen. Der Nutzer soll nichts einrichten müssen.
 *
 * Geparst wird mit einem regulären Ausdruck statt mit einem XML-Parser. Das
 * wäre bei fremdem XML im Allgemeinen falsch; hier ist die Struktur seit Jahren
 * dieselbe, es geht nur um `<title>` und `<pubDate>` je `<item>`, und eine
 * Abhängigkeit für zwei Felder wäre teurer als der Fall, dass ein Titel einmal
 * nicht sauber herausfällt.
 */
async function fetchHeadlines(
  query: string | undefined,
  lang: string,
  region: string
): Promise<{ titel: string; quelle?: string; wann?: string }[]> {
  const locale = `hl=${lang}&gl=${region}&ceid=${region}:${lang}`
  const url = query
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${locale}`
    : `https://news.google.com/rss?${locale}`

  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'Mozilla/5.0' }
  })
  if (!res.ok) return []

  const xml = await res.text()
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? []

  return items.map((item) => {
    const rawTitle = decodeEntities(
      item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] ?? ''
    )
    // Google hängt die Quelle mit einem Bindestrich an: "Schlagzeile - ORF".
    // Getrennt vorgelesen klingt das nach zwei Sätzen, deshalb wird es zerlegt.
    //
    // Der Ausdruck ist gierig und trennt damit am *letzten* Bindestrich. Das
    // ist die einzige Lesart, die beides überlebt: Schlagzeilen, die selbst
    // einen enthalten ("Russland - Gericht schließt Partei aus - Salzburger
    // Nachrichten"), und Quellen, die einen im Namen tragen
    // (motorsport-total.com). Sparsam getrennt bekam man dort die Quelle nicht
    // heraus und las den Domainnamen als Teil der Überschrift vor.
    const split = rawTitle.match(/^(.*)\s+-\s+(.+)$/)
    const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]

    return {
      titel: (split?.[1] ?? rawTitle).trim(),
      quelle: split?.[2]?.trim(),
      wann: pubDate ? new Date(pubDate).toLocaleString('de-AT', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : undefined
    }
  })
}

const newsHeadlines = defineTool({
  name: 'news_headlines',
  group: 'web',
  description:
    'Holt aktuelle Schlagzeilen — entweder allgemein oder zu einem Thema. ' +
    'Für "was gibt es Neues", "Nachrichten aus Österreich", "gibt es was Neues zu X". ' +
    'Liefert Überschriften mit Quelle, keine ausformulierten Artikel. ' +
    'Willst du wissen, was in einer Meldung genau steht, such danach mit web_search.',
  schema: z.object({
    thema: z
      .string()
      .optional()
      .describe('Worum es gehen soll, z.B. "Formel 1" oder "Wien". Ohne Angabe die Topmeldungen.'),
    anzahl: z.number().optional().describe('Wie viele Schlagzeilen, Standard fünf, höchstens zehn.')
  }),
  spokenHint: 'Mhm.',
  async execute({ thema, anzahl }) {
    const lang = languageCode()
    const region = getSettings().telephony?.country ?? 'AT'
    const max = Math.min(10, Math.max(1, anzahl ?? 5))

    const headlines = await fetchHeadlines(thema, lang, region)
    if (headlines.length === 0) {
      throw new Error(
        thema
          ? `Zu "${thema}" finde ich gerade keine Meldungen.`
          : 'Ich bekomme gerade keine Nachrichten. Vielleicht später noch einmal.'
      )
    }

    return {
      thema: thema ?? 'Topmeldungen',
      anzahl: Math.min(max, headlines.length),
      schlagzeilen: headlines.slice(0, max),
      hinweis:
        'Lies die Überschriften vor, kurz und ohne Aufzählungszeichen. Nenne die Quelle nur, ' +
        'wenn danach gefragt wird. Erfinde keine Details, die nicht in der Überschrift stehen.'
    }
  }
}) as ToolDefinition

export const knowledgeTools: ToolDefinition[] = [wikipedia, newsHeadlines]

export const __internals = { decodeEntities }
