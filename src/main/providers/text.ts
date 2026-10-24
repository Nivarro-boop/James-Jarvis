import { friendlyGeminiError, geminiAvailable, generateWithFallback } from './gemini'
import { ollamaReachable, ollamaThink } from './ollama'
import { lmStudioReachable, lmStudioThink } from './lmstudio'
import { ensureLocalServer, localBaseUrl } from '../local/jarvisModels'
import { openRouterAvailable, think as openRouterThink } from './openrouter'
import { cloudTextAvailable, cloudThink } from './cloudText'
import { getSettings } from '../store/settings'
import { report } from '../selfheal'
import { hasChatGptLogin } from './chatgptAuth'
import { chatGptThink } from './chatgptResponses'
import { consumeModelCall } from '../agent/modelBudget'

/**
 * Eine Stelle für alles, was reiner Text ist.
 *
 * Vorher stand die Anbieterwahl im Werkzeug selbst — einmal, in `translate`,
 * als Kette aus drei ineinander geschachtelten Versuchen. Das ging, solange
 * es genau eine Textaufgabe gab. Sobald eine zweite dazukommt, wird daraus
 * dieselbe Kette ein zweites Mal, und ab dann zerfällt die Einstellung in
 * mehrere Stellen, die sich unterschiedlich verhalten. Also hier, einmal.
 *
 * Was eine reine Textaufgabe ist, ist eng gefasst und bleibt es: Text hinein,
 * Text heraus. Kein Grounding, kein Seitenabruf, kein Bild. Alles andere kann
 * den Anbieter gar nicht wechseln, weil es an Gemini-Eigenheiten hängt, für
 * die es weder bei Ollama noch bei OpenRouter ein Gegenstück gibt — siehe
 * `brainProvider` in shared/types.
 *
 * Reihenfolge ist immer: der eingestellte Anbieter zuerst, dann der Rest als
 * Rückfall. Ein Rückfall wird gemeldet, nicht verschwiegen — wer Ollama
 * eingestellt hat und eine Antwort von Gemini bekommt, soll das erfahren
 * können, sonst hält er eine Wolkenantwort für eine lokale.
 */

export type TextProvider = 'gemini' | 'ollama' | 'openrouter' | 'openai' | 'anthropic' | 'chatgpt' | 'lmstudio' | 'jarvis'

export interface TextAnswer {
  text: string
  /** Wer tatsächlich geantwortet hat — nicht, wer eingestellt ist. */
  provider: TextProvider
  /** Das benutzte Modell, für die Anzeige und das Aktionslog. */
  model: string
  /** Gesetzt, wenn nicht der eingestellte Anbieter geantwortet hat. */
  fellBackFrom?: TextProvider
}

