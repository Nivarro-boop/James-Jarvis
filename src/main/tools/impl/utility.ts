import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../registry'
import { fallbackNote, thinkText } from '../../providers/text'
import { getSettings } from '../../store/settings'
import { homeLocation } from '../../location'
import { geocodeOpenMeteo } from '../../maps/geocode'
import type { WeatherCard } from '@shared/types'

/**
 * Kleinkram, der im Sprachbetrieb ständig gebraucht wird.
 *
 * Wetter und Rechnen laufen bewusst ohne Modellaufruf: beides beantwortet
 * eine Websuche zwar auch, aber langsamer, teurer und mit dem Risiko, dass
 * geraten wird. Open-Meteo braucht keinen Schlüssel, der Rechner ist ein
 * Dutzend Zeilen.
 */

// ─────────────────────────────────────────────────────────────
// Wetter
// ─────────────────────────────────────────────────────────────

/** Die Wettercodes von Open-Meteo, auf vorlesbares Deutsch gebracht. */
const WEATHER_CODES: Record<number, string> = {
  0: 'klar',
  1: 'überwiegend klar',
  2: 'teils bewölkt',
  3: 'bedeckt',
  45: 'neblig',
  48: 'Nebel mit Raureif',
  51: 'leichter Nieselregen',
  53: 'Nieselregen',
  55: 'starker Nieselregen',
  56: 'gefrierender Nieselregen',
  57: 'starker gefrierender Nieselregen',
  61: 'leichter Regen',
  63: 'Regen',
  65: 'starker Regen',
  66: 'gefrierender Regen',
  67: 'starker gefrierender Regen',
  71: 'leichter Schneefall',
  73: 'Schneefall',
  75: 'starker Schneefall',
  77: 'Schneegriesel',
  80: 'leichte Schauer',
  81: 'Schauer',
  82: 'kräftige Schauer',
  85: 'leichte Schneeschauer',
  86: 'starke Schneeschauer',
  95: 'Gewitter',
  96: 'Gewitter mit Hagel',
  99: 'schweres Gewitter mit Hagel'
}

/**
 * Der Ort fürs Wetter — über den Geocoder von Open-Meteo, wie seit jeher.
 *
 * Der kennt nur Orte mit Namen, und für das Wetter genügt das: Ob es in der
 * Mariahilfer Straße regnet, entscheidet sich nicht an der Hausnummer.
 */
async function geocode(place: string): Promise<{ name: string; lat: number; lon: number }> {
  const hit = await geocodeOpenMeteo(place)
  if (!hit) throw new Error(`Den Ort "${place}" finde ich nicht.`)
  return { name: hit.label, lat: hit.lat, lon: hit.lon }
}

/** So viele Tage holt das Wetter immer — die Karte zeigt die Woche, auch wenn nur zwei vorgelesen werden. */
const CARD_DAYS = 7

