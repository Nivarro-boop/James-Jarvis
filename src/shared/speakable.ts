/**
 * Aus geschriebenem Text wird gesprochener.
 *
 * Der System-Prompt bittet das Modell, nicht wie ein Dokument zu schreiben —
 * keine Sternchen, keine Adressen, keine Abkürzungen. Es hält sich meistens
 * daran und manchmal nicht, und das eine Mal, in dem es "**Preis:** 49,90 €"
 * schreibt, hört man sofort: Die Stimme sagt dann "Sternchen Sternchen Preis"
 * oder verschluckt die Betonung. Eine Bitte ist keine Garantie, also wird hier
 * nachgeräumt.
 *
 * Dazu der zweite Teil, der genauso viel ausmacht: **wann** ein Stück Text
 * losgeschickt wird. Ein Modell liefert seinen Text in Bruchstücken, die an
 * beliebiger Stelle enden — mitten im Wort, mitten in der Zahl, mitten in einem
 * Sternchenpaar. Wer die unverändert weiterreicht, gibt der Stimme Silben statt
 * Sätze, und Betonung entsteht nun einmal über den ganzen Satz. Der Satzpuffer
 * sammelt deshalb, bis ein Satz zu Ende ist, und schickt ihn dann als Ganzes.
 *
 * Beides steht in `shared`, weil es keine Umgebung braucht — und weil es damit
 * unter `tests/` geprüft werden kann, ohne eine Tonausgabe zu bauen.
 */

// ─────────────────────────────────────────────────────────────
// Sprechbar machen
// ─────────────────────────────────────────────────────────────

/**
 * Abkürzungen, die geschrieben kürzer sind und gesprochen falsch.
 *
 * "z. B." liest jede Stimme als "zett be". Die Liste ist bewusst kurz: nur was
 * in gesprochenen Antworten wirklich vorkommt. Jede weitere Zeile ist eine
 * Gelegenheit, etwas zu ersetzen, das gar nicht gemeint war.
 */
const ABBREVIATIONS: [RegExp, string][] = [
  [/\bz\.\s?B\./gi, 'zum Beispiel'],
  [/\bd\.\s?h\./gi, 'das heißt'],
  [/\bu\.\s?a\./gi, 'unter anderem'],
  [/\bbzw\./gi, 'beziehungsweise'],
  [/\bggf\./gi, 'gegebenenfalls'],
  [/\bevtl\./gi, 'eventuell'],
  [/\binkl\./gi, 'inklusive'],
  [/\bexkl\./gi, 'exklusive'],
  [/\bca\./gi, 'circa'],
  [/\busw\./gi, 'und so weiter'],
  [/\betc\./gi, 'und so weiter'],
  [/\bNr\./g, 'Nummer'],
  [/\bMio\./gi, 'Millionen'],
  [/\bMrd\./gi, 'Milliarden'],
  [/\bTsd\./gi, 'Tausend'],
  [/\bStk\./gi, 'Stück'],
  [/\bvgl\./gi, 'vergleiche']
]

/** Einheiten, aber nur direkt hinter einer Zahl — sonst wird aus "GB" ein Name. */
const UNITS: [RegExp, string][] = [
  [/(\d)\s?km\/h\b/g, '$1 Kilometer pro Stunde'],
  [/(\d)\s?GHz\b/g, '$1 Gigahertz'],
  [/(\d)\s?MHz\b/g, '$1 Megahertz'],
  [/(\d)\s?TB\b/g, '$1 Terabyte'],
  [/(\d)\s?GB\b/g, '$1 Gigabyte'],
  [/(\d)\s?MB\b/g, '$1 Megabyte'],
  [/(\d)\s?KB\b/g, '$1 Kilobyte'],
  [/(\d)\s?°\s?C\b/g, '$1 Grad Celsius'],
  [/(\d)\s?°\b/g, '$1 Grad'],
  [/(\d)\s?km\b/g, '$1 Kilometer'],
  [/(\d)\s?cm\b/g, '$1 Zentimeter'],
  [/(\d)\s?mm\b/g, '$1 Millimeter'],
  [/(\d)\s?kg\b/g, '$1 Kilogramm'],
  [/(\d)\s?W\b/g, '$1 Watt'],
  [/(\d)\s?%/g, '$1 Prozent']
]

/** Währungszeichen stehen im Deutschen hinten, im Englischen vorn. Beides kommt vor. */
const CURRENCIES: [RegExp, string][] = [
  [/(\d(?:[.,]\d+)?)\s?€/g, '$1 Euro'],
  [/€\s?(\d(?:[.,]\d+)?)/g, '$1 Euro'],
  [/\$\s?(\d(?:[.,]\d+)?)/g, '$1 Dollar'],
  [/(\d(?:[.,]\d+)?)\s?\$/g, '$1 Dollar'],
  [/£\s?(\d(?:[.,]\d+)?)/g, '$1 Pfund'],
  [/(\d(?:[.,]\d+)?)\s?£/g, '$1 Pfund']
]

