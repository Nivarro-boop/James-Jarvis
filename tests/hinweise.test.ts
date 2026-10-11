import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Der Wächter über die Verweise ins Einstellungsfenster.
 *
 * James sagt an vielen Stellen, wo etwas einzustellen ist: „Hol es in den
 * Einstellungen unter Ohren", „trag den Schlüssel in den Einstellungen unter
 * Zugänge ein". Das ist die einzige Wegbeschreibung, die er gibt — es gibt
 * keine Suche im Einstellungsfenster und keine Verweise, die man anklicken
 * könnte.
 *
 * Genau diese Sätze halten aber nicht von selbst mit der Navigationsleiste
 * Schritt. Vier Meldungen schickten zuletzt „unter Mund", eine „unter Kopf" —
 * beide Abschnitte gab es nicht, weder vorher noch nachher. Wer dem folgt,
 * sucht in einer Liste von achtzehn Namen nach einem, der nicht dabei ist, und
 * kommt zu dem Schluss, dass die App kaputt ist. Auffallen kann das niemandem
 * beim Übersetzen: Es ist eine Zeichenkette, und Zeichenketten stimmen immer.
 *
 * Der Test liest die Abschnittsnamen dort, wo sie wirklich stehen — in der
 * Navigationsleiste des Einstellungsfensters. Wird ein Abschnitt umbenannt,
 * fällt hier auf, welche Sätze noch auf den alten Namen zeigen.
 *
 * Geprüft wird bewusst nur die Hausform „Einstellungen unter X". Der Pfeil —
 * „Einstellungen → Allgemein → Info" — steht in dieser App auch für fremde
 * Geräte: Die Anleitung zum Zertifikat auf dem iPhone führt durch die
 * Einstellungen von iOS, und die haben mit dieser Navigationsleiste nichts zu
 * tun. Ebenso ausgenommen ist alles, wo ein fremder Name davorsteht, also
 * „Tailscale-Einstellungen unter DNS" und „Windows-Einstellungen unter
 * Datenschutz".
 */

const WURZEL = process.cwd()

/**
 * Die Abschnittsnamen aus der Navigationsleiste.
 *
 * Gelesen statt importiert, aus demselben Grund wie bei den Shader-Vorlagen:
 * Ein Import liefe über das Kürzel für den Renderer, und das kennt die
 * tsconfig des Hauptprozesses nicht — der Test liefe, die Typprüfung nicht.
 */
function abschnitte(): Set<string> {
  const quelle = readFileSync(join(WURZEL, 'src', 'renderer', 'settings.tsx'), 'utf8')
  const block = quelle.slice(quelle.indexOf('const SECTIONS = ['))
  const liste = block.slice(0, block.indexOf('] as const'))
  const namen = [...liste.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
  assert.ok(namen.length > 5, 'die Abschnittsliste wurde nicht gefunden')
  return new Set(namen)
}

/** Alle Dateien, in denen solche Sätze vorkommen können. */
function quellen(): string[] {
  const treffer: string[] = []
  const passt = (name: string): boolean =>
    ['.ts', '.tsx', '.js', '.py'].some((ende) => name.endsWith(ende))

  const gehe = (ordner: string): void => {
    for (const eintrag of readdirSync(ordner)) {
      const pfad = join(ordner, eintrag)
      if (statSync(pfad).isDirectory()) gehe(pfad)
      else if (passt(eintrag)) treffer.push(pfad)
    }
  }

  gehe(join(WURZEL, 'src'))
  gehe(join(WURZEL, 'resources'))
  return treffer
}

/**
 * Zeilen zusammenfassen, die in Wirklichkeit ein Satz sind.
 *
 * Lange Meldungen stehen als aneinandergehängte Zeichenketten da, und die
 * Naht liegt oft genau zwischen „Einstellungen unter" und dem Namen des
 * Abschnitts. Zeilenweise gelesen fände der Test die Hälfte davon nicht.
 * Zusammengefasst wird deshalb bis zum Ende der Anhängerei; die Zeilennummer
 * bleibt die der ersten Zeile, denn dort schlägt man nach.
 */
function saetze(text: string): Array<{ nr: number; text: string }> {
  const zeilen = text.split('\n')
  const heraus: Array<{ nr: number; text: string }> = []

  for (let i = 0; i < zeilen.length; i++) {
    let satz = zeilen[i]
    const start = i
    while (/\+\s*$/.test(zeilen[i]) && i + 1 < zeilen.length) {
      i++
      satz += ' ' + zeilen[i].trim()
    }
    // Die Naht selbst verschwindet: aus "unter ' + 'Ohren" wird "unter Ohren".
    heraus.push({ nr: start + 1, text: satz.replace(/['"`]\s*\+\s*['"`]/g, '') })
  }
  return heraus
}

describe('Verweise ins Einstellungsfenster', () => {
  it('nennen nur Abschnitte, die es wirklich gibt', () => {
    const bekannt = abschnitte()
    // Ein fremder Name davor („Tailscale-Einstellungen") schließt den Treffer
    // aus: Gemeint sind dann die Einstellungen eines anderen Programms.
    const muster =
      /(^|[^A-Za-zÄÖÜäöüß-])Einstellungen +unter +([A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]*(?: [A-ZÄÖÜ][a-zäöüß]+)?)/g

    const falsch: string[] = []
    for (const datei of quellen()) {
      for (const { nr, text } of saetze(readFileSync(datei, 'utf8'))) {
        for (const m of text.matchAll(muster)) {
          const genannt = m[2]
          // Zwei Wörter zuerst („Smart Home"), sonst das erste allein: Hinter
          // dem Abschnittsnamen geht der Satz ja weiter, und „unter Musik Der"
          // wäre sonst ein Fehlschlag.
          if (bekannt.has(genannt) || bekannt.has(genannt.split(' ')[0])) continue
          falsch.push(`${datei.slice(WURZEL.length + 1)}:${nr} — „unter ${genannt}"`)
        }
      }
    }

    assert.deepEqual(
      falsch,
      [],
      'zeigt auf einen Abschnitt, den die Navigationsleiste nicht hat — ' +
        `bekannt sind: ${[...bekannt].join(', ')}`
    )
  })
})