const weather = defineTool({
  name: 'weather',
  group: 'web',
  description:
    'Sagt, wie das Wetter ist oder wird. Braucht keinen Zugang und ist schneller als die Websuche. ' +
    'Für "wie ist das Wetter", "brauch ich eine Jacke", "regnet es morgen".',
  schema: z.object({
    place: z.string().optional().describe('Optionaler Ort. Wenn nicht genannt, den eingestellten Standort verwenden.'),
    days: z.number().optional().describe('Wie viele Tage Vorhersage, Standard zwei, höchstens sieben.')
  }),
  async execute({ place, days }, ctx) {
    const location = place?.trim() || await homeLocation()
    if (!location) throw new Error('Noch kein Standardstandort eingestellt. In den Einstellungen unter Konten & Standort den Ort speichern oder den echten Standort erlauben.')
    const spot = await geocode(location)
    const span = Math.min(CARD_DAYS, Math.max(1, days ?? CARD_DAYS))

    const url =
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${spot.lat}&longitude=${spot.lon}` +
      '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m' +
      '&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      `&timezone=auto&forecast_days=${CARD_DAYS}`

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error('Der Wetterdienst antwortet gerade nicht.')

    const data = (await res.json()) as {
      current: {
        time?: string
        temperature_2m: number
        apparent_temperature: number
        weather_code: number
        wind_speed_10m: number
        relative_humidity_2m: number
      }
      daily: {
        time: string[]
        weather_code: number[]
        temperature_2m_max: number[]
        temperature_2m_min: number[]
        precipitation_probability_max: (number | null)[]
      }
      hourly: {
        time: string[]
        temperature_2m: number[]
        precipitation_probability: (number | null)[]
        wind_speed_10m: number[]
        weather_code?: number[]
      }
    }

    const describe = (code: number): string => WEATHER_CODES[code] ?? 'wechselhaft'
    const hourly = data.hourly ?? { time: [], temperature_2m: [], precipitation_probability: [], wind_speed_10m: [] }

    // Die Karte bekommt alles, was es gibt — sie kostet keine Token. Ans
    // Modell geht unten nur, was es vorlesen soll.
    const card: WeatherCard = {
      kind: 'weather',
      id: `weather:${spot.lat.toFixed(3)},${spot.lon.toFixed(3)}`,
      place: spot.name,
      lat: spot.lat,
      lon: spot.lon,
      temperature: data.current.temperature_2m,
      apparent: data.current.apparent_temperature,
      humidity: data.current.relative_humidity_2m,
      wind: data.current.wind_speed_10m,
      description: describe(data.current.weather_code),
      code: data.current.weather_code,
      hourly: hourly.time
        .map((time, i) => ({
          time,
          temperature: hourly.temperature_2m[i],
          rain: hourly.precipitation_probability[i] ?? 0,
          wind: hourly.wind_speed_10m[i],
          code: hourly.weather_code?.[i] ?? data.current.weather_code
        }))
        .filter((h) => !data.current.time || h.time >= `${data.current.time.slice(0, 13)}:00`)
        .slice(0, 24),
      daily: data.daily.time.map((date, i) => ({
        date,
        description: describe(data.daily.weather_code[i]),
        code: data.daily.weather_code[i],
        max: data.daily.temperature_2m_max[i],
        min: data.daily.temperature_2m_min[i],
        rain: data.daily.precipitation_probability_max[i] ?? 0
      }))
    }
    // Ohne Kontext (in Tests) gibt es keinen Bildschirm, also keine Karte.
    ctx?.show?.(card)

    return {
      ort: spot.name,
      jetzt: {
        temperatur: `${Math.round(data.current.temperature_2m)} Grad`,
        gefühlt: `${Math.round(data.current.apparent_temperature)} Grad`,
        wetter: describe(data.current.weather_code),
        wind: `${Math.round(data.current.wind_speed_10m)} Kilometer pro Stunde`
      },
      vorhersage: data.daily.time.slice(0, span).map((day, i) => ({
        tag: new Date(day).toLocaleDateString('de-DE', { weekday: 'long' }),
        wetter: describe(data.daily.weather_code[i]),
        max: `${Math.round(data.daily.temperature_2m_max[i])} Grad`,
        min: `${Math.round(data.daily.temperature_2m_min[i])} Grad`,
        regenwahrscheinlichkeit: `${data.daily.precipitation_probability_max[i] ?? 0} Prozent`
      })),
      hinweis: 'Antworte in ein bis zwei Sätzen. Nenne nicht jeden Tag einzeln, wenn nicht gefragt.'
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Rechnen
// ─────────────────────────────────────────────────────────────

/**
 * Ein winziger Rechner statt eval.
 *
 * `eval` auf einem Ausdruck, den ein Sprachmodell formuliert hat, wäre eine
 * offene Tür in den Hauptprozess. Deshalb ein eigener Parser mit einem
 * Zeichenvorrat, der nichts anderes zulässt als Rechnen.
 */
function calculate(expression: string): number {
  const cleaned = expression
    .toLowerCase()
    .replace(/,(\d)/g, '.$1')
    .replace(/\bmal\b|×|·/g, '*')
    .replace(/\bgeteilt durch\b|\bdurch\b|÷|:/g, '/')
    .replace(/\bplus\b/g, '+')
    .replace(/\bminus\b/g, '-')
    .replace(/\bhoch\b/g, '^')
    .replace(/\bprozent von\b/g, '% ')
    .replace(/[^0-9+\-*/^().%\s]/g, '')

  let pos = 0
  const peek = (): string => {
    while (cleaned[pos] === ' ') pos++
    return cleaned[pos] ?? ''
  }

  const parseExpression = (): number => {
    let value = parseTerm()
    for (;;) {
      const op = peek()
      if (op !== '+' && op !== '-') return value
      pos++
      const right = parseTerm()
      value = op === '+' ? value + right : value - right
    }
  }

  const parseTerm = (): number => {
    let value = parsePower()
    for (;;) {
      const op = peek()
      if (op !== '*' && op !== '/' && op !== '%') return value
      pos++
      const right = parsePower()
      if (op === '*') value *= right
      else if (op === '/') {
        if (right === 0) throw new Error('Durch null kann ich nicht teilen.')
        value /= right
      } else value = (value / 100) * right
    }
  }

  const parsePower = (): number => {
    const base = parseFactor()
    if (peek() === '^') {
      pos++
      return Math.pow(base, parsePower())
    }
    return base
  }

  const parseFactor = (): number => {
    const ch = peek()
    if (ch === '-') {
      pos++
      return -parseFactor()
    }
    if (ch === '+') {
      pos++
      return parseFactor()
    }
    if (ch === '(') {
      pos++
      const value = parseExpression()
      if (peek() === ')') pos++
      return value
    }
    const start = pos
    while (/[0-9.]/.test(cleaned[pos] ?? '')) pos++
    if (pos === start) throw new Error('Das kann ich nicht ausrechnen.')
    return parseFloat(cleaned.slice(start, pos))
  }

  const result = parseExpression()
  if (!Number.isFinite(result)) throw new Error('Das ergibt keine sinnvolle Zahl.')
  return result
}

const calculateTool = defineTool({
  name: 'calculate',
  group: 'web',
  description:
    'Rechnet einen Ausdruck aus. Nutze das statt selbst zu rechnen — bei Preisen, Prozenten ' +
    'und Zeitspannen verrechnet man sich sonst.',
  schema: z.object({
    expression: z
      .string()
      .describe('Der Ausdruck, etwa "49,90 mal 3" oder "1200 / 7" oder "19 prozent von 250".')
  }),
  async execute({ expression }) {
    const value = calculate(expression)
    // Auf zwei Stellen runden, aber ganze Zahlen ganz lassen: "drei Komma
    // null null Euro" klingt vorgelesen falsch.
    const rounded = Math.round(value * 100) / 100
    return {
      ergebnis: Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace('.', ','),
      ausdruck: expression
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Übersetzen
// ─────────────────────────────────────────────────────────────

const TRANSLATE_INSTRUCTION =
  'Gib ausschließlich die Übersetzung zurück, ohne Anführungszeichen, ohne Erklärung ' +
  'und ohne die Ausgangssprache zu wiederholen.'

/**
 * Übersetzen — eine reine Textaufgabe, und damit eine der wenigen, die den
 * Anbieter überhaupt wechseln können.
 *
 * Alle anderen hängen an Gemini-Eigenheiten: Websuche und Preisvergleich am
 * googleSearch-Grounding, der Seitenabruf am urlContext, die Bildschirmarbeit
 * am Bildeingang. Hier geht Text rein und Text raus, mehr braucht es nicht.
 *
 * Wer antwortet, entscheidet `providers/text.ts` anhand von `brainProvider`.
 * Die Anbieterwahl stand einmal hier im Werkzeug, als Kette aus drei
 * geschachtelten Versuchen — an einer Stelle geht das, bei der zweiten
 * Textaufgabe zerfiele die Einstellung in zwei Fassungen davon.
 */
const translate = defineTool({
  name: 'translate',
  group: 'web',
  description:
    'Übersetzt Text in eine andere Sprache. Für "wie sagt man das auf Englisch" oder wenn ' +
    'auf dem Bildschirm etwas in einer fremden Sprache steht.',
  schema: z.object({
    text: z.string().describe('Was übersetzt werden soll.'),
    to: z.string().describe('Zielsprache, zum Beispiel Englisch oder Japanisch.')
  }),
  async execute({ text, to }) {
    const answer = await thinkText({
      system: TRANSLATE_INSTRUCTION,
      user: `Übersetze nach ${to}:\n\n${text}`
    })

    return {
      übersetzung: answer.text,
      sprache: to,
      // Nur wenn nicht der eingestellte Anbieter geantwortet hat. Sonst wäre
      // es bei jeder Übersetzung eine Zeile, die niemand hören will.
      hinweis: fallbackNote(answer)
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Einheiten umrechnen
// ─────────────────────────────────────────────────────────────

/**
 * Wovon eine Einheit eine Einheit ist.
 *
 * Das Feld trägt die Umrechnung nicht — dafür reicht der Faktor —, sondern
 * verhindert die Umrechnung, die es nicht gibt. Ohne es rechnete `convertUnit`
 * jede Einheit in jede um, und weil Kilogramm, Meter, Liter, Quadratmeter und
 * km/h alle den Faktor 1 auf ihre eigene Basis haben, kam bei „5 Kilo in Meter"
 * die Zahl 5 heraus: keine Fehlermeldung, keine Auffälligkeit, eine glatte
 * falsche Auskunft. Gesprochen ist das die schlimmste Sorte Fehler — es steht
 * kein Ergebnis auf dem Schirm, an dem der Unsinn auffiele.
 */
type Dimension = 'masse' | 'länge' | 'fläche' | 'volumen' | 'geschwindigkeit' | 'temperatur'

type UnitDef = { dim: Dimension; factor: number; offset?: number; label: string }

/** Alle Einheiten, die James kennt. Konvertierung immer über SI-Basiseinheit. */
const UNITS: Record<string, UnitDef> = {
  // Masse (Basiseinheit: kg)
  kg: { dim: 'masse', factor: 1, label: 'Kilogramm' },
  kilogramm: { dim: 'masse', factor: 1, label: 'Kilogramm' },
  g: { dim: 'masse', factor: 0.001, label: 'Gramm' },
  gramm: { dim: 'masse', factor: 0.001, label: 'Gramm' },
  t: { dim: 'masse', factor: 1000, label: 'Tonne' },
  tonne: { dim: 'masse', factor: 1000, label: 'Tonne' },
  lbs: { dim: 'masse', factor: 0.453592, label: 'Pfund' },
  pfund: { dim: 'masse', factor: 0.453592, label: 'Pfund' },
  lb: { dim: 'masse', factor: 0.453592, label: 'Pfund' },
  oz: { dim: 'masse', factor: 0.0283495, label: 'Unze' },
  unze: { dim: 'masse', factor: 0.0283495, label: 'Unze' },
  // Länge (Basiseinheit: m)
  m: { dim: 'länge', factor: 1, label: 'Meter' },
  meter: { dim: 'länge', factor: 1, label: 'Meter' },
  km: { dim: 'länge', factor: 1000, label: 'Kilometer' },
  kilometer: { dim: 'länge', factor: 1000, label: 'Kilometer' },
  cm: { dim: 'länge', factor: 0.01, label: 'Zentimeter' },
  zentimeter: { dim: 'länge', factor: 0.01, label: 'Zentimeter' },
  mm: { dim: 'länge', factor: 0.001, label: 'Millimeter' },
  millimeter: { dim: 'länge', factor: 0.001, label: 'Millimeter' },
  mi: { dim: 'länge', factor: 1609.34, label: 'Meile' },
  meile: { dim: 'länge', factor: 1609.34, label: 'Meile' },
  meilen: { dim: 'länge', factor: 1609.34, label: 'Meile' },
  miles: { dim: 'länge', factor: 1609.34, label: 'Meile' },
  ft: { dim: 'länge', factor: 0.3048, label: 'Fuß' },
  fuß: { dim: 'länge', factor: 0.3048, label: 'Fuß' },
  fuss: { dim: 'länge', factor: 0.3048, label: 'Fuß' },
  feet: { dim: 'länge', factor: 0.3048, label: 'Fuß' },
  inch: { dim: 'länge', factor: 0.0254, label: 'Zoll' },
  zoll: { dim: 'länge', factor: 0.0254, label: 'Zoll' },
  yd: { dim: 'länge', factor: 0.9144, label: 'Yard' },
  yard: { dim: 'länge', factor: 0.9144, label: 'Yard' },
  // Fläche (Basiseinheit: m²)
  'm2': { dim: 'fläche', factor: 1, label: 'Quadratmeter' },
  'm²': { dim: 'fläche', factor: 1, label: 'Quadratmeter' },
  quadratmeter: { dim: 'fläche', factor: 1, label: 'Quadratmeter' },
  ha: { dim: 'fläche', factor: 10000, label: 'Hektar' },
  hektar: { dim: 'fläche', factor: 10000, label: 'Hektar' },
  'km2': { dim: 'fläche', factor: 1e6, label: 'Quadratkilometer' },
  'km²': { dim: 'fläche', factor: 1e6, label: 'Quadratkilometer' },
  // Volumen (Basiseinheit: l)
  l: { dim: 'volumen', factor: 1, label: 'Liter' },
  liter: { dim: 'volumen', factor: 1, label: 'Liter' },
  ml: { dim: 'volumen', factor: 0.001, label: 'Milliliter' },
  milliliter: { dim: 'volumen', factor: 0.001, label: 'Milliliter' },
  cl: { dim: 'volumen', factor: 0.01, label: 'Zentiliter' },
  gal: { dim: 'volumen', factor: 3.78541, label: 'Gallone' },
  gallone: { dim: 'volumen', factor: 3.78541, label: 'Gallone' },
  gallon: { dim: 'volumen', factor: 3.78541, label: 'Gallone' },
  // Geschwindigkeit (Basiseinheit: km/h)
  'km/h': { dim: 'geschwindigkeit', factor: 1, label: 'km/h' },
  kmh: { dim: 'geschwindigkeit', factor: 1, label: 'km/h' },
  'm/s': { dim: 'geschwindigkeit', factor: 3.6, label: 'm/s' },
  ms: { dim: 'geschwindigkeit', factor: 3.6, label: 'm/s' },
  mph: { dim: 'geschwindigkeit', factor: 1.60934, label: 'mph' },
  knot: { dim: 'geschwindigkeit', factor: 1.852, label: 'Knoten' },
  knoten: { dim: 'geschwindigkeit', factor: 1.852, label: 'Knoten' },
  kn: { dim: 'geschwindigkeit', factor: 1.852, label: 'Knoten' },
  // Temperatur — Sonderfall mit Offset
  celsius: { dim: 'temperatur', factor: 1, offset: 0, label: '°C' },
  '°c': { dim: 'temperatur', factor: 1, offset: 0, label: '°C' },
  c: { dim: 'temperatur', factor: 1, offset: 0, label: '°C' },
  fahrenheit: { dim: 'temperatur', factor: 5 / 9, offset: -32, label: '°F' },
  '°f': { dim: 'temperatur', factor: 5 / 9, offset: -32, label: '°F' },
  f: { dim: 'temperatur', factor: 5 / 9, offset: -32, label: '°F' },
  kelvin: { dim: 'temperatur', factor: 1, offset: -273.15, label: 'K' },
  k: { dim: 'temperatur', factor: 1, offset: -273.15, label: 'K' }
}

function convertUnit(value: number, from: string, to: string): number {
  const fromKey = from.toLowerCase().replace(/\s+/g, '')
  const toKey = to.toLowerCase().replace(/\s+/g, '')
  const fromDef = UNITS[fromKey]
  const toDef = UNITS[toKey]
  if (!fromDef || !toDef) {
    throw new Error(`Ich kenne die Einheit "${!fromDef ? from : to}" nicht.`)
  }

  // Lieber keine Antwort als eine falsche: Gewicht wird nicht zu Länge, und
  // Fläche nicht zu Volumen. Der Fehlertext ist an das Modell gerichtet und
  // sagt ihm, was es stattdessen tun soll — sonst liest es bloß „Fehler" vor.
  if (fromDef.dim !== toDef.dim) {
    throw new Error(
      `${fromDef.label} misst ${fromDef.dim}, ${toDef.label} misst ${toDef.dim} — ` +
        'das eine lässt sich nicht ins andere umrechnen. Sag dem Nutzer das in einem Satz ' +
        'und frag nach, was er gemeint hat.'
    )
  }

  if (fromDef.dim === 'temperatur') {
    // Schritt 1: alles nach Celsius
    const inCelsius = (value + (fromDef.offset ?? 0)) * fromDef.factor
    // Schritt 2: von Celsius in Ziel
    return inCelsius / toDef.factor - (toDef.offset ?? 0)
  }

  // Alle anderen: über Basiseinheit
  const inBase = value * fromDef.factor
  return inBase / toDef.factor
}

const unitConvert = defineTool({
  name: 'unit_convert',
  group: 'web',
  description:
    'Rechnet Einheiten um, ohne Websuche. ' +
    'Masse: kg, g, Pfund (lbs), Unze (oz), Tonne. ' +
    'Länge: m, km, cm, mm, Meile, Fuß (ft), Zoll (inch), Yard. ' +
    'Temperatur: Celsius, Fahrenheit, Kelvin. ' +
    'Geschwindigkeit: km/h, m/s, mph, Knoten. ' +
    'Volumen: Liter, ml, Gallone. ' +
    'Fläche: m², ha, km². ' +
    'Für "wie viel sind 5 Meilen in Kilometer", "100 Fahrenheit in Celsius".',
  schema: z.object({
    wert: z.number().describe('Der Zahlenwert der Eingabe.'),
    von: z.string().describe('Ausgangseinheit, z.B. Meilen, Fahrenheit, lbs.'),
    nach: z.string().describe('Zieleinheit, z.B. Kilometer, Celsius, kg.')
  }),
  async execute({ wert, von, nach }) {
    const result = convertUnit(wert, von, nach)
    const fromKey = von.toLowerCase().replace(/\s+/g, '')
    const toKey = nach.toLowerCase().replace(/\s+/g, '')
    const fromLabel = UNITS[fromKey]?.label ?? von
    const toLabel = UNITS[toKey]?.label ?? nach

    const decimals = Number.isInteger(result) ? 0 : result < 1 ? 4 : 2
    const formatted = result.toLocaleString('de-AT', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    })

    return {
      eingabe: `${wert} ${fromLabel}`,
      ergebnis: `${formatted} ${toLabel}`,
      hinweis: 'Nenne das Ergebnis in einem kurzen Satz.'
    }
  }
}) as ToolDefinition

// ─────────────────────────────────────────────────────────────
// Zeitzonen
// ─────────────────────────────────────────────────────────────

/** Häufig genannte Städte und Länder auf IANA-Zeitzonen abbilden. */
const TIMEZONE_ALIASES: Record<string, string> = {
  wien: 'Europe/Vienna',
  österreich: 'Europe/Vienna',
  austria: 'Europe/Vienna',
  berlin: 'Europe/Berlin',
  münchen: 'Europe/Berlin',
  munich: 'Europe/Berlin',
  deutschland: 'Europe/Berlin',
  germany: 'Europe/Berlin',
  london: 'Europe/London',
  england: 'Europe/London',
  uk: 'Europe/London',
  paris: 'Europe/Paris',
  frankreich: 'Europe/Paris',
  france: 'Europe/Paris',
  zürich: 'Europe/Zurich',
  zurich: 'Europe/Zurich',
  schweiz: 'Europe/Zurich',
  switzerland: 'Europe/Zurich',
  rom: 'Europe/Rome',
  rome: 'Europe/Rome',
  italien: 'Europe/Rome',
  italy: 'Europe/Rome',
  madrid: 'Europe/Madrid',
  spanien: 'Europe/Madrid',
  spain: 'Europe/Madrid',
  amsterdam: 'Europe/Amsterdam',
  niederlande: 'Europe/Amsterdam',
  netherlands: 'Europe/Amsterdam',
  stockholm: 'Europe/Stockholm',
  schweden: 'Europe/Stockholm',
  sweden: 'Europe/Stockholm',
  oslo: 'Europe/Oslo',
  norwegen: 'Europe/Oslo',
  norway: 'Europe/Oslo',
  kopenhagen: 'Europe/Copenhagen',
  dänemark: 'Europe/Copenhagen',
  denmark: 'Europe/Copenhagen',
  tokio: 'Asia/Tokyo',
  tokyo: 'Asia/Tokyo',
  japan: 'Asia/Tokyo',
  peking: 'Asia/Shanghai',
  beijing: 'Asia/Shanghai',
  shanghai: 'Asia/Shanghai',
  china: 'Asia/Shanghai',
  seoul: 'Asia/Seoul',
  südkorea: 'Asia/Seoul',
  korea: 'Asia/Seoul',
  singapur: 'Asia/Singapore',
  singapore: 'Asia/Singapore',
  dubai: 'Asia/Dubai',
  vae: 'Asia/Dubai',
  uae: 'Asia/Dubai',
  mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  indien: 'Asia/Kolkata',
  india: 'Asia/Kolkata',
  bangkok: 'Asia/Bangkok',
  thailand: 'Asia/Bangkok',
  sydney: 'Australia/Sydney',
  australien: 'Australia/Sydney',
  australia: 'Australia/Sydney',
  auckland: 'Pacific/Auckland',
  neuseeland: 'Pacific/Auckland',
  'new zealand': 'Pacific/Auckland',
  'new york': 'America/New_York',
  newyork: 'America/New_York',
  usa: 'America/New_York',
  'new york city': 'America/New_York',
  nyc: 'America/New_York',
  miami: 'America/New_York',
  boston: 'America/New_York',
  chicago: 'America/Chicago',
  dallas: 'America/Chicago',
  houston: 'America/Chicago',
  denver: 'America/Denver',
  'los angeles': 'America/Los_Angeles',
  losangeles: 'America/Los_Angeles',
  la: 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  sanfrancisco: 'America/Los_Angeles',
  seattle: 'America/Los_Angeles',
  toronto: 'America/Toronto',
  kanada: 'America/Toronto',
  canada: 'America/Toronto',
  mexico: 'America/Mexico_City',
  mexiko: 'America/Mexico_City',
  brasilien: 'America/Sao_Paulo',
  brazil: 'America/Sao_Paulo',
  'são paulo': 'America/Sao_Paulo',
  'sao paulo': 'America/Sao_Paulo',
  buenos: 'America/Argentina/Buenos_Aires',
  argentinien: 'America/Argentina/Buenos_Aires',
  moscow: 'Europe/Moscow',
  moskau: 'Europe/Moscow',
  russland: 'Europe/Moscow',
  russia: 'Europe/Moscow',
  kairo: 'Africa/Cairo',
  cairo: 'Africa/Cairo',
  ägypten: 'Africa/Cairo',
  'south africa': 'Africa/Johannesburg',
  südafrika: 'Africa/Johannesburg',
  johannesburg: 'Africa/Johannesburg',
  kapstadt: 'Africa/Johannesburg',
  utc: 'UTC',
  gmt: 'UTC'
}

const timezoneNow = defineTool({
  name: 'timezone_now',
  group: 'web',
  description:
    'Gibt die aktuelle Uhrzeit in einer anderen Stadt oder Zeitzone aus. ' +
    'Für "wie spät ist es in New York", "welche Zeit ist es in Tokio", "was ist UTC". ' +
    'Kennt alle großen Städte und IANA-Zeitzonen (z.B. America/New_York).',
  schema: z.object({
    ort: z.string().describe('Stadt, Land oder IANA-Zeitzone, z.B. "New York", "Japan", "UTC".')
  }),
  async execute({ ort }) {
    const key = ort.toLowerCase().replace(/[\s-]+/g, ' ').trim()
    const tzName = TIMEZONE_ALIASES[key] ?? TIMEZONE_ALIASES[key.replace(/\s/g, '')] ?? ort

    let formatted: string
    let offsetStr: string
    try {
      const now = new Date()
      formatted = now.toLocaleString('de-DE', {
        timeZone: tzName,
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
      })
      // Offset in Stunden
      const offsetMin =
        (new Date(now.toLocaleString('en-US', { timeZone: tzName })).getTime() -
          new Date(now.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()) /
        60000
      const sign = offsetMin >= 0 ? '+' : '-'
      const h = Math.floor(Math.abs(offsetMin) / 60)
      const m = Math.abs(offsetMin) % 60
      offsetStr = `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`
    } catch {
      throw new Error(
        `Ich kenne die Zeitzone "${ort}" nicht. Versuche eine IANA-Zeitzone wie "Europe/Vienna".`
      )
    }

    return {
      ort,
      zeitzone: tzName,
      uhrzeit: formatted,
      offset: offsetStr,
      hinweis: 'Nenne Ort und Uhrzeit in einem Satz.'
    }
  }
}) as ToolDefinition

export const utilityTools: ToolDefinition[] = [weather, calculateTool, translate, unitConvert, timezoneNow]

/** Nur für Tests des Rechners und der Einheiten. */
export const __internals = { calculate, convertUnit }
