import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { domainOf, extractSources, friendlyGeminiError, generateWithFallback } from '../../providers/gemini'
import { getSettings } from '../../store/settings'

/**
 * Websuche und Seitenabruf über Gemini-Grounding.
 *
 * Der Umweg über einen eigenen Suchdienst plus Crawler lohnt hier nicht:
 * das Grounding liefert bereits verdichtete, zitierte Antworten und spart
 * einen kompletten Abrufzyklus. Für die gesprochene Ausgabe ist das ohnehin
 * das richtige Format — niemand will zehn Suchergebnisse vorgelesen bekommen.
 */

const search = defineTool({
  name: 'web_search',
  group: 'web',
  description:
    'Sucht im Web über Google und liefert eine kurze, mit Quellen belegte Antwort. ' +
    'Nutze das für alles Aktuelle: Preise, Termine, Nachrichten, Spielstände, Öffnungszeiten. ' +
    'Für eine kurze Frage ist das richtig; für eine gründliche Ausarbeitung nimm deep_research.',
  schema: z.object({
    query: z.string().describe('Die Suchanfrage in natürlicher Sprache.'),
    freshness: z
      .enum(['egal', 'heute', 'woche', 'monat'])
      .optional()
      .describe('Wie aktuell das Ergebnis sein muss.')
  }),
  async execute({ query, freshness }, ctx) {
    const settings = getSettings()

    const hint =
      freshness && freshness !== 'egal'
        ? ` Berücksichtige nur Informationen aus dem Zeitraum: ${freshness}.`
        : ''

    try {
      const response = await generateWithFallback({
        model: settings.brainModel,
        contents: `${query}${hint}`,
        config: {
          tools: [{ googleSearch: {} }],
          systemInstruction:
            'Antworte knapp und in ganzen Sätzen auf Deutsch. Keine Aufzählungen, keine Markdown-Zeichen, ' +
            'keine URLs im Text. Die Antwort wird vorgelesen. Nenne konkrete Zahlen und Daten, wenn es welche gibt.'
        }
      })

      const sources = extractSources(response)
      ctx?.show?.({ kind: 'sources', id: `sources:${query.trim().toLowerCase()}`, query, sources: sources.slice(0, 6).map(url => ({ domain: domainOf(url), url })) })
      return {
        answer: response.text,
        // Nur Domains: vollständige URLs sind für eine gesprochene Antwort wertlos.
        sources: sources.slice(0, 6).map(domainOf),
        sourceUrls: sources.slice(0, 6)
      }
    } catch (err) {
      throw new Error(friendlyGeminiError(err))
    }
  }
}) as ToolDefinition

const readUrl = defineTool({
  name: 'read_url',
  group: 'web',
  description:
    'Liest eine oder mehrere Webseiten und beantwortet damit eine Frage. ' +
    'Nutze das, wenn du eine konkrete Adresse hast — etwa aus einer vorherigen Suche.',
  schema: z.object({
    urls: z.array(z.string()).describe('Die Adressen der Seiten, höchstens fünf.'),
    question: z.string().describe('Was aus den Seiten herausgelesen werden soll.')
  }),
  async execute({ urls, question }) {
    const settings = getSettings()
    const limited = urls.slice(0, 5)

    try {
      const response = await generateWithFallback({
        model: settings.brainModel,
        contents: `${question}\n\nSeiten:\n${limited.join('\n')}`,
        config: {
          tools: [{ urlContext: {} }],
          systemInstruction:
            'Antworte knapp auf Deutsch, in ganzen Sätzen, ohne Aufzählungen und ohne Markdown. ' +
            'Wenn eine Seite nicht erreichbar war, sag das in einem Halbsatz.'
        }
      })
      return { answer: response.text, read: limited.map(domainOf) }
    } catch (err) {
      throw new Error(friendlyGeminiError(err))
    }
  }
}) as ToolDefinition

export const webTools: ToolDefinition[] = [search, readUrl]