/**
 * Der Name einer Seite statt ihrer Adresse.
 *
 * "auf Geizhals" ist das, was ein Mensch sagt. Buchstabiert wird eine Adresse
 * nur von einem Automaten — und das ist genau der Eindruck, den die ganze
 * Sammlung hier vermeiden soll.
 */
function siteName(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, '').split('.')
  if (labels.length <= 1) return labels[0] ?? host
  // "co.uk", "com.au", "ac.at" — dort trägt der drittletzte Teil den Namen.
  const secondLevel = new Set(['co', 'com', 'ac', 'org', 'net', 'gov'])
  const last = labels[labels.length - 2]
  const name = secondLevel.has(last) && labels.length >= 3 ? labels[labels.length - 3] : last
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Eine Mailadresse, wie man sie vorliest.
 *
 * Das ist kein Schönheitsdienst, sondern die Rückfrage vor dem Absenden: Bevor
 * eine Mail rausgeht, liest James die Adresse laut vor, und "max punkt
 * mueller at gmail punkt com" ist die einzige Form, in der man einen Tippfehler
 * hört.
 */
function spellEmail(address: string): string {
  return address.replace(/@/g, ' at ').replace(/\./g, ' punkt ')
}

export function toSpeakable(input: string): string {
  if (!input) return ''
  let text = input

  /**
   * Codeblöcke fliegen ganz raus.
   *
   * Vorgelesener Quelltext ist niemandem eine Hilfe — geschweifte Klammern und
   * Semikolons ergeben gesprochen nichts, und die Antwort dauert dreimal so
   * lang. Bleibt danach nichts übrig, war der Block die ganze Antwort; dann
   * werden nur die Zäune entfernt, damit überhaupt etwas gesagt wird.
   */
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ').replace(/```/g, ' ')
  text = withoutCode.trim().length > 0 ? withoutCode : text.replace(/```[a-z]*\n?/gi, ' ')

  // Links: der Text zählt, die Adresse nicht.
  text = text.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')

  // Adressen und Mails, bevor die Satzzeichen drankommen — in beiden stecken
  // Punkte, und ein Punkt in einer Adresse ist kein Satzende.
  text = text.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, (mail) => spellEmail(mail))
  text = text.replace(/\bhttps?:\/\/([^\s/]+)(?:\/\S*)?/gi, (_all, host: string) => siteName(host))
  text = text.replace(/\bwww\.([^\s/]+)(?:\/\S*)?/gi, (_all, host: string) => siteName(host))

  // Auszeichnungen. Der letzte Durchgang unten fängt, was hier hängen bleibt,
  // weil ein Satz mitten aus einem Sternchenpaar herausgeschnitten wurde.
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/\*([^*\n]+)\*/g, '$1')
  text = text.replace(/`([^`\n]+)`/g, '$1')
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')
  text = text.replace(/^\s*[-*•·]\s+/gm, '')
  text = text.replace(/^\s*\d+[.)]\s+/gm, '')
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, '')

  /**
   * Jede Zeile wird ein Satz.
   *
   * Eine Aufzählung ohne diesen Schritt kommt als ein einziger langer Satz
   * heraus, den die Stimme in einem Atemzug herunterleiert. Der Punkt am
   * Zeilenende ist die Atempause, die im Text als Zeilenumbruch stand.
   */
  text = text
    .split(/\n+/)
    // Erst die Reste halber Auszeichnungspaare abschneiden, dann über das
    // Satzzeichen entscheiden: Sonst gilt `Wirklich.**` als Zeile ohne Punkt,
    // bekommt einen angehängt, und übrig bleibt "Wirklich..".
    .map((line) => line.replace(/^[*_`~\s]+/, '').replace(/[*_`~\s]+$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => (/[.!?:;,…]$/.test(line) ? line : `${line}.`))
    .join(' ')

  for (const [pattern, replacement] of ABBREVIATIONS) text = text.replace(pattern, replacement)
  for (const [pattern, replacement] of CURRENCIES) text = text.replace(pattern, replacement)
  for (const [pattern, replacement] of UNITS) text = text.replace(pattern, replacement)

  /**
   * Uhrzeiten. "14:30" liest sich sonst als "vierzehn Doppelpunkt dreißig".
   *
   * Zwei Durchgänge, weil das Wort "Uhr" schon dastehen kann: Wer es mitnimmt,
   * setzt es an die richtige Stelle; wer es übersieht, macht daraus "vierzehn
   * Uhr dreißig Uhr".
   */
  const clock = (h: string, m: string): string => (m === '00' ? `${h} Uhr` : `${h} Uhr ${m}`)
  text = text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\s?Uhr\b/g, (_all, h, m) => clock(h, m))
  text = text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_all, h, m) => clock(h, m))

  /**
   * Der Tausenderpunkt fällt weg.
   *
   * "1.234" ist für eine Stimme nicht von "eins Punkt zweihundertvierunddreißig"
   * zu unterscheiden — das Zeichen ist dasselbe wie das Satzende. Ohne ihn
   * bleibt eine Zahl übrig, und Zahlen kann jede Stimme.
   */
  let previous: string
  do {
    previous = text
    text = text.replace(/(\d)\.(\d{3})\b/g, '$1$2')
  } while (text !== previous)

  text = text.replace(/&/g, ' und ')
  text = text.replace(/(\d)\s?[×x]\s?(\d)/g, '$1 mal $2')

  // Emoji und andere Bildzeichen. Gesprochen sind sie entweder nichts oder
  // eine Beschreibung, und beides will hier niemand.
  text = text.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
    ' '
  )

  // Was von den Auszeichnungen übrig blieb — halbe Paare aus einem Satz, der
  // mitten in der Hervorhebung endete.
  text = text.replace(/[*_`#]+/g, ' ')

  return text.replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim()
}

// ─────────────────────────────────────────────────────────────
// Der Satzpuffer
// ─────────────────────────────────────────────────────────────

/**
 * Kürzel, nach deren Punkt kein Satz endet.
 *
 * Ohne diese Liste zerfällt "z. B. drei Stück" in zwei Sätze, und die Stimme
 * macht mitten in der Redewendung eine Pause. Geprüft wird das Wort vor dem
 * Punkt, kleingeschrieben und ohne den Punkt selbst.
 */
const NO_BREAK_AFTER = new Set([
  'z',
  'b',
  'd',
  'h',
  'u',
  'a',
  'ca',
  'bzw',
  'ggf',
  'evtl',
  'inkl',
  'exkl',
  'usw',
  'etc',
  'nr',
  'mio',
  'mrd',
  'tsd',
  'dr',
  'prof',
  'str',
  'vgl',
  'bspw',
  'ggü',
  'stk'
])

export interface SentenceBuffer {
  /**
   * Ein Bruchstück, so wie es vom Modell kommt. Zurück kommen die Sätze, die
   * damit vollständig geworden sind — schon sprechbar gemacht.
   */
  push(fragment: string): string[]
  /** Der Zug ist zu Ende: was noch liegt, wird gesprochen, ganz gleich wie kurz. */
  flush(): string[]
  /** Dazwischengeredet: was noch liegt, ist überholt. */
  clear(): void
}

/**
 * Ab wann ein Rest auch ohne Satzzeichen hinausgeht.
 *
 * Ein Modell, das eine lange Aufzählung ohne Punkt schreibt, dürfte die Stimme
 * sonst beliebig lange warten lassen. Geschnitten wird dann am letzten Komma
 * oder, wenn es keines gibt, am letzten Leerzeichen — nie mitten im Wort.
 */
const FORCE_AFTER_CHARS = 220

/** Was nach einem Satzzeichen noch zum Satz gehört, ohne ihn offen zu halten. */
const CLOSERS = /["»)*_`\]]/

