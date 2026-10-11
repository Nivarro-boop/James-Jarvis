import {
  CONTENT_TYPE,
  REL,
  coreProperties,
  extendedProperties,
  pack,
  part,
  relationships,
  xml,
  type Part
} from './ooxml'

/**
 * PowerPoint-Präsentationen schreiben.
 *
 * Das aufwendigste der drei Formate, und zwar aus einem Grund: Eine Folie kann
 * nicht für sich stehen. Sie verweist auf ein Layout, das Layout auf einen
 * Master, der Master auf ein Design — und fehlt eines davon, öffnet PowerPoint
 * die Datei nicht. Word kommt mit einem einzigen Teil aus, hier sind es
 * mindestens fünf, bevor die erste Folie überhaupt Inhalt hat.
 *
 * Deshalb steht unten viel, das nie sichtbar wird. Zwei Layouts genügen für
 * alles, was aus einem gesprochenen Auftrag entsteht: eine Titelfolie und eine
 * Folie mit Überschrift und Aufzählung.
 *
 * Nicht enthalten sind Sprechernotizen. Sie bräuchten einen eigenen Notizen-
 * Master samt Layout — ein weiterer Zweig im Paket, der stimmen muss, für
 * etwas, das beim Vorlesen einer Folie niemand diktiert.
 */

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export const PPTX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

const TYPE = {
  presentation: `${PPTX_CONTENT_TYPE}.main+xml`,
  slideMaster:
    'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  slideLayout:
    'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml'
} as const

/**
 * Folienmaße in EMU — 914400 auf den Zoll.
 *
 * 13,333 mal 7,5 Zoll ist 16:9, das Format, in dem heute jeder Beamer und
 * jeder Bildschirm arbeitet. 4:3 wäre 9144000 mal 6858000 und ist nicht
 * einstellbar: Wer eine Präsentation diktiert, will sie nicht in einem
 * Seitenverhältnis, das er begründen müsste.
 */
const SLIDE_WIDTH = 12192000
const SLIDE_HEIGHT = 6858000

// ─────────────────────────────────────────────────────────────
// Das Modell
// ─────────────────────────────────────────────────────────────

export interface Slide {
  title: string
  /** Aufzählungspunkte. Leer heißt: Folie nur mit Überschrift. */
  bullets: string[]
}

export interface Presentation {
  title: string
  /** Zeile unter dem Titel der ersten Folie — Anlass, Datum, Name. */
  subtitle?: string
  slides: Slide[]
}

// ─────────────────────────────────────────────────────────────
// Bausteine
// ─────────────────────────────────────────────────────────────

/** Der leere Gruppenrahmen, mit dem jeder Formenbaum anfängt. */
const TREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

interface Box {
  x: number
  y: number
  cx: number
  cy: number
}

function frame(box: Box): string {
  return `<a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>`
}

/**
 * Eine Form mit Platzhalterrolle.
 *
 * `idx` ist der Haken, an dem eine Folie ihren Text in den richtigen Rahmen
 * des Layouts hängt. Für Titel gibt es keinen — der Typ allein genügt —, für
 * jeden weiteren Rahmen schon, und er muss zwischen Layout und Folie
 * übereinstimmen. Stimmt er nicht, landet der Text in einem Kasten in der
 * linken oberen Ecke.
 */
function placeholder(
  id: number,
  name: string,
  phType: string,
  box: Box | null,
  body: string,
  options: { idx?: number; bodyPr?: string } = {}
): string {
  const ph =
    options.idx === undefined
      ? `<p:ph type="${phType}"/>`
      : `<p:ph type="${phType}" idx="${options.idx}"/>`

  return (
    '<p:sp>' +
    `<p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/>` +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    `<p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${box ? frame(box) : ''}</p:spPr>` +
    `<p:txBody><a:bodyPr${options.bodyPr ?? ''}/><a:lstStyle/>${body}</p:txBody>` +
    '</p:sp>'
  )
}

/** Ein Absatz mit einem einzigen Lauf. */
function line(text: string, level = 0): string {
  const properties = level > 0 ? `<a:pPr lvl="${level}"/>` : ''
  return (
    `<a:p>${properties}<a:r><a:rPr lang="de-DE" dirty="0"/>` +
    `<a:t>${xml(text)}</a:t></a:r></a:p>`
  )
}

/** Der leere Absatz, den ein Platzhalter im Layout trägt. */
const EMPTY_PARAGRAPH = '<a:p><a:endParaRPr lang="de-DE"/></a:p>'

