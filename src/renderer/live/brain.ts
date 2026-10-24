import { GoogleGenAI } from '@google/genai'
import { withModelFallback } from '@shared/geminiQuota'
import type { Settings } from '@shared/types'
import { compactToolCatalog, parseCompatibilityDecision } from '@shared/ollamaCompat'
import { budgetConversation, budgetCompletedHistory, toolRoundLimit } from '@shared/conversationBudget'
import { ToolLoopGuard, guardedCall, isRunawayRepetition } from '@shared/agentLoop'
import { abortable } from '@shared/async'

/** Hermes-Leitplanken um `hooks.callTool`: Schleifenschutz und Budgetdruck je Beitrag. */
function guardTools(hooks: BrainHooks, limit: number): { hooks: BrainHooks; guard: ToolLoopGuard; setRound(round: number): void } {
  const guard = new ToolLoopGuard()
  let round = 0
  return {
    guard,
    setRound: (value) => { round = value },
    hooks: { ...hooks, callTool: (name, args) => guardedCall(guard, name, args, () => hooks.callTool(name, args), { round, limit }) }
  }
}

/**
 * Wer denkt, während ElevenLabs spricht.
 *
 * Auf dem zusammengesetzten Weg sind Denken und Sprechen zwei Dinge, und das
 * ist der Grund, warum an dieser Stelle überhaupt eine Wahl besteht: Die
 * Live-Sitzung kann nur Gemini, weil Zuhören, Denken und Sprechen dort in einem
 * Stück passieren. Sobald der Text aber ohnehin durch die App läuft, ist es
 * gleichgültig, wer ihn geschrieben hat.
 *
 * Zwei Motoren erfüllen deshalb dieselbe Schnittstelle:
 *
 * - `GeminiBrain` schickt den Ton unverändert an ein gewöhnliches
 *   Gemini-Modell. Es hört den Beitrag selbst, es braucht keine Abschrift, und
 *   es kann Werkzeuge — der kürzeste Weg, wenn ein Schlüssel da ist.
 *
 * - `OllamaBrain` spricht mit einem Modell auf diesem Rechner. Es kostet
 *   nichts, es verlässt die Wohnung nicht, und es braucht dafür zwei Dinge:
 *   ein Modell, das Werkzeuge beherrscht, und eine Abschrift — hören kann ein
 *   Textmodell nicht. Die Abschrift kommt weiterhin von Gemini; das ist
 *   unbefriedigend und ehrlich, und es steht so auch in den Einstellungen.
 *
 * Der Aufrufer kennt den Unterschied nur an `needsText`.
 */

async function admitModelRequest(budgetId?: string): Promise<void> {
  if (budgetId) await window.jarvis.invoke('budget:admit', { budgetId })
}

export interface BrainInput {
  /** Der Beitrag als WAV in base64 — für Motoren, die selbst hören können. */
  wavBase64?: string
  /** Der Beitrag als Wortlaut. Immer gesetzt, wenn `needsText` gilt. */
  text?: string
}

export interface BrainHooks {
  budgetId?: string
  /** Ein Stück Antworttext, so wie es kommt. Geht ohne Umweg an die Stimme. */
  onText(chunk: string): void
  /** Ein Werkzeug ausführen lassen. Fehler kommen als Ergebnis zurück, nicht als Ausnahme. */
  callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: unknown; error?: string }>
  /**
   * Der Wortlaut des Beitrags.
   *
   * Wird erst abgerufen, wenn wirklich ein Werkzeug läuft — der Hauptprozess
   * prüft damit, ob eine Zustimmung durch eine echte Antwort gedeckt ist. Bei
   * einer Antwort ohne Werkzeug kostet er dann gar nichts.
   */
  transcript(): Promise<string>
  /** Abgebrochen — dazwischengeredet, stillgelegt oder Fenster zu. */
  cancelled(): boolean
  /** Bricht auch blockierende HTTP-Anfragen ab. */
  signal?: AbortSignal
}

