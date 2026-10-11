/**
 * Zeichnet die Programmsymbole: `resources/icon.ico` mit neun Größen für
 * Installer, Taskleiste und Explorer, `resources/icon.png` (256 × 256) als
 * Nachschlagfassung und `resources/tray.png` (32 × 32) für den Infobereich.
 *
 * Warum überhaupt gezeichnet und nicht abgelegt: electron-builder verlangt für
 * das Windows-Ziel ein Symbol von mindestens 256 × 256. Ein Skript statt einer
 * Binärdatei, damit Farbe und Form nachvollziehbar bleiben und sich mit dem
 * Hauptfenster zusammen ändern lassen. Bewusst ohne Bibliothek — hier wird in
 * einen Puffer gemalt und der als PNG geschrieben; `zlib` liegt in Node bei,
 * und eine Abhängigkeit für zwei Dutzend Zeilen Rasterung wäre nicht zu
 * rechtfertigen.
 *
 * Gezeichnet wird derselbe Lichtkörper wie im Fenster, nur flach und still.
 *
 * Hier stand vorher ein Oktaeder mit vier beleuchteten Flächen — der End
 * Crystal, den die App einmal zeigte. Er ist weg, und mit ihm seine
 * Begründung: Ein Umriss, den man auf 16 Bildpunkten noch erkennt, war das
 * Argument für die hochkante Raute. Ein Lichtkörper hat keinen Umriss, den man
 * schärfen könnte. Was ihn trägt, ist etwas anderes — ein heller Kern, ein
 * sattes Blau darum, und ein Rand, der ausgeht statt aufzuhören.
 *
 * Gerechnet wird deshalb dasselbe wie im Shader, eine Dimension tiefer: vier
 * Gaußglocken, deren Summe die Dichte ergibt. Die Dichte entscheidet über
 * beides zugleich — über die Farbe (dünn ist gesättigt und dunkel, dicht ist
 * fast weiß) und über die Deckkraft. Ein Feld, keine Silhouette mit Füllung.
 * Der Schein ringsum ist kein zweiter Effekt, sondern der Ausläufer derselben
 * Glocken; deshalb sitzt er auch garantiert dort, wo der Körper heller ist.
 *
 * Zwei Größen, zwei Abstimmungen. Bei 16 Bildpunkten ist ein überwiegend
 * weißer Fleck ein Schmierer und kein Symbol: Dort wird die Farbrampe nach
 * Blau verschoben, der Kern kleiner gehalten und die Kante härter gezogen.
 * Bei 256 darf der Körper ausatmen.
 *
 * Aufruf:  node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RES = join(HERE, '..', 'resources')

/*
  Farben (sRGB).

  Dieselbe Leiter wie im Ruhezustand der Kugel (`LOOKS.idle` in
  src/renderer/crystal/states.ts): fast weißes Eis, wo das Feld dicht ist,
  gesättigtes Azur darunter, ein tieferes und kühleres Blau dort, wo das Licht
  nur noch streift. AURA ist der Schein hinter der Kugel — derselbe Wert wie
  `--aura` in styles.css.

  Angegeben sind sie hier in sRGB, im Shader dagegen linear. Das ist kein
  Widerspruch: Dort geht der Wert durch die Farbraumumrechnung von three, hier
  wird er unverändert in die Datei geschrieben.
*/
const ICE = [234, 245, 255]
const AZURE = [61, 140, 245]
const DEEP = [21, 66, 173]
const AURA = [110, 168, 255]

/**
 * Die vier Lappen.
 *
 * Im Fenster wandern sie auf unvereinbaren Bahnen; hier stehen sie fest, denn
 * ein Symbol, das bei jedem Bau anders aussieht, ist keins. Ausgesucht sind
 * sie so, dass die Summe oben links am dichtesten ist — dort, wo im Fenster
 * das Licht steht — und nach unten rechts hin dünner wird.
 *
 * `p` ist die Breite der Glocke in Einheiten des Feldradius, `w` ihr Gewicht.
 * Beides bewusst ungleich: Vier gleich große Glocken ergeben wieder einen
 * Kreis, und ein Kreis ist das, was hier gerade nicht herauskommen soll.
 */
