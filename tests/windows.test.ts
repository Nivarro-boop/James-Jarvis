import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { arrangementRect, pickDisplay, type DisplayTarget } from '@main/automation/desktop'

/**
 * Fenster auf den richtigen Bildschirm.
 *
 * Geprüft wird der Teil, der sich lautlos vertun kann: aus einem gesprochenen
 * „auf den rechten" den tatsächlichen Monitor zu machen und daraus ein
 * Rechteck. Beides ist reine Rechnerei ohne Electron — der Rest, also das
 * Verschieben selbst, hängt an user32 und wird von Hand geprüft.
 *
 * Der Anlass für die Tests steht in `arrangeWindow`: Vorher lief das Anordnen
 * über `SPI_GETWORKAREA`, und das liefert immer den Hauptbildschirm. Auf zwei
 * Monitoren landete „leg das nach rechts" deshalb auf der rechten Hälfte des
 * linken Schirms — ein Fehler, der aussieht wie ein Missverständnis und keiner
 * war.
 */

function display(
  id: number,
  x: number,
  opts: { primary?: boolean; width?: number; taskbar?: number } = {}
): DisplayTarget {
  const width = opts.width ?? 1920
  const taskbar = opts.taskbar ?? 48
  return {
    id,
    label: opts.primary ? 'Hauptbildschirm' : `Bildschirm ${id}`,
    bounds: { x, y: 0, width, height: 1080 },
    workArea: { x, y: 0, width, height: 1080 - taskbar },
    scaleFactor: 1,
    primary: opts.primary ?? false
  }
}

// Der Regelfall auf diesem Rechner: zwei gleich große Schirme nebeneinander,
// der linke ist der Hauptbildschirm.
const LINKS = display(1, 0, { primary: true })
const RECHTS = display(2, 1920)
const ZWEI = [LINKS, RECHTS]

describe('pickDisplay', () => {
  it('nimmt bei einem einzigen Bildschirm immer diesen', () => {
    // „Leg das nach rechts" bei einem Monitor heißt die rechte Hälfte, nicht
    // „geht nicht". Welche Hälfte, entscheidet danach `how`.
    for (const wort of ['rechts', 'links', 'haupt', 'zwei']) {
      assert.equal(pickDisplay([LINKS], wort), LINKS)
    }
  })

  it('ordnet links und rechts nach der tatsächlichen Lage, nicht nach der Reihenfolge', () => {
    assert.equal(pickDisplay(ZWEI, 'links'), LINKS)
    assert.equal(pickDisplay(ZWEI, 'rechts'), RECHTS)

    // Dieselben Schirme, andersherum aufgezählt. Windows zählt nicht
    // zwangsläufig von links nach rechts auf — verließe sich die Wahl auf den
    // Index, wäre sie hier vertauscht.
    const umgekehrt = [RECHTS, LINKS]
    assert.equal(pickDisplay(umgekehrt, 'links'), LINKS)
    assert.equal(pickDisplay(umgekehrt, 'rechts'), RECHTS)
  })

  it('findet den rechten auch, wenn er der Hauptbildschirm ist', () => {
    const linksNebenan = display(1, -1920)
    const hauptRechts = display(2, 0, { primary: true })
    const beide = [linksNebenan, hauptRechts]

    assert.equal(pickDisplay(beide, 'rechts'), hauptRechts)
    assert.equal(pickDisplay(beide, 'links'), linksNebenan)
    assert.equal(pickDisplay(beide, 'haupt'), hauptRechts)
  })

  it('versteht die Beugungen, in denen man es wirklich sagt', () => {
    for (const wort of ['rechts', 'rechte', 'rechten', 'auf den rechten bildschirm', 'RECHTS']) {
      assert.equal(pickDisplay(ZWEI, wort), RECHTS, wort)
    }
    for (const wort of ['links', 'linke', 'linken', 'auf den linken schirm']) {
      assert.equal(pickDisplay(ZWEI, wort), LINKS, wort)
    }
  })

  it('nimmt auch die Nummer, als Ziffer und als Wort', () => {
    assert.equal(pickDisplay(ZWEI, 'bildschirm 2'), RECHTS)
    assert.equal(pickDisplay(ZWEI, 'zweiter monitor'), RECHTS)
    assert.equal(pickDisplay(ZWEI, 'auf den ersten'), LINKS)
  })

  it('nimmt den mittleren nur, wenn es überhaupt drei gibt', () => {
    const drei = [LINKS, display(2, 1920), display(3, 3840)]
    assert.equal(pickDisplay(drei, 'mitte'), drei[1])
    // Bei zweien gibt es keine Mitte. Irgendeinen zu nehmen wäre geraten.
    assert.equal(pickDisplay(ZWEI, 'mitte'), null)
  })

  it('gibt nichts zurück, wenn gar kein Bildschirm genannt wurde', () => {
    // Der wichtigste Fall: Ohne Angabe soll das Fenster dort bleiben, wo es
    // steht. Ein Rückfall auf den Hauptbildschirm hieße, dass jedes „mach
    // groß" das Fenster vom zweiten Schirm wegholt.
    assert.equal(pickDisplay(ZWEI, undefined), null)
    assert.equal(pickDisplay(ZWEI, ''), null)
    assert.equal(pickDisplay(ZWEI, '   '), null)
    assert.equal(pickDisplay(ZWEI, 'quatsch'), null)
  })

  it('liefert nichts, wenn kein Bildschirm gemeldet wird', () => {
    assert.equal(pickDisplay([], 'rechts'), null)
  })
})