export interface Brain {
  /** Für Fehlermeldungen und Protokoll. */
  readonly label: string
  /** Braucht dieser Motor den Wortlaut statt des Tons? */
  readonly needsText: boolean
  /**
   * Einmal nachsehen, ob er überhaupt kann. Wirft mit einem Satz, den man
   * jemandem vorlesen kann.
   */
  prepare(signal?: AbortSignal): Promise<void>
  /** Ein Beitrag. Rückgabe: ob dabei etwas gesagt wurde. */
  run(input: BrainInput, hooks: BrainHooks): Promise<boolean>
  /** Neue Sitzung, altes Gespräch vergessen. */
  reset(): void
  update(settings: Settings): void
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(180_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Release IPC listeners even if the main process never confirms cancellation. */
async function awaitBrainRequest<T>(hooks: BrainHooks, run: () => Promise<T>, cancel: () => void): Promise<T> {
  const abort = new AbortController()
  const signal = requestSignal(hooks.signal ? AbortSignal.any([hooks.signal, abort.signal]) : abort.signal)
  const watch = setInterval(() => { if (hooks.cancelled()) abort.abort() }, 100)
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (hooks.cancelled()) abort.abort()
    signal.throwIfAborted()
    return await abortable(run(), signal)
  } finally {
    clearInterval(watch)
    signal.removeEventListener('abort', cancel)
  }
}

// ─────────────────────────────────────────────────────────────
// Gemini
// ─────────────────────────────────────────────────────────────

type Part = Record<string, unknown>
interface Turn {
  role: 'user' | 'model'
  parts: Part[]
}

export class GeminiBrain implements Brain {
  readonly label = 'Gemini'
  readonly needsText = false

  private settings: Settings
  private ai: GoogleGenAI | null = null
  private history: Turn[] = []

  constructor(settings: Settings) {
    this.settings = settings
  }

  update(settings: Settings): void {
    this.settings = settings
  }

  reset(): void {
    this.history = []
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    const apiKey = await abortable(window.jarvis.invoke('secrets:getGeminiForLive'), requestSignal(signal))
    if (!apiKey) throw new Error('Es ist kein Gemini Zugang hinterlegt.')
    this.ai = new GoogleGenAI({ apiKey })
  }

  async run(input: BrainInput, hooks: BrainHooks): Promise<boolean> {
    if (hooks.cancelled()) return false
    if (!this.ai) await this.prepare(hooks.signal)
    const ai = this.ai
    if (!ai) return false

    const parts: Part[] = input.wavBase64
      ? [{ inlineData: { mimeType: 'audio/wav', data: input.wavBase64 } }]
      : [{ text: input.text ?? '' }]

    const [basePrompt, tools] = await abortable(Promise.all([
      window.jarvis.invoke('agent:systemPrompt', { query: input.text }),
      window.jarvis.invoke('agent:toolDeclarations')
    ]), requestSignal(hooks.signal))
    if (hooks.cancelled()) return false
    const systemPrompt = withVoiceBudget(basePrompt, this.settings)

    const contents: Turn[] = [...budgetCompletedHistory(this.history, this.settings.tokenSaver.enabled), { role: 'user', parts }]
    let spoke = false

    const guarded = guardTools(hooks, toolRoundLimit(this.settings.tokenSaver.enabled))
    for (let round = 0; round < toolRoundLimit(this.settings.tokenSaver.enabled); round++) {
      if (hooks.cancelled()) return spoke
      guarded.setRound(round)
      /**
       * Werkzeuge nur, solange noch eine Runde übrig ist.
       *
       * In der letzten Runde werden sie weggelassen, und das ist keine
       * Sparmaßnahme: Ein Modell, das bis zuletzt Werkzeuge aufruft, hat am
       * Ende nichts gesagt — und Stille sieht aus wie ein Ausfall. Ohne
       * Werkzeuge bleibt ihm nur die Antwort.
       */
      const last = round === toolRoundLimit(this.settings.tokenSaver.enabled) - 1 || guarded.guard.halted
      // Das Kontingent zählt je Modell: Ist das eingestellte für heute leer,
      // antwortet ein anderes. Der Fehler kommt beim Öffnen des Stroms, nicht
      // mittendrin — deshalb genügt es, diesen Aufruf zu umschließen.
      const stream = await withModelFallback(this.settings.speech.brainModel, (model) =>
        admitModelRequest(hooks.budgetId).then(() => ai.models.generateContentStream({
          model,
          contents: contents as never,
          config: {
            abortSignal: requestSignal(hooks.signal),
            systemInstruction: { parts: [{ text: systemPrompt }] },
            ...(this.settings.tokenSaver.enabled ? { maxOutputTokens: 700 } : {}),
            ...(last ? {} : { tools: tools as never })
          }
        }))
      )

      /**
       * Die Teile der Antwort werden unverändert übernommen — nicht neu gebaut.
       *
       * Das ist keine Bequemlichkeit. Gemini 3 hängt an jeden Werkzeugaufruf
       * eine `thoughtSignature`, und die muss in der nächsten Runde unverändert
       * zurückkommen. Beim ersten Anlauf stand hier ein nachgebautes
       * `{ name, args }` — sauber aussehend, aber ohne Signatur, und die Antwort
       * darauf war ein glasklares "Function call is missing a thought_signature".
       * Wer die Teile durchreicht, kann diesen Fehler nicht machen.
       */
      const modelParts: Part[] = []
      const calls: { name: string; args: Record<string, unknown> }[] = []

      let roundText = ''
      let runaway = false
      stream: for await (const chunk of stream) {
        if (hooks.cancelled()) return spoke
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          modelParts.push(part as Part)

          // Gedankenteile sind nicht für Ohren bestimmt. Sie mitzusprechen wäre
          // nicht nur seltsam, sondern bezahlte Zeichen für Selbstgespräche.
          if (part.thought) continue

          if (typeof part.text === 'string' && part.text.length > 0) {
            spoke = true
            hooks.onText(part.text)
            roundText += part.text
            // Festgefahrenes Modell: abbrechen statt endlos vorlesen.
            if (isRunawayRepetition(roundText)) { runaway = true; break stream }
          }
          if (part.functionCall) {
            calls.push({
              name: part.functionCall.name ?? '',
              args: (part.functionCall.args ?? {}) as Record<string, unknown>
            })
          }
        }
      }

      if (runaway) break
      if (hooks.cancelled()) return spoke
      contents.push({ role: 'model', parts: modelParts })
      if (calls.length === 0) break

      /**
       * Erst jetzt wird der Wortlaut gebraucht — und erst jetzt gewartet.
       *
       * Das Ergebnis wird hier nicht gelesen, und trotzdem ist die Zeile keine
       * Zierde: Der Hauptprozess prüft bei heiklen Werkzeugen, ob eine
       * Zustimmung durch eine echte Antwort gedeckt ist, und dafür muss die
       * Abschrift vor dem ersten Aufruf da sein.
       */
      await hooks.transcript()
      if (hooks.cancelled()) return spoke

      const answers = await Promise.all(
        calls.map(async (call) => {
          const result = await guarded.hooks.callTool(call.name, call.args)
          return {
            functionResponse: {
              name: call.name,
              // Fehler gehören als Inhalt in die Antwort, nicht als Ausfall:
              // sonst wartet das Modell ewig oder erfindet ein Ergebnis.
              response: result.ok
                ? { output: result.result ?? 'Erledigt.' }
                : { error: result.error ?? 'Unbekannter Fehler.' }
            }
          }
        })
      )
      contents.push({ role: 'user', parts: answers })
    }