const LOBES = [
  // Der Kern, und bewusst zwei: Eine einzelne enge Glocke ergibt eine runde
  // weiße Scheibe in der Mitte des Körpers, und die liest sich als Auge. Zwei
  // dicht beieinander liegende ergeben einen Grat, der schräg nach oben links
  // läuft — Licht, das sich staut, statt einer Pupille.
  { x: -0.2, y: -0.22, p: 0.3, w: 0.85 },
  { x: -0.02, y: -0.08, p: 0.27, w: 0.72 },
  // Die Masse. Groß, schwach, versetzt: Sie trägt den Umriss, nicht die
  // Helligkeit.
  { x: 0.2, y: 0.1, p: 0.5, w: 0.75 },
  { x: -0.08, y: 0.26, p: 0.44, w: 0.62 },
  // Ein Ausläufer nach oben rechts. Ohne ihn ist der Körper eine Birne.
  { x: 0.3, y: -0.24, p: 0.28, w: 0.3 }
]



/**
 * Die Dichte, unterhalb derer gar nichts mehr gezeichnet wird.
 *
 * Siehe die Begründung in `render`: Der Ausläufer einer Gaußglocke endet
 * nirgends von selbst, und der Rand der Kachel ist der falsche Ort dafür.
 */
const GLOW_FLOOR = 0.05

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** Weicher Übergang, damit die Kanten nach dem Verkleinern nicht ausfransen. */
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Die Dichte an einer Stelle des Feldes, in Einheiten des Feldradius.
 *
 * In der Mitte kommt sie auf gut zwei, bei Radius eins auf wenige Hundertstel.
 * Diese Spanne ist der ganze Bildaufbau: Alles Weitere sind Schwellen darauf —
 * eine für die Farbe, zwei für die Deckkraft.
 */
function field(x, y) {
  let d = 0
  for (const l of LOBES) {
    const dx = x - l.x
    const dy = y - l.y
    d += l.w * Math.exp(-(dx * dx + dy * dy) / (l.p * l.p))
  }
  return d
}

/**
 * Die Mitte des Umrisses — nicht die Mitte der Glocken.
 *
 * Das Feld ist absichtlich unsymmetrisch, also sitzt sein Körper nicht im
 * Ursprung. Für ein Symbol zählt aber die Kachel: Was darin nach oben links
 * rutscht, steht in der Taskleiste neben anderen Symbolen schief.
 *
 * Nach dem Schwerpunkt der Gewichte zu verschieben reichte nicht — eine breite
 * schwache Glocke wiegt dort so viel wie eine enge starke, sichtbar ist sie
 * aber viel größer. Gesucht wird deshalb der Umriss selbst: einmal grob
 * abgetastet, das umschließende Rechteck bei der Schwelle genommen, dessen
 * Mitte verschoben. Das kostet einen Wimpernschlag beim Start und stimmt auch
 * dann noch, wenn oben eine Glocke dazukommt.
 */
