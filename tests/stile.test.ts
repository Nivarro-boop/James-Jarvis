import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

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
const STYLESHEET = join(WURZEL, 'src', 'renderer', 'styles.css')

/**
 * Jeder Name, der im Stylesheet irgendwo als `.name` vorkommt.
 *
 * Die Kommentare fliegen vorher raus, und das ist nicht Kosmetik: Sie sind in
 * dieser Datei lang und erklären Entscheidungen, und dabei steht eine Klasse
 * auch mal im Fließtext. Dieser Test hat sich beim ersten Anlauf genau daran
 * selbst getäuscht — der Satz „auf der Telefonseite war .ghost von Anfang an
 * definiert" reichte, damit die Regel als vorhanden galt. Ein Wächter, der
 * seinen eigenen Kommentar als Beweis nimmt, ist keiner.
 */
function definierteKlassen(): Set<string> {
  const css = readFileSync(STYLESHEET, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
  const namen = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])
  assert.ok(namen.length > 20, 'das Stylesheet wurde nicht gefunden')
  return new Set(namen)
}

function dateien(ordner: string): string[] {
  const treffer: string[] = []
  for (const eintrag of readdirSync(ordner)) {
    const pfad = join(ordner, eintrag)
    if (statSync(pfad).isDirectory()) treffer.push(...dateien(pfad))
    else if (eintrag.endsWith('.tsx')) treffer.push(pfad)
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
    for (const datei of dateien(join(WURZEL, 'src', 'renderer'))) {
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
