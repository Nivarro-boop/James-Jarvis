import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { transformSync } from 'esbuild'

/**
 * Der Wächter über die Klassennamen.
 *
 * Ein Tippfehler in `className` ist der leiseste Fehler, den diese Oberfläche
 * kennt: Der Übersetzer sieht eine Zeichenkette und ist zufrieden, React setzt
 * sie brav ins Attribut, und im Fenster steht ein Knopf, der eben aussieht wie
 * jeder andere. Niemand bemerkt es, weil nichts fehlt — es ist nur nichts
 * dazugekommen.
 *
 * Gefunden wurde damit `ghost`: vier Knöpfe im Einstellungsfenster trugen die
 * Klasse, das Stylesheet kannte sie nicht. Auf der Telefonseite war sie
 * definiert, und von dort war sie herübergewandert.
 *
 * Geprüft werden nur Klassen, die wörtlich im Quelltext stehen. Alles, was
 * zusammengesetzt wird, ist hier nicht zu prüfen — und genau deshalb wird es in
 * dieser Oberfläche auch kaum gemacht.
 */

const WURZEL = process.cwd()
const RENDERER = join(WURZEL, 'src', 'renderer')

/**
 * Jeder Name, der in einem tatsächlich importierten Stylesheet als `.name`
 * vorkommt. Komponenten dürfen eigene CSS-Dateien mitbringen; auch deren
 * lokale @imports gehören dazu. Unimportierte Dateien gelten nicht als Beleg.
 *
 * Die Kommentare fliegen vorher raus, und das ist nicht Kosmetik: Sie sind in
 * dieser Datei lang und erklären Entscheidungen, und dabei steht eine Klasse
 * auch mal im Fließtext. Dieser Test hat sich beim ersten Anlauf genau daran
 * selbst getäuscht — der Satz „auf der Telefonseite war .ghost von Anfang an
 * definiert" reichte, damit die Regel als vorhanden galt. Ein Wächter, der
 * seinen eigenen Kommentar als Beweis nimmt, ist keiner.
 */
function definierteKlassen(): Set<string> {
  const stylesheets = new Set<string>()
  const cssImport = /@import\s+(?:url\(\s*(?:["']([^"']+)["']|([^\s)]+))\s*\)|["']([^"']+)["'])[^;]*;/g
  const ohneKommentare = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const sammeln = (importiert: string, von: string): void => {
    // Externe URLs liefern keine lokalen Klassen; relative und Renderer-Alias-
    // Importe werden mit demselben Ausgangsordner wie im Build aufgelöst.
    if (/^(?:https?:|data:|\/\/)/.test(importiert)) return
    const pfad = importiert.startsWith('@renderer/')
      ? resolve(RENDERER, importiert.slice('@renderer/'.length))
      : /^[.\/]/.test(importiert)
        ? resolve(dirname(von), importiert)
        // Paket-Import wie `mapbox-gl/dist/mapbox-gl.css`: aus node_modules.
        : resolve(WURZEL, 'node_modules', importiert)
    assert.ok(existsSync(pfad), `Importiertes Stylesheet fehlt: ${pfad}`)
    if (stylesheets.has(pfad)) return
    stylesheets.add(pfad)
    for (const treffer of ohneKommentare(readFileSync(pfad, 'utf8')).matchAll(cssImport)) sammeln(treffer[1] ?? treffer[2] ?? treffer[3], pfad)
  }

  for (const datei of dateien(RENDERER, ['.ts', '.tsx'])) {
    // Der Build-Parser entfernt Kommentare/Typimporte und normalisiert auch
    // mehrzeilige Imports, bevor die lokalen CSS-Abhängigkeiten gesucht werden.
    const quelle = transformSync(readFileSync(datei, 'utf8'), { loader: datei.endsWith('.tsx') ? 'tsx' : 'ts', format: 'esm' }).code
    for (const treffer of quelle.matchAll(/^import\s+(?:[^"'\n]+\s+from\s*)?["']([^"']+\.css)["'];/gm)) sammeln(treffer[1], datei)
  }

  const css = [...stylesheets].map(pfad => ohneKommentare(readFileSync(pfad, 'utf8'))).join('\n')
  const namen = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])
  assert.ok(namen.length > 20, 'die importierten Stylesheets wurden nicht gefunden')
  return new Set(namen)
}

function dateien(ordner: string, endungen = ['.tsx']): string[] {
  const treffer: string[] = []
  for (const eintrag of readdirSync(ordner)) {
    const pfad = join(ordner, eintrag)
    if (statSync(pfad).isDirectory()) treffer.push(...dateien(pfad, endungen))
    else if (endungen.some(endung => eintrag.endsWith(endung))) treffer.push(pfad)
  }
  return treffer
}

describe('Klassennamen der Oberfläche', () => {
  it('stehen alle auch im Stylesheet', () => {
    const bekannt = definierteKlassen()
    // Nur die drei wörtlichen Schreibweisen: "…", {'…'} und {`…`} ohne
    // Einsetzung. Ein Wert mit ${…} darin wird übersprungen.
    const muster = /className=(?:"([^"]+)"|\{`([^`{}]+)`\}|\{'([^']+)'\})/g

    const fehlend: string[] = []
    for (const datei of dateien(RENDERER)) {
      const text = readFileSync(datei, 'utf8')
      const zeilen = text.split('\n')
      for (const treffer of text.matchAll(muster)) {
        const wert = treffer[1] ?? treffer[2] ?? treffer[3] ?? ''
        const nr = text.slice(0, treffer.index ?? 0).split('\n').length
        for (const name of wert.split(/\s+/).filter(Boolean)) {
          if (bekannt.has(name)) continue
          fehlend.push(
            `${datei.slice(WURZEL.length + 1)}:${nr} — „${name}" (${zeilen[nr - 1]?.trim().slice(0, 60)})`
          )
        }
      }
    }

    assert.deepEqual(fehlend, [], 'Klasse im Quelltext, aber keine Regel im Stylesheet')
  })
})