const [CX, CY] = (() => {
  // Dieselbe Schwelle wie `edge` bei den großen Größen: Dort hört der Körper
  // sichtbar auf.
  const REF = 0.3
  const STEP = 0.004
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (let y = -2; y <= 2; y += STEP) {
    for (let x = -2; x <= 2; x += STEP) {
      if (field(x, y) < REF) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2]
})()

/** Die Dichte, wie das Symbol sie sieht: um die Mitte des Umrisses verschoben. */
function density(u, v) {
  return field(u + CX, v + CY)
}

/**
 * Malt ein Symbol in einen Float-Puffer und gibt ihn verkleinert zurück.
 *
 * `hot` ist die Dichte, ab der es weiß wird, `edge` die, unterhalb derer der
 * Körper aufhört, und `solid` die, ab der er nicht mehr durchsichtig ist. Der
 * Abstand zwischen `edge` und `hot` ist die Farbrampe — je enger, desto härter
 * das Symbol.
 */
function render(size, { ss, radius, hot, edge, solid, aura }) {
  const W = size * ss
  const px = new Float32Array(W * W * 4)

  const blend = (i, r, g, b, a) => {
    if (a <= 0) return
    const o = px[i + 3]
    const out = a + o * (1 - a)
    if (out <= 0) return
    px[i] = (r * a + px[i] * o * (1 - a)) / out
    px[i + 1] = (g * a + px[i + 1] * o * (1 - a)) / out
    px[i + 2] = (b * a + px[i + 2] * o * (1 - a)) / out
    px[i + 3] = out
  }

  const C = W / 2
  const R = W * radius

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      // Auf Pixelmitte abtasten, sonst sitzt die ganze Zeichnung um ein halbes
      // Subpixel daneben.
      const u = (x + 0.5 - C) / R
      const v = (y + 0.5 - C) / R

      const d = density(u, v)
      /*
        Wo der Schein aufhört.

        Eine Gaußglocke wird nie null, und der Ausläufer ist länger, als er
        aussieht: Ohne diese Grenze reicht ein Rest Blau bis in die Ecken der
        Kachel und darüber hinaus — dort wird er dann hart abgeschnitten, und
        aus dem Schein wird ein Quadrat. Abgeschnitten wird er deshalb hier,
        solange er noch unsichtbar ist. Nebenbei spart es bei 256 mit
        sechzehnfacher Abtastung die halbe Rechnung.
      */
      if (d < GLOW_FLOOR) continue

      const i = (y * W + x) * 4

      /*
        Der Schein.

        Kein eigener Effekt, sondern der Ausläufer derselben Glocken: alles
        unterhalb der Körperkante, sehr schwach und in der Farbe des Scheins
        hinter der Kugel. Mit einer Potenz hochgezogen, damit er zur Mitte hin
        schnell zunimmt, statt als gleichmäßiger Dunst über der ganzen Fläche
        zu liegen.
      */
      const tail = smoothstep(GLOW_FLOOR, edge, d)
      blend(i, AURA[0], AURA[1], AURA[2], Math.pow(tail, 2.2) * aura)

      /*
        Der Körper.

        Farbe und Deckkraft kommen aus derselben Zahl, laufen aber
        unterschiedlich schnell: Die Deckkraft ist deutlich vor der Farbe bei
        eins. Ohne diesen Vorsprung wäre der Rand halbdurchsichtig und satt
        zugleich — und säße ein heller Taskleistenknopf dahinter, schiene er
        durch das Blau hindurch.
      */
      const raw = Math.min(1, Math.max(0, (d - edge) / (hot - edge)))
      // Die Rampe wird nach hinten gebogen, damit das Blau die Fläche behält
      // und das Weiß ein Kern bleibt. Linear gelesen sähe das Symbol aus wie
      // ein Spiegelei: außen ein Ring, innen eine große weiße Scheibe.
      const t = Math.pow(raw, 1.45)
      // Zwei überlappende Übergänge statt zweier aneinandergesetzter: An der
      // Nahtstelle dreier fest gesetzter Farben knickt die Kurve sonst, und in
      // acht Bit ist so ein Knick ein sichtbarer Ring mitten im Verlauf.
      const col = mix(mix(DEEP, AZURE, smoothstep(0, 0.62, t)), ICE, smoothstep(0.55, 1, t))
      blend(i, col[0], col[1], col[2], smoothstep(edge, solid, d))
    }
  }

  // --- Verkleinern (Mittelwert über ss × ss) ---------------------------
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const i = ((y * ss + sy) * W + (x * ss + sx)) * 4
          const w = px[i + 3]
          // Farbe mit der Deckkraft gewichten, sonst zieht Transparenz die
          // Kanten ins Schwarze.
          r += px[i] * w
          g += px[i + 1] * w
          b += px[i + 2] * w
          a += w
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round((a / (ss * ss)) * 255)
    }
  }
  return out
}

// --- PNG schreiben ------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // Bit-Tiefe
  ihdr[9] = 6 // RGBA
  // 10–12: Kompression, Filter, Interlace — je 0

  // Jede Zeile bekommt ihr Filter-Byte vorangestellt; 0 heißt "unverändert".
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function writePng(file, size, rgba) {
  const png = encodePng(size, rgba)
  writeFileSync(file, png)
  console.log(`${file} — ${size}×${size}, ${(png.length / 1024).toFixed(1)} kB`)
}