// ─────────────────────────────────────────────────────────────
// Rahmenmaße
// ─────────────────────────────────────────────────────────────

/** Titelfolie: beides mittig, wie in PowerPoints eigener Vorlage. */
const TITLE_BOX: Box = { x: 1524000, y: 1122363, cx: 9144000, cy: 2387600 }
const SUBTITLE_BOX: Box = { x: 1524000, y: 3602038, cx: 9144000, cy: 1655762 }

/** Inhaltsfolie: Überschrift oben, Aufzählung darunter. */
const HEADING_BOX: Box = { x: 838200, y: 365125, cx: 10515600, cy: 1325563 }
const CONTENT_BOX: Box = { x: 838200, y: 1825625, cx: 10515600, cy: 4351338 }

// ─────────────────────────────────────────────────────────────
// Design
// ─────────────────────────────────────────────────────────────

/**
 * Das Design.
 *
 * Vollständig, obwohl davon fast nichts sichtbar wird: PowerPoint verlangt in
 * `fmtScheme` genau drei Füllungen, drei Linien, drei Effekte und drei
 * Hintergründe. Zwei davon reichen nicht — die Datei gilt dann als beschädigt,
 * und die Meldung nennt den Grund nicht.
 */
const THEME = ((): string => {
  const colors = [
    ['dk1', '<a:sysClr val="windowText" lastClr="000000"/>'],
    ['lt1', '<a:sysClr val="window" lastClr="FFFFFF"/>'],
    ['dk2', '<a:srgbClr val="44546A"/>'],
    ['lt2', '<a:srgbClr val="E7E6E6"/>'],
    ['accent1', '<a:srgbClr val="4472C4"/>'],
    ['accent2', '<a:srgbClr val="ED7D31"/>'],
    ['accent3', '<a:srgbClr val="A5A5A5"/>'],
    ['accent4', '<a:srgbClr val="FFC000"/>'],
    ['accent5', '<a:srgbClr val="5B9BD5"/>'],
    ['accent6', '<a:srgbClr val="70AD47"/>'],
    ['hlink', '<a:srgbClr val="0563C1"/>'],
    ['folHlink', '<a:srgbClr val="954F72"/>']
  ]
    .map(([name, value]) => `<a:${name}>${value}</a:${name}>`)
    .join('')

  const fontScheme =
    '<a:fontScheme name="Office">' +
    '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
    '</a:fontScheme>'

  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const gradient =
    '<a:gradFill rotWithShape="1"><a:gsLst>' +
    '<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="60000"/><a:satMod val="120000"/></a:schemeClr></a:gs>' +
    '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="90000"/><a:satMod val="120000"/></a:schemeClr></a:gs>' +
    '</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'

  const outline = (width: number): string =>
    `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr">${solid}` +
    '<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>'

  const formatScheme =
    '<a:fmtScheme name="Office">' +
    `<a:fillStyleLst>${solid}${gradient}${gradient}</a:fillStyleLst>` +
    `<a:lnStyleLst>${outline(6350)}${outline(12700)}${outline(19050)}</a:lnStyleLst>` +
    '<a:effectStyleLst>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst>' +
    '<a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0">' +
    '<a:srgbClr val="000000"><a:alpha val="20000"/></a:srgbClr></a:outerShdw>' +
    '</a:effectLst></a:effectStyle>' +
    '</a:effectStyleLst>' +
    `<a:bgFillStyleLst>${solid}${solid}${gradient}</a:bgFillStyleLst>` +
    '</a:fmtScheme>'

  return part(
    `<a:theme xmlns:a="${A}" name="James-Jarvis"><a:themeElements>` +
      `<a:clrScheme name="Office">${colors}</a:clrScheme>` +
      fontScheme +
      formatScheme +
      '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
  )
})()

// ─────────────────────────────────────────────────────────────
// Master
// ─────────────────────────────────────────────────────────────

/**
 * Die Textstufen des Masters.
 *
 * Hier steht, wie groß eine Überschrift ist und welches Zeichen vor einem
 * Aufzählungspunkt kommt — nicht auf der Folie. Deshalb trägt eine Folie
 * unten nur Text: Alles Aussehen kommt von hier, und wer es ändern will,
 * ändert es einmal statt auf zwanzig Folien.
 */