    // Nur die letzten Beiträge behalten — Ton im Verlauf wiegt schwer.
    if (!hooks.cancelled()) this.history = budgetCompletedHistory(contents, this.settings.tokenSaver.enabled)
    return spoke
  }
}

// ─────────────────────────────────────────────────────────────
// Ollama
// ─────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[]
  tool_name?: string
}

interface OllamaChunk {
  message?: {
    content?: string
    tool_calls?: { function?: { name?: string; arguments?: Record<string, unknown> | string } }[]
  }
  done?: boolean
  error?: string
}

export class OllamaBrain implements Brain {
  readonly label = 'Ollama'
  /** Ein Textmodell hört nichts. Der Wortlaut muss vorher da sein. */
  readonly needsText = true

  private settings: Settings
  private history: ChatMessage[] = []

  /**
   * Darf diesem Modell überhaupt ein Werkzeug angeboten werden?
   *
   * Nicht jedes kann welche, und Ollama nimmt das genau: Wer einem Modell ohne
   * Werkzeugunterstützung welche mitschickt, bekommt keine Antwort, sondern
   * einen glatten "does not support tools". Ein solches Modell läuft deshalb
   * über den JSON-Kompatibilitätsmodus statt native Tool Calls zu bekommen.
   * Wird in `prepare` einmal geklärt.
   */
  private canUseTools = true

  constructor(settings: Settings) {
    this.settings = settings
  }

  update(settings: Settings): void {
    this.settings = settings
  }

  reset(): void {
    this.history = []
  }

  private base(): string {
    return this.settings.ollama.baseUrl.replace(/\/+$/, '')
  }