// --- ICO schreiben ------------------------------------------------------
/**
 * Warum überhaupt ein ICO und nicht bloß das große PNG.
 *
 * Aus einem einzelnen PNG baut electron-builder die Symboldatei selbst, indem
 * es 256 × 256 auf jede benötigte Größe herunterrechnet. Für 128 geht das gut,
 * für 16 nicht: Was dort ankommt, ist der Mittelwert aus je 256 Bildpunkten,
 * und ein Verlauf, der zur Hälfte aus Schein besteht, mittelt sich zu einem
 * blassblauen Fleck. Genau deshalb gibt es für den Infobereich schon eine
 * eigene Zeichnung — und genau dieselbe Begründung gilt für die Taskleiste,
 * den Explorer und das Startmenü.
 *
 * Jede Größe wird deshalb einzeln gezeichnet, mit dem Feinwerk, das bei ihr
 * noch trägt, und alle zusammen wandern in eine Datei.
 */

/**
 * 32-Bit-DIB — die Form, in der ein ICO die kleinen Größen erwartet.
 *
 * PNG im ICO versteht Windows seit Vista, aber nicht überall gleich gut: In
 * älteren Dialogen und manchen Verknüpfungsansichten bleibt ein
 * PNG-16 × 16 einfach leer. Unterhalb von 128 Bildpunkten also die alte Form,
 * darüber PNG — sonst wird die Datei unnötig groß (256 × 256 unkomprimiert
 * sind eine Viertelmillion Bildpunkte).
 */
function dib(size, rgba) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  // Doppelte Höhe: Im Kopf zählen Farbteil und Maskenteil zusammen.
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12) // Ebenen
  header.writeUInt16LE(32, 14) // Bit je Bildpunkt

  const colors = Buffer.alloc(size * size * 4)
  // Die Maske bleibt leer: Bei 32 Bit steht die Deckkraft im Alphakanal, sie
  // muss aber trotzdem dastehen, sonst stimmt die Länge nicht.
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size)

  for (let y = 0; y < size; y++) {
    // DIB-Zeilen laufen von unten nach oben, und die Kanäle stehen als BGRA.
    const src = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x++) {
      const s = src + x * 4
      const d = (y * size + x) * 4
      colors[d] = rgba[s + 2]
      colors[d + 1] = rgba[s + 1]
      colors[d + 2] = rgba[s]
      colors[d + 3] = rgba[s + 3]
    }
  }

  header.writeUInt32LE(colors.length + mask.length, 20)
  return Buffer.concat([header, colors, mask])
}