const TEXT_STYLES = ((): string => {
  const level = (index: number, size: number, bullet: string): string =>
    `<a:lvl${index}pPr marL="${index * 342900}" indent="-342900" algn="l">` +
    '<a:spcBef><a:spcPts val="600"/></a:spcBef>' +
    bullet +
    `<a:defRPr sz="${size}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>` +
    '<a:latin typeface="+mn-lt"/></a:defRPr>' +
    `</a:lvl${index}pPr>`

  const dot = '<a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="&#8226;"/>'
  const dash = '<a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="&#8211;"/>'

  return (
    '<p:txStyles>' +
    '<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4000">' +
    '<a:solidFill><a:schemeClr val="dk2"/></a:solidFill>' +
    '<a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
    '<p:bodyStyle>' +
    level(1, 2400, dot) +
    level(2, 2000, dash) +
    level(3, 1800, dot) +
    level(4, 1600, dash) +
    level(5, 1600, dot) +
    '</p:bodyStyle>' +
    '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>' +
    '</p:txStyles>'
  )
})()

const COLOR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
  'hlink="hlink" folHlink="folHlink"/>'

const SLIDE_MASTER = part(
  `<p:sldMaster xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">` +
    '<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>' +
    '<p:spTree>' +
    TREE_HEAD +
    placeholder(2, 'Titelplatzhalter 1', 'title', HEADING_BOX, EMPTY_PARAGRAPH) +
    placeholder(3, 'Textplatzhalter 2', 'body', CONTENT_BOX, EMPTY_PARAGRAPH, { idx: 1 }) +
    '</p:spTree></p:cSld>' +
    COLOR_MAP +
    // Die Kennungen ab 2147483649 sind Konvention und müssen eindeutig sein.
    '<p:sldLayoutIdLst>' +
    '<p:sldLayoutId id="2147483649" r:id="rId1"/>' +
    '<p:sldLayoutId id="2147483650" r:id="rId2"/>' +
    '</p:sldLayoutIdLst>' +
    TEXT_STYLES +
    '</p:sldMaster>'
)

// ─────────────────────────────────────────────────────────────
// Layouts
// ─────────────────────────────────────────────────────────────

/** Layout 1: die Titelfolie. */
const LAYOUT_TITLE = part(
  `<p:sldLayout xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" type="title" preserve="1">` +
    '<p:cSld name="Titelfolie"><p:spTree>' +
    TREE_HEAD +
    placeholder(2, 'Titel 1', 'ctrTitle', TITLE_BOX, EMPTY_PARAGRAPH, {
      bodyPr: ' anchor="b"'
    }) +
    placeholder(3, 'Untertitel 2', 'subTitle', SUBTITLE_BOX, EMPTY_PARAGRAPH, { idx: 1 }) +
    '</p:spTree></p:cSld>' +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    '</p:sldLayout>'
)

/** Layout 2: Überschrift und Aufzählung — die Folie, die es sonst immer ist. */
const LAYOUT_CONTENT = part(
  `<p:sldLayout xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" type="obj" preserve="1">` +
    '<p:cSld name="Titel und Inhalt"><p:spTree>' +
    TREE_HEAD +
    placeholder(2, 'Titel 1', 'title', HEADING_BOX, EMPTY_PARAGRAPH) +
    placeholder(3, 'Inhaltsplatzhalter 2', 'body', CONTENT_BOX, EMPTY_PARAGRAPH, { idx: 1 }) +
    '</p:spTree></p:cSld>' +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    '</p:sldLayout>'
)

// ─────────────────────────────────────────────────────────────
// Folien
// ─────────────────────────────────────────────────────────────

function titleSlide(title: string, subtitle: string): string {
  return part(
    `<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree>` +
      TREE_HEAD +
      placeholder(2, 'Titel 1', 'ctrTitle', null, line(title), { bodyPr: ' anchor="b"' }) +
      placeholder(3, 'Untertitel 2', 'subTitle', null, subtitle ? line(subtitle) : EMPTY_PARAGRAPH, {
        idx: 1
      }) +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  )
}

/**
 * Eine Inhaltsfolie.
 *
 * Führende Bindestriche und Sternchen fliegen raus: Das Aufzählungszeichen
 * kommt vom Master. Schreibt das Modell trotzdem eines davor — und das tut es,
 * wenn man es nicht hindert —, stünde auf der Folie ein Strich hinter einem
 * Punkt.
 */