describe('arrangementRect', () => {
  it('legt Hälften auf den gemeinten Bildschirm, nicht auf den Hauptbildschirm', () => {
    const rechts = arrangementRect(RECHTS, 'right', true)
    assert.ok(rechts)
    // Genau das war der Fehler: Ohne den Bildschirmbezug stand hier x=960,
    // also die rechte Hälfte des linken Schirms.
    assert.equal(rechts.x, 1920 + 960)
    assert.equal(rechts.width, 960)

    const links = arrangementRect(RECHTS, 'left', true)
    assert.ok(links)
    assert.equal(links.x, 1920)
    assert.equal(links.width, 960)
  })

  it('lässt bei ungerader Breite keinen Streifen frei', () => {
    const ungerade = display(1, 0, { width: 1367 })
    const links = arrangementRect(ungerade, 'left', true)
    const rechts = arrangementRect(ungerade, 'right', true)
    assert.ok(links && rechts)
    assert.equal(links.width + rechts.width, 1367)
    assert.equal(rechts.x, links.x + links.width)
  })

  it('bleibt über der Taskleiste', () => {
    // `workArea` statt `bounds` ist der ganze Unterschied: Sonst verschwindet
    // die untere Fensterzeile mit den Knöpfen hinter der Leiste.
    for (const how of ['left', 'right', 'maximize'] as const) {
      const rect = arrangementRect(LINKS, how, true)
      assert.ok(rect)
      assert.equal(rect.height, 1032)
    }
  })

  it('fasst die Größe beim Wiederherstellen nicht an', () => {
    // „Mach es wieder normal" heißt: die Größe zurück, die der Nutzer dem
    // Fenster gegeben hat. Ein Rechteck hier würde eine neue erfinden.
    assert.equal(arrangementRect(LINKS, 'restore', false), null)
  })

  it('setzt beim Wiederherstellen doch etwas, wenn ein Bildschirm genannt ist', () => {
    // Sonst bliebe „hol das normal auf den rechten Schirm" wirkungslos: ohne
    // Rechteck wird nur wiederhergestellt, und zwar dort, wo es schon stand.
    const rect = arrangementRect(RECHTS, 'restore', true)
    assert.ok(rect)
    assert.ok(rect.x >= 1920 && rect.x + rect.width <= 1920 + 1920)
  })

  it('gibt fürs Minimieren kein Rechteck vor', () => {
    assert.equal(arrangementRect(LINKS, 'minimize', true), null)
  })
})