  /**
   * Läuft Ollama, und kennt es das eingestellte Modell?
   *
   * Beides wird gefragt statt angenommen. Der Unterschied ist der zwischen
   * "Ollama läuft nicht" und "das Modell ist nicht geladen", und wer das
   * zusammenwirft, sucht den Fehler an der falschen Stelle.
   */
  async prepare(signal?: AbortSignal): Promise<void> {
    const wanted = this.settings.ollama.model
    if (!wanted) throw new Error('Es ist kein Ollama-Modell eingestellt.')

    let names: string[]
    try {
      const response = await fetch(`${this.base()}/api/tags`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000)
      })
      if (!response.ok) throw new Error(String(response.status))
      const data = (await response.json()) as { models?: { name?: string }[] }
      names = (data.models ?? []).map((m) => m.name ?? '')
    } catch {
      throw new Error('Ollama antwortet nicht. Läuft es auf diesem Rechner?')
    }

    // Ollama führt Modelle mit Kennzeichnung ("gemma:2b"); wer nur den Namen
    // einträgt, meint die Standardausführung, und die heißt intern ":latest".
    const known = names.some((name) => name === wanted || name.split(':')[0] === wanted)
    if (!known) {
      throw new Error(`Ollama kennt das Modell ${wanted} nicht. Erst mit ollama pull holen.`)
    }

    /**
     * Und was kann es? Ollama sagt es, ohne das Modell dafür zu laden.
     *
     * Kein Grund zum Abbrechen, wenn Werkzeuge fehlen: Reden kann jedes Modell,
     * und eine Antwort ohne Handlung ist mehr als eine Fehlermeldung. Gesagt
     * wird es trotzdem — auf der Einstellungsseite steht es, und im Protokoll
     * steht es auch, damit sich niemand wundert, warum nichts passiert.
     */
    try {
      const response = await fetch(`${this.base()}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000),
        body: JSON.stringify({ model: wanted })
      })
      const data = response.ok ? ((await response.json()) as { capabilities?: string[] }) : {}
      this.canUseTools = (data.capabilities ?? []).includes('tools')
    } catch (err) {
      if (signal?.aborted) throw err
      // Antwortet die Auskunft nicht, wird es versucht: Ein Modell ohne
      // Werkzeuge scheitert dann hörbar, und das ist besser, als einem
      // Modell mit Werkzeugen stillschweigend die Hände zu binden.
      this.canUseTools = true
    }

    if (!this.canUseTools) {
      // Kein harter Abbruch: Der Kompatibilitätsweg unten lässt auch ein
      // gewöhnliches Chatmodell Werkzeuge über ein streng gelesenes
      // JSON-Protokoll auswählen. Native Tool Calls bleiben schneller und
      // zuverlässiger, sind aber keine Voraussetzung mehr dafür, dass das
      // eingestellte lokale Modell überhaupt antworten darf.
      console.info(
        `[ollama] ${wanted} hat keine nativen Werkzeugaufrufe — nutze den JSON-Kompatibilitätsmodus.`
      )
    }
  }

  async run(input: BrainInput, hooks: BrainHooks): Promise<boolean> {
    const text = (input.text ?? '').trim()
    if (!text || hooks.cancelled()) return false

    const [basePrompt, tools] = await abortable(Promise.all([
      window.jarvis.invoke('agent:systemPrompt', { query: input.text }),
      window.jarvis.invoke('agent:toolSchemas')
    ]), requestSignal(hooks.signal))
    if (hooks.cancelled()) return false
    const systemPrompt = withVoiceBudget(basePrompt, this.settings)
    const nativeTools = compactToolCatalog(tools)

    if (!this.canUseTools) {
      return this.runCompatibility(text, hooks, tools, systemPrompt)
    }

    const messages: ChatMessage[] = [...budgetCompletedHistory(this.history, this.settings.tokenSaver.enabled), { role: 'user', content: text }]
    let spoke = false

    const guarded = guardTools(hooks, toolRoundLimit(this.settings.tokenSaver.enabled))
    for (let round = 0; round < toolRoundLimit(this.settings.tokenSaver.enabled); round++) {
      if (hooks.cancelled()) return spoke
      guarded.setRound(round)
      const last = round === toolRoundLimit(this.settings.tokenSaver.enabled) - 1 || guarded.guard.halted
      const calls: { name: string; args: Record<string, unknown> }[] = []
      let answer = ''

      const body = {
        model: this.settings.ollama.model,
        stream: true,
        messages: [{ role: 'system' as const, content: systemPrompt }, ...messages],
        ...(last || !this.canUseTools ? {} : { tools: nativeTools }),
        /**
         * Das Modell im Speicher halten.
         *
         * Ollama räumt es sonst nach fünf Minuten weg, und der nächste Satz
         * wartet dann, bis mehrere Gigabyte von der Platte gelesen sind — bei
         * einem Sprachassistenten ist das der Unterschied zwischen einer
         * Antwort und einem Aussetzer.
         */
        keep_alive: `${this.settings.ollama.keepAliveMin}m`,
        options: { temperature: 0.6, ...(this.settings.tokenSaver.enabled ? { num_predict: 700 } : {}) }
      }

      await admitModelRequest(hooks.budgetId)
      const response = await fetch(`${this.base()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: requestSignal(hooks.signal)
      })
      if (!response.ok || !response.body) {
        /**
         * Der Grund steht im Rumpf, nicht im Status.
         *
         * "Ollama hat abgelehnt (403)" ist keine Auskunft, sondern eine Zahl.
         * Daneben stand die ganze Zeit ein ganzer Satz — beim ersten Testlauf
         * etwa der, dass ein Cloud-Modell ein Abo verlangt. Wer ihn wegwirft,
         * lässt jemanden an der falschen Stelle suchen.
         */
        const refusal = await explainRefusal(response)
        // `/api/show` ist bei älteren Ollama-Fassungen und manchen importierten
        // Modellen nicht verlässlich. Sagt erst der echte Chat-Aufruf, dass
        // Tools fehlen, denselben Beitrag ohne Verlust im kompatiblen Modus
        // noch einmal ausführen statt auf Gemini umzuschalten.
        if (round === 0 && refusal.includes('keine Werkzeuge')) {
          this.canUseTools = false
          return this.runCompatibility(text, hooks, tools, systemPrompt)
        }
        throw new Error(`Ollama: ${refusal}`)
      }

      for await (const chunk of readNdjson<OllamaChunk>(response.body)) {
        if (hooks.cancelled()) return spoke
        if (chunk.error) throw new Error(chunk.error)

        const piece = chunk.message?.content ?? ''
        if (piece) {
          answer += piece
          spoke = true
          hooks.onText(piece)
          if (isRunawayRepetition(answer)) { calls.length = 0; break }
        }
        for (const call of chunk.message?.tool_calls ?? []) {
          const name = call.function?.name
          if (!name) continue
          const raw = call.function?.arguments
          // Manche Modelle liefern die Argumente als JSON-Text statt als Objekt.
          const args =
            typeof raw === 'string' ? (safeJson(raw) ?? {}) : ((raw ?? {}) as Record<string, unknown>)
          calls.push({ name, args })
        }
      }

      // Einige Streaming-Templates wiederholen denselben vollständigen Call
      // im Abschlussblock. Ohne Deduplizierung würde eine Mail oder Datei dann
      // zweimal ausgeführt. Name plus stabil serialisierte Argumente reichen
      // als Identität innerhalb genau dieser Modellrunde.
      const distinctCalls = calls.filter((call, index) => {
        const key = `${call.name}:${stringify(call.args)}`
        return calls.findIndex((candidate) => `${candidate.name}:${stringify(candidate.args)}` === key) === index
      })

      messages.push({
        role: 'assistant',
        content: answer,
        ...(distinctCalls.length > 0
          ? { tool_calls: distinctCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) }
          : {})
      })
      if (distinctCalls.length === 0) break

      for (const call of distinctCalls) {
        if (hooks.cancelled()) return spoke
        const result = await guarded.hooks.callTool(call.name, call.args)
        messages.push({
          role: 'tool',
          tool_name: call.name,
          content: result.ok
            ? stringify(result.result ?? 'Erledigt.')
            : `Fehler: ${result.error ?? 'unbekannt'}`
        })
      }
    }

    if (!hooks.cancelled()) this.history = budgetCompletedHistory(messages, this.settings.tokenSaver.enabled)
    return spoke
  }

  /**
   * Werkzeugschleife für Modelle ohne native Tool Calls.
   *
   * Das Modell bekommt keine Erlaubnis, freien Text als Befehl auszugeben.
   * Jede Runde muss genau eines von zwei JSON-Objekten liefern: Antwort oder
   * Werkzeug. Name und Argumente gehen danach durch dieselbe Registry,
   * Zod-Prüfung und Rechte-Engine wie ein nativer Aufruf. Ein halluzinierter
   * Name wird also zum gewöhnlichen Werkzeugfehler und nie direkt ausgeführt.
   */
  private async runCompatibility(
    text: string,
    hooks: BrainHooks,
    tools: unknown[],
    systemPrompt: string
  ): Promise<boolean> {
    const messages: ChatMessage[] = [...budgetCompletedHistory(this.history, this.settings.tokenSaver.enabled), { role: 'user', content: text }]
    const compact = compactToolCatalog(tools) as Array<{
      type?: string
      function?: { name?: string; description?: string; parameters?: Record<string, unknown> }
    }>
    // Die erste Stufe entscheidet nur *welches* Werkzeug. Hundert vollständige
    // Parameterschemata gleichzeitig überfordern kleine Modelle und fressen
    // ihren Kontext. Sobald der Name feststeht, bekommt eine zweite, streng
    // strukturierte Runde ausschließlich dessen Schema.
    const catalog = compact.map((tool) => ({
      name: tool.function?.name,
      description: tool.function?.description
    }))
    const protocol = [
      systemPrompt,
      '',
      '## Werkzeug-Kompatibilitätsmodus',
      'Antworte ausschließlich als ein einzelnes JSON-Objekt ohne Markdown.',
      'Für eine normale Antwort: {"action":"answer","text":"deine Antwort"}.',
      'Für eine Handlung: {"action":"tool","name":"exakter Werkzeugname","arguments":{...}}.',
      'Wenn irgendein Werkzeug zur Frage passt, MUSST du action tool wählen. Aktuelle Daten darfst du nie erfinden.',
      'Erfinde keinen Werkzeugnamen und führe nie eine Handlung nur im Text aus. In dieser ersten Stufe zählt vor allem der Name.',
      'Wenn ein Werkzeug einen Fehler oder eine Rückfrage liefert, beachte diesen Inhalt in der nächsten Runde.',
      `Verfügbare Werkzeuge: ${JSON.stringify(catalog)}`
    ].join('\n')
    let spoke = false

    const guarded = guardTools(hooks, toolRoundLimit(this.settings.tokenSaver.enabled))
    for (let round = 0; round < toolRoundLimit(this.settings.tokenSaver.enabled); round++) {
      guarded.setRound(round)
      if (hooks.cancelled()) return spoke
      const last = round === toolRoundLimit(this.settings.tokenSaver.enabled) - 1 || guarded.guard.halted
      const requestMessages: ChatMessage[] = [
        { role: 'system', content: last ? `${protocol}\nDies ist die letzte Runde: action muss answer sein.` : protocol },
        ...messages
      ]
      await admitModelRequest(hooks.budgetId)
      const response = await fetch(`${this.base()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.settings.ollama.model,
          stream: false,
          format: 'json',
          messages: requestMessages,
          keep_alive: `${this.settings.ollama.keepAliveMin}m`,
          options: { temperature: 0, ...(this.settings.tokenSaver.enabled ? { num_predict: 700 } : {}) }
        }),
        signal: requestSignal(hooks.signal)
      })
      if (!response.ok) throw new Error(`Ollama: ${await explainRefusal(response)}`)

      const payload = (await response.json()) as OllamaChunk
      if (hooks.cancelled()) return spoke
      if (payload.error) throw new Error(payload.error)
      const raw = payload.message?.content ?? ''
      const decision = parseCompatibilityDecision(raw)

      if (decision.action === 'tool' && !last) {
        const definition = compact.find((tool) => tool.function?.name === decision.name)
        const args = definition
          ? await this.extractCompatibilityArguments(decision.name, definition.function?.parameters, messages, hooks.signal, hooks.budgetId)
          : decision.arguments
        const exactDecision = { ...decision, arguments: args }
        if (hooks.cancelled()) return spoke
        messages.push({ role: 'assistant', content: JSON.stringify(exactDecision) })
        const result = await guarded.hooks.callTool(decision.name, args)
        messages.push({
          role: 'tool',
          tool_name: decision.name,
          content: result.ok
            ? stringify(result.result ?? 'Erledigt.')
            : `Fehler: ${result.error ?? 'unbekannt'}`
        })
        continue
      }

      const answer =
        decision.action === 'answer'
          ? decision.text
          : 'Ich konnte die Aufgabe in der verfügbaren Zahl von Werkzeugschritten nicht abschließen.'
      if (answer) {
        hooks.onText(answer)
        spoke = true
      }
      messages.push({ role: 'assistant', content: answer })
      break
    }

    if (!hooks.cancelled()) this.history = budgetCompletedHistory(messages, this.settings.tokenSaver.enabled)
    return spoke
  }

  /** Zweite Kompatibilitätsstufe: nur die Argumente eines bereits gewählten Werkzeugs. */
  private async extractCompatibilityArguments(
    name: string,
    parameters: Record<string, unknown> | undefined,
    messages: ChatMessage[],
    signal?: AbortSignal,
    budgetId?: string
  ): Promise<Record<string, unknown>> {
    const schema =
      parameters && parameters.type === 'object'
        ? parameters
        : { type: 'object', properties: {} }
    if (
      schema.properties &&
      typeof schema.properties === 'object' &&
      Object.keys(schema.properties as Record<string, unknown>).length === 0
    ) {
      return {}
    }

    await admitModelRequest(budgetId)
    const response = await fetch(`${this.base()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.settings.ollama.model,
        stream: false,
        format: schema,
        messages: [
          {
            role: 'system',
            content:
              `Extrahiere ausschließlich die Argumente für das Werkzeug ${name} aus dem Gespräch. ` +
              'Antworte nur mit dem JSON-Objekt nach dem vorgegebenen Schema. Übernimm Namen, Orte, ' +
              'Texte und Zahlen exakt aus der Nutzerfrage; erfinde keine Platzhalter oder Beispielwerte.'
          },
          ...messages.slice(-6)
        ],
        keep_alive: `${this.settings.ollama.keepAliveMin}m`,
        options: { temperature: 0, ...(this.settings.tokenSaver.enabled ? { num_predict: 700 } : {}) }
      }),
      signal: requestSignal(signal)
    })
    if (!response.ok) throw new Error(`Ollama: ${await explainRefusal(response)}`)
    const payload = (await response.json()) as OllamaChunk
    const parsed = safeJson(payload.message?.content ?? '')
    return parsed ?? {}
  }
}