function contentSlide(slide: Slide): string {
  const items = slide.bullets
    .map((text) => String(text ?? '').replace(/^\s*[-*•]\s*/, '').trim())
    .filter((text) => text.length > 0)

  const body = items.length > 0 ? items.map((text) => line(text)).join('') : EMPTY_PARAGRAPH

  return part(
    `<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree>` +
      TREE_HEAD +
      placeholder(2, 'Titel 1', 'title', null, line(slide.title)) +
      placeholder(3, 'Inhaltsplatzhalter 2', 'body', null, body, { idx: 1 }) +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  )
}

// ─────────────────────────────────────────────────────────────

export function buildPptx(deck: Presentation, when: Date = new Date()): Buffer {
  /*
   * Die Titelfolie entsteht hier und nicht beim Aufrufer.
   *
   * Sie ist die einzige Folie mit einem anderen Layout, und wer eine
   * Präsentation diktiert, nennt ihren Titel — er zählt ihn nicht als erste
   * Folie auf. Käme sie von außen, müsste jeder Aufrufer daran denken.
   */
  const slides = [
    { xml: titleSlide(deck.title, deck.subtitle ?? ''), layout: 1 },
    ...deck.slides.map((slide) => ({ xml: contentSlide(slide), layout: 2 }))
  ]

  // rId1 ist der Master, danach die Folien, das Design zuletzt.
  const themeId = `rId${slides.length + 2}`

  const presentation = part(
    `<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}">` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:sldIdLst>' +
      slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('') +
      '</p:sldIdLst>' +
      `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/>` +
      '<p:notesSz cx="6858000" cy="9144000"/>' +
      '</p:presentation>'
  )

  const parts: Part[] = [
    {
      path: '_rels/.rels',
      content: relationships([
        { id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' },
        { id: 'rId2', type: REL.coreProperties, target: 'docProps/core.xml' },
        { id: 'rId3', type: REL.extendedProperties, target: 'docProps/app.xml' }
      ])
    },
    {
      path: 'ppt/_rels/presentation.xml.rels',
      content: relationships([
        { id: 'rId1', type: REL.slideMaster, target: 'slideMasters/slideMaster1.xml' },
        ...slides.map((_, i) => ({
          id: `rId${i + 2}`,
          type: REL.slide,
          target: `slides/slide${i + 1}.xml`
        })),
        { id: themeId, type: REL.theme, target: 'theme/theme1.xml' }
      ])
    },
    { path: 'ppt/presentation.xml', content: presentation, contentType: TYPE.presentation },
    {
      path: 'ppt/slideMasters/slideMaster1.xml',
      content: SLIDE_MASTER,
      contentType: TYPE.slideMaster
    },
    {
      path: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      content: relationships([
        { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
        { id: 'rId2', type: REL.slideLayout, target: '../slideLayouts/slideLayout2.xml' },
        { id: 'rId3', type: REL.theme, target: '../theme/theme1.xml' }
      ])
    },
    {
      path: 'ppt/slideLayouts/slideLayout1.xml',
      content: LAYOUT_TITLE,
      contentType: TYPE.slideLayout
    },
    {
      path: 'ppt/slideLayouts/slideLayout2.xml',
      content: LAYOUT_CONTENT,
      contentType: TYPE.slideLayout
    },
    // Jedes Layout muss auf seinen Master zurückzeigen. Fehlt diese
    // Rückrichtung, ist das Paket unvollständig und PowerPoint fragt nach
    // der Reparatur.
    ...[1, 2].map((n) => ({
      path: `ppt/slideLayouts/_rels/slideLayout${n}.xml.rels`,
      content: relationships([
        { id: 'rId1', type: REL.slideMaster, target: '../slideMasters/slideMaster1.xml' }
      ])
    })),
    ...slides.map((slide, i) => ({
      path: `ppt/slides/slide${i + 1}.xml`,
      content: slide.xml,
      contentType: TYPE.slide
    })),
    ...slides.map((slide, i) => ({
      path: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      content: relationships([
        {
          id: 'rId1',
          type: REL.slideLayout,
          target: `../slideLayouts/slideLayout${slide.layout}.xml`
        }
      ])
    })),
    { path: 'ppt/theme/theme1.xml', content: THEME, contentType: TYPE.theme },
    {
      path: 'docProps/core.xml',
      content: coreProperties(deck.title, when),
      contentType: CONTENT_TYPE.core
    },
    {
      path: 'docProps/app.xml',
      content: extendedProperties('James-Jarvis'),
      contentType: CONTENT_TYPE.extended
    }
  ]

  return pack(parts, when)
}