function writeIco(file, images) {
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(1, 2) // 1 = Symbol, 2 wäre ein Mauszeiger
  dir.writeUInt16LE(images.length, 4)

  const entries = []
  let offset = 6 + images.length * 16

  for (const img of images) {
    const e = Buffer.alloc(16)
    // 256 wird als 0 notiert — in ein Byte passt es nicht.
    e[0] = img.size >= 256 ? 0 : img.size
    e[1] = img.size >= 256 ? 0 : img.size
    e.writeUInt16LE(1, 4) // Ebenen
    e.writeUInt16LE(32, 6) // Bit je Bildpunkt
    e.writeUInt32LE(img.data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += img.data.length
    entries.push(e)
  }

  const ico = Buffer.concat([dir, ...entries, ...images.map((i) => i.data)])
  writeFileSync(file, ico)
  console.log(
    `${file} — ${images.map((i) => i.size).join(', ')}, ${(ico.length / 1024).toFixed(1)} kB`
  )
}

/**
 * Was bei welcher Größe noch trägt.
 *
 * Ein Lichtkörper lebt von seinen Übergängen, und Übergänge sind genau das,
 * was ein 16-Bildpunkt-Raster nicht hat. Unterhalb von 48 Punkten wird deshalb
 * alles enger gezogen: Der Körper geht später aus (`edge` höher), wird früher
 * deckend (`solid` höher) und bleibt länger blau, statt in die Mitte hin weiß
 * zu werden (`hot` höher). Aus dem Verlauf wird so eine Farbe mit einem
 * hellen Kern darin — das Einzige, was bei dieser Größe noch ankommt.
 *
 * Der Schein wird dabei kleiner, nicht größer. Bei 256 ist er der Raum um den
 * Körper; bei 16 wären es zwei blasse Bildpunkte ringsum, die den Körper
 * selbst um ein Viertel schrumpfen ließen, damit sie hineinpassen.
 */
function profile(size) {
  const tiny = size <= 24
  const small = size < 48
  return {
    // Immer auf mindestens 384 Kantenlänge abtasten, dann verkleinern.
    ss: Math.min(16, Math.max(4, Math.round(384 / size))),
    radius: tiny ? 0.62 : small ? 0.63 : 0.6,
    hot: tiny ? 1.95 : small ? 1.85 : 1.72,
    edge: tiny ? 0.42 : small ? 0.36 : 0.3,
    solid: tiny ? 0.66 : small ? 0.6 : 0.52,
    aura: tiny ? 0.22 : small ? 0.3 : 0.42
  }
}

/** Die Größen, die Windows für Taskleiste, Explorer und Startmenü zieht. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

writeIco(
  join(RES, 'icon.ico'),
  ICO_SIZES.map((size) => {
    const rgba = render(size, profile(size))
    return { size, data: size >= 128 ? encodePng(size, rgba) : dib(size, rgba) }
  })
)

// Das große Symbol bleibt zusätzlich als PNG liegen: für alles, was kein ICO
// lesen kann, und als das, was man aufmacht, wenn man nachsehen will, wie es
// aussieht.
writePng(join(RES, 'icon.png'), 256, render(256, profile(256)))

/**
 * Das Symbol der Telefonseite.
 *
 * Es lag als eigene Datei im Ordner der Fernbedienung und blieb dort liegen,
 * als sich Form und Farbe änderten — ein violetter Kristall auf dem
 * Startbildschirm, während am Rechner längst ein blauer Lichtkörper stand.
 * Deshalb wird es hier mitgeschrieben: Ein Symbol, das man von Hand kopieren
 * muss, wird irgendwann nicht kopiert.
 *
 * 512 Bildpunkte, weil das Anzeigeverzeichnis genau diese Größe angibt — es
 * stand dort schon vorher, die Datei hatte aber nur 256.
 */
writePng(join(RES, 'companion', 'icon.png'), 512, render(512, profile(512)))

/**
 * Und dasselbe noch einmal für Android.
 *
 * Ein maskierbares Symbol darf sich seine Form nicht aussuchen: Das
 * Betriebssystem schneidet es zu einem Kreis, einem abgerundeten Quadrat oder
 * was der Hersteller sonst vorsieht. Zugesichert ist nur der innere Kreis mit
 * 80 % Durchmesser — was außerhalb liegt, kann weg sein.
 *
 * Dieselbe Datei für beide Zwecke anzugeben, wie es das Verzeichnis vorher tat,
 * heißt deshalb: Auf einem Android-Startbildschirm ist vom Körper der Rand ab.
 * Hier wird er stattdessen kleiner gezeichnet, sodass auch der Schein noch
 * innerhalb des zugesicherten Kreises bleibt.
 *
 * Und er steht auf einer deckenden Fläche statt auf Durchsichtigkeit: Was ein
 * maskierbares Symbol nicht selbst füllt, füllt das System — meist weiß, und
 * ein weißer Ring um einen blauen Lichtkörper ist genau das Gegenteil von dem,
 * was er darstellen soll. Der Ton ist der Fensterhintergrund aus styles.css.
 */
const MASK_BG = [7, 10, 18]

function onOpaque(size, rgba, bg) {
  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const a = rgba[i * 4 + 3] / 255
    out[i * 4] = Math.round(rgba[i * 4] * a + bg[0] * (1 - a))
    out[i * 4 + 1] = Math.round(rgba[i * 4 + 1] * a + bg[1] * (1 - a))
    out[i * 4 + 2] = Math.round(rgba[i * 4 + 2] * a + bg[2] * (1 - a))
    out[i * 4 + 3] = 255
  }
  return out
}

writePng(
  join(RES, 'companion', 'icon-maskable.png'),
  512,
  onOpaque(512, render(512, { ...profile(512), radius: 0.51 }), MASK_BG)
)

// Der Infobereich holt sich sein Bild zur Laufzeit als PNG, nicht aus dem ICO.
// Windows verkleinert die 32 auf 16, wenn die Anzeige nicht skaliert ist —
// deshalb die Abstimmung der kleinsten Größe, obwohl hier 32 Bildpunkte
// gezeichnet werden. Nur die Abtastung bleibt die der echten Größe.
writePng(join(RES, 'tray.png'), 32, render(32, { ...profile(16), ss: profile(32).ss }))