/**
 * Ollama antwortet in Zeilen, nicht in Ereignissen.
 *
 * Jede Zeile ist ein eigenes JSON-Objekt, und ein Netzblock endet nicht
 * zwangsläufig an einem Zeilenende — der Rest muss deshalb bis zum nächsten
 * Block liegen bleiben. Ohne diesen Übertrag zerfällt genau dann eine Antwort,
 * wenn sie lang genug ist, um interessant zu sein.
 */
async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let rest = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += decoder.decode(value, { stream: true })
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parsed = safeJson(trimmed)
        if (parsed) yield parsed as T
      }
    }
    const tail = rest.trim()
    if (tail) {
      const parsed = safeJson(tail)
      if (parsed) yield parsed as T
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

/**
 * Warum Ollama nicht mitmacht — in einem Satz, mit dem man etwas anfangen kann.
 *
 * Der Anbieter schreibt seinen Grund als JSON in den Rumpf. Die beiden Fälle,
 * die beim ersten Testlauf tatsächlich auftraten, bekommen einen eigenen Satz;
 * alles andere wird durchgereicht, denn ein englischer Satz vom Anbieter ist
 * immer noch mehr als eine Zahl von mir.
 */
async function explainRefusal(response: Response): Promise<string> {
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    return `abgelehnt (${response.status}).`
  }

  const message = (safeJson(raw)?.error as string | undefined) ?? raw.trim()
  const lower = message.toLowerCase()

  if (lower.includes('does not support tools')) {
    return 'Dieses Modell kann keine Werkzeuge nativ.'
  }
  if (lower.includes('subscription') || lower.includes('upgrade for access')) {
    return 'Dieses Modell läuft in Ollamas Cloud und verlangt dort ein Abo. Ein Modell, das auf diesem Rechner liegt, kostet nichts.'
  }
  if (response.status === 404) {
    return 'Das Modell ist nicht da. Erst mit ollama pull holen.'
  }
  return message || `abgelehnt (${response.status}).`
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ─────────────────────────────────────────────────────────────
// ChatGPT-Abo
// ─────────────────────────────────────────────────────────────

type ChatGptItem = Record<string, unknown>

/**
 * Denkt über das ChatGPT-Abo des Nutzers.
 *
 * Hören kann es nicht, deshalb wie bei Ollama mit Abschrift. Die Anmeldung
 * und der eigentliche Aufruf bleiben im Hauptprozess; hier läuft nur die
 * Werkzeugschleife, damit Rechte und Rückfragen denselben Weg nehmen wie bei
 * jedem anderen Motor.
 */
export class ChatGptBrain implements Brain {
  readonly label = 'ChatGPT'
  readonly needsText = true

  private settings: Settings
  private history: ChatGptItem[] = []

  constructor(settings: Settings) {
    this.settings = settings
  }

  update(settings: Settings): void {
    this.settings = settings
  }

  reset(): void {
    this.history = []
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    const status = await abortable(window.jarvis.invoke('chatgpt:status'), requestSignal(signal))
    if (!status.connected) throw new Error('ChatGPT ist nicht angemeldet. In den Einstellungen unter Konten & Standort anmelden.')
    if (!this.settings.chatGptModel) throw new Error('Es ist kein ChatGPT-Modell ausgewählt.')
  }

  async run(input: BrainInput, hooks: BrainHooks): Promise<boolean> {
    const text = (input.text ?? '').trim()
    if (!text || hooks.cancelled()) return false

    const systemPrompt = withVoiceBudget(await abortable(window.jarvis.invoke('agent:systemPrompt', { query: input.text }), requestSignal(hooks.signal)), this.settings)
    if (hooks.cancelled()) return false
    const items: ChatGptItem[] = [...budgetConversation(this.history, this.settings.tokenSaver.enabled), { role: 'user', content: text }]
    let spoke = false
    let answer = ''

    const guarded = guardTools(hooks, toolRoundLimit(this.settings.tokenSaver.enabled))
    for (let round = 0; round < toolRoundLimit(this.settings.tokenSaver.enabled); round++) {
      if (hooks.cancelled()) return spoke
      guarded.setRound(round)
      const requestId = crypto.randomUUID()
      let roundText = ''
      let runaway = false
      let cancelling = false
      const cancel = (): void => {
        if (cancelling) return
        cancelling = true
        void window.jarvis.invoke('chatgpt:cancel', { requestId }).catch(() => undefined)
      }
      const stopDelta = window.jarvis.on('chatgpt:delta', (delta) => {
        if (delta.requestId !== requestId || hooks.cancelled() || runaway) return
        answer += delta.text
        roundText += delta.text
        spoke = true
        hooks.onText(delta.text)
        if (isRunawayRepetition(roundText)) {
          runaway = true
          cancel()
        }
      })

      let result
      try {
        result = await awaitBrainRequest({ ...hooks, cancelled: () => hooks.cancelled() || runaway }, () => window.jarvis.invoke('chatgpt:respond', {
          requestId,
          model: this.settings.chatGptModel,
          instructions: systemPrompt,
          input: items,
          tools: round < toolRoundLimit(this.settings.tokenSaver.enabled) - 1 && !guarded.guard.halted,
          budgetId: hooks.budgetId
        }), cancel)
      } catch (err) {
        if (runaway) break
        if (hooks.cancelled()) return spoke
        throw err
      } finally {
        stopDelta()
      }
      if (hooks.cancelled()) return spoke
      if (runaway) break
      if (!result.ok) throw new Error(result.error)
      // Final IPC result is also authoritative when the window missed a delta event.
      const finalText = result.response.text ?? ''
      const missingText = !roundText ? finalText : finalText.startsWith(roundText) ? finalText.slice(roundText.length) : ''
      if (missingText) {
        answer += missingText
        spoke = true
        hooks.onText(missingText)
      }

      const calls = result.response.output.filter((item) => item.type === 'function_call')
      // Ohne gespeicherte Antwort (store: false) kennt der Server die
      // Denk-Einträge nicht wieder; mitgeschickt würden sie abgelehnt.
      // Ohne `id`: Mit store: false hat der Server diese Einträge nie
      // gespeichert und lehnt Verweise auf ihre Kennungen ab.
      items.push(
        ...result.response.output
          .filter((item) => item.type !== 'reasoning')
          .map(({ id: _id, ...item }) => item)
      )
      if (calls.length === 0) break

      for (const call of calls) {
        if (hooks.cancelled()) return spoke
        const name = String(call.name ?? '').replace(/^jarvis\./, '')
        const args = typeof call.arguments === 'string' ? (safeJson(call.arguments) ?? {}) : {}
        const outcome = await guarded.hooks.callTool(name, args)
        items.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: outcome.ok ? stringify(outcome.result ?? 'Erledigt.') : `Fehler: ${outcome.error ?? 'unbekannt'}`
        })
        if (hooks.cancelled()) return spoke
      }
    }

    // Im Gedächtnis der Sitzung nur Frage und Antwort, nicht die
    // Werkzeugrunden — die wären bei der nächsten Frage nur Ballast.
    if (!hooks.cancelled()) this.history = budgetConversation([
      ...this.history,
      { role: 'user', content: text },
      ...(answer ? [{ role: 'assistant', content: answer }] : [])
    ], this.settings.tokenSaver.enabled)
    return spoke
  }
}