export interface TextRequest {
  system: string
  user: string
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * Ob ein Anbieter überhaupt in Frage kommt.
 *
 * Für Ollama ist das eine Netzfrage und keine Schlüsselfrage: Das Programm
 * kann installiert sein und trotzdem nicht laufen. Die Antwort wird eine
 * Minute lang gemerkt, das übernimmt `ollamaReachable`.
 */
async function usable(provider: TextProvider, chosen: TextProvider): Promise<boolean> {
  const settings = getSettings()
  switch (provider) {
    case 'chatgpt':
      return hasChatGptLogin()
    case 'gemini':
      return geminiAvailable()
    case 'openrouter':
      return openRouterAvailable()
    case 'openai':
    case 'anthropic':
      return cloudTextAvailable(provider)
    // Nur wenn ausdrücklich gewählt: ein LM-Studio-Server, der zufällig läuft, ist keine Zusage.
    case 'lmstudio':
      return chosen === 'lmstudio' && lmStudioReachable(settings.lmStudio?.baseUrl)
    // Wie LM Studio nur, wenn ausdrücklich gewählt — das Laden kostet Speicher.
    case 'jarvis':
      return chosen === 'jarvis' && Boolean(settings.jarvisLocal?.model)
    case 'ollama': {
      const local = settings.localFallback
      if (!local?.model) return false
      /*
       * Als Rückfall nur, wenn der Schalter „als Reserve" auch steht.
       *
       * Ohne diese Zeile bekäme jeder, der Ollama für irgendetwas anderes auf
       * dem Rechner laufen hat, bei einem Gemini-Aussetzer stillschweigend
       * eine lokale Antwort — obwohl er die Reserve nie eingeschaltet hat.
       * Ausdrücklich gewählt zu haben ist etwas anderes: Wer oben „Ollama"
       * einstellt, hat die Frage damit beantwortet, und der Reserve-Schalter
       * ist für ihn gar nicht gemeint.
       */
      if (chosen !== 'ollama' && !local.enabled) return false
      return ollamaReachable(local.baseUrl)
    }
  }
}

async function callProvider(provider: TextProvider, req: TextRequest): Promise<TextAnswer> {
  if (provider !== 'chatgpt' && provider !== 'gemini') consumeModelCall()
  const settings = getSettings()
  if (provider === 'chatgpt') {
    const model = settings.chatGptModel
    const text = await chatGptThink(model, req.system, req.user, req.signal)
    if (!text.trim()) throw new Error('ChatGPT hat keine Textantwort geliefert.')
    return { text: text.trim(), provider, model }
  }

  if (provider === 'ollama') {
    const local = settings.localFallback
    const text = await ollamaThink(local.model, req.system, req.user, {
      baseUrl: local.baseUrl,
      maxTokens: req.maxTokens,
      signal: req.signal
    })
    if (!text.trim()) throw new Error(`${local.model} hat nichts geliefert.`)
    return { text: text.trim(), provider, model: local.model }
  }

  if (provider === 'jarvis') {
    await ensureLocalServer()
    const text = await lmStudioThink('', req.system, req.user, { baseUrl: localBaseUrl(), maxTokens: req.maxTokens, signal: req.signal })
    if (!text.trim()) throw new Error('Das lokale Modell hat nichts geliefert.')
    const model = settings.jarvisLocal.model.split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') ?? 'lokal'
    return { text: text.trim(), provider, model }
  }

  if (provider === 'lmstudio') {
    const { baseUrl, model } = settings.lmStudio ?? { baseUrl: '', model: '' }
    const text = await lmStudioThink(model, req.system, req.user, { baseUrl, maxTokens: req.maxTokens, signal: req.signal })
    if (!text.trim()) throw new Error('LM Studio hat nichts geliefert.')
    return { text: text.trim(), provider, model: model || 'LM Studio' }
  }

  if (provider === 'openrouter') {
    const text = await openRouterThink(
      settings.openRouterModel,
      req.system,
      req.user,
      req.maxTokens ?? 1200,
      req.signal
    )
    if (!text.trim()) throw new Error(`${settings.openRouterModel} hat nichts geliefert.`)
    return { text: text.trim(), provider, model: settings.openRouterModel }
  }

  if (provider === 'openai' || provider === 'anthropic') {
    const model = provider === 'openai' ? settings.openAiModel : settings.anthropicModel
    const text = await cloudThink(provider, model, req.system, req.user, req.maxTokens ?? 1200, req.signal)
    if (!text.trim()) throw new Error(`${model} hat nichts geliefert.`)
    return { text: text.trim(), provider, model }
  }

  try {
    const response = await generateWithFallback({
      model: settings.brainModel,
      contents: req.user,
      config: { systemInstruction: req.system, maxOutputTokens: req.maxTokens ?? 1200, abortSignal: req.signal }
    })
    const text = response.text?.trim()
    // Eine leere Antwort ist kein Erfolg. Sie hier als Fehler zu werfen ist
    // das, was den Rückfall überhaupt greifen lässt — sonst gäbe James eine
    // leere Übersetzung als Ergebnis aus.
    if (!text) throw new Error('Gemini hat nichts geliefert.')
    return { text, provider, model: settings.brainModel }
  } catch (err) {
    throw new Error(friendlyGeminiError(err))
  }
}

/**
 * Die Rückfallordnung.
 *
 * Nach dem eingestellten Anbieter kommt Gemini, weil der Schlüssel ohnehin da
 * ist — ohne ihn läuft die App gar nicht. Ollama danach, weil es zwar
 * langsamer ist, aber ohne Kontingent auskommt und genau dann noch antwortet,
 * wenn Geminis Kontingent leer ist. OpenRouter zuletzt: Wer keinen Schlüssel
 * hinterlegt hat, fällt ohnehin durch `usable` heraus.
 */
function fallbackOrder(chosen: TextProvider): TextProvider[] {
  // Choosing the subscription must never silently incur separately billed API usage.
  if (chosen === 'chatgpt') return ['chatgpt']
  const rest: TextProvider[] = (['gemini', 'lmstudio', 'ollama', 'openrouter', 'openai', 'anthropic'] as const).filter(
    (p) => p !== chosen
  )
  return [chosen, ...rest]
}

/**
 * Eine Textaufgabe erledigen lassen.
 *
 * Wirft nur, wenn niemand geantwortet hat — dann aber mit dem Fehler des
 * eingestellten Anbieters, nicht dem des letzten Versuchs. Das ist die
 * Auskunft, die weiterhilft: Wer Ollama eingestellt hat, will wissen, warum
 * Ollama nicht ging, und nicht, was OpenRouter dazu meint.
 */
export async function thinkText(req: TextRequest): Promise<TextAnswer> {
  const chosen = getSettings().brainProvider
  let firstError: Error | null = null

  for (const provider of fallbackOrder(chosen)) {
    req.signal?.throwIfAborted()
    if (!(await usable(provider, chosen))) {
      if (provider === chosen) {
        firstError = new Error(unavailableReason(chosen))
      }
      continue
    }

    try {
      const answer = await callProvider(provider, req)
      req.signal?.throwIfAborted()
      return provider === chosen ? answer : { ...answer, fellBackFrom: chosen }
    } catch (err) {
      req.signal?.throwIfAborted()
      const error = err instanceof Error ? err : new Error(String(err))
      if (error.message.startsWith('Sparlimit:')) throw error
      if (provider === chosen) firstError = error

      // Ein leeres Kontingent ist etwas anderes als ein Aussetzer: Dagegen
      // hilft kein zweiter Versuch, sondern nur ein anderer Anbieter. Das
      // Störungsbuch hält es fest, damit James auf die Frage „warum klingt
      // das anders" antworten kann.
      if (/kontingent|quota|429|resource_exhausted/i.test(error.message)) {
        void report({
          area: 'gemini',
          code: 'kontingent-leer',
          message: `${provider} hat kein Kontingent mehr.`,
          context: { anbieter: provider }
        })
      }
      console.warn(`[text] ${provider} nicht nutzbar:`, error.message.slice(0, 200))
    }
  }

  throw firstError ?? new Error('Für Textaufgaben ist gerade kein Anbieter erreichbar.')
}

function unavailableReason(provider: TextProvider): string {
  switch (provider) {
    case 'chatgpt':
      return 'Es ist keine ChatGPT-Anmeldung hinterlegt. In Zugänge mit ChatGPT anmelden.'
    case 'ollama':
      return (
        'Das lokale Modell antwortet nicht. Prüf in den Einstellungen unter Konten & Standort, ob Ollama ' +
        'läuft und ein Modell ausgewählt ist.'
      )
    case 'jarvis':
      return 'Es ist kein lokales Jarvis-Modell gewählt. Unter Zugänge → Textaufgaben ein Modell von Hugging Face laden.'
    case 'lmstudio':
      return 'LM Studio antwortet nicht. In LM Studio unter „Developer" den Server starten und ein Modell laden.'
    case 'openrouter':
      return 'Es ist kein OpenRouter Zugang hinterlegt.'
    case 'openai':
      return 'Es ist kein OpenAI Zugang hinterlegt.'
    case 'anthropic':
      return 'Es ist kein Anthropic Zugang hinterlegt.'
    case 'gemini':
      return 'Es ist kein Gemini Zugang hinterlegt.'
  }
}

/**
 * Für die Anzeige im Werkzeugergebnis.
 *
 * Nur gefüllt, wenn tatsächlich jemand anderes geantwortet hat als
 * eingestellt. Im Normalfall steht dort nichts, und dann soll auch nichts
 * vorgelesen werden.
 */
export function fallbackNote(answer: TextAnswer): string | undefined {
  if (!answer.fellBackFrom) return undefined
  const names: Record<TextProvider, string> = {
    chatgpt: 'ChatGPT (Abo)',
    gemini: 'Gemini',
    ollama: 'dem lokalen Modell',
    lmstudio: 'LM Studio',
    jarvis: 'dem eigenen lokalen Modell',
    openrouter: 'OpenRouter',
    openai: 'ChatGPT',
    anthropic: 'Claude'
  }
  return `Kam nicht von ${names[answer.fellBackFrom]}, sondern von ${names[answer.provider]}.`
}