export function createSentenceBuffer(): SentenceBuffer {
  let pending = ''

  /** Ende des ersten vollständigen Satzes in `pending`, oder -1. */
  const boundary = (text: string): number => {
    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      if (char !== '.' && char !== '!' && char !== '?' && char !== '…') continue

      /**
       * Das nächste Zeichen muss die Pause bestätigen. Solange nichts folgt,
       * ist offen, ob der Punkt einen Satz beendet oder in einer Zahl steht.
       *
       * Auszeichnungen zählen dabei als durchsichtig: Ein Satz, der auf
       * `Wirklich.**` endet, ist trotzdem zu Ende — die Sternchen gehören zur
       * Hervorhebung, nicht zum Text, und fallen unten ohnehin weg.
       */
      const next = text[i + 1]
      if (next === undefined) return -1
      if (!CLOSERS.test(next) && next !== ' ' && next !== '\n') continue

      if (char === '.') {
        // Zahlen: der Punkt in "1.234" und der Punkt nach "3" in "3. Platz".
        if (/\d$/.test(text.slice(0, i))) continue
        const word = /([\wÄÖÜäöüß]+)$/.exec(text.slice(0, i))?.[1] ?? ''
        if (NO_BREAK_AFTER.has(word.toLowerCase())) continue
        // Ein einzelner Buchstabe vor dem Punkt ist eine Initiale, kein Satz.
        if (word.length === 1) continue
      }

      // Anführungszeichen, Klammern und Auszeichnungen gehören noch zum Satz.
      let end = i + 1
      while (end < text.length && CLOSERS.test(text[end])) end++
      return end
    }
    return -1
  }

  const cut = (): string | null => {
    const at = boundary(pending)
    if (at >= 0) {
      const sentence = pending.slice(0, at)
      pending = pending.slice(at)
      return sentence
    }
    if (pending.length < FORCE_AFTER_CHARS) return null

    const window = pending.slice(0, FORCE_AFTER_CHARS)
    const at2 = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '))
    const split = at2 > 40 ? at2 + 1 : window.lastIndexOf(' ')
    if (split <= 0) return null
    const chunk = pending.slice(0, split)
    pending = pending.slice(split)
    return chunk
  }

  return {
    push(fragment) {
      pending += fragment
      const out: string[] = []
      for (;;) {
        const sentence = cut()
        if (sentence === null) break
        const speakable = toSpeakable(sentence)
        if (speakable) out.push(speakable)
      }
      return out
    },

    flush() {
      const rest = toSpeakable(pending)
      pending = ''
      return rest ? [rest] : []
    },

    clear() {
      pending = ''
    }
  }
}