/** Welcher Motor denkt — die Entscheidung steht in den Einstellungen. */
export function createBrain(settings: Settings): Brain {
  if (settings.speech.thinkProvider === 'ollama') return new OllamaBrain(settings)
  if (settings.speech.thinkProvider === 'chatgpt') return new ChatGptBrain(settings)
  return new GeminiBrain(settings)
}

/** Spart bezahlte Sprechzeichen, ohne Werkzeugargumente oder Ergebnisse zu beschneiden. */
function withVoiceBudget(prompt: string, settings: Settings): string {
  if (settings.speech.provider !== 'elevenlabs') return prompt
  const plan = settings.speech.elevenPlan
  if (plan === 'quality') {
    return `${prompt}\n\nAntworte für natürliche Sprachausgabe: flüssig, ohne Markdown-Tabellen und ohne rohe URLs.`
  }
  if (plan === 'balanced') {
    return (
      `${prompt}\n\nAntworte sprachgerecht und knapp. Vermeide Wiederholungen, Markdown-Tabellen und rohe URLs. ` +
      'Nenne zuerst das Ergebnis; Details nur, wenn sie helfen oder verlangt wurden.'
    )
  }
  return (
    `${prompt}\n\nElevenLabs-Sparmodus: Nenne zuerst das Ergebnis und antworte normalerweise in höchstens ` +
    'drei kurzen Sätzen. Keine Wiederholung der Frage, keine Markdown-Tabellen und keine rohen URLs. ' +
    'Wenn der Nutzer ausdrücklich Details verlangt, gib sie vollständig, aber ohne Füllsätze.'
  )
}
