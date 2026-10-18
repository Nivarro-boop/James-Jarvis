import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildIcs,
  eventsInRange,
  googleCalendarLink,
  normalizeIcsUrl,
  outlookCalendarLink,
  parseIcsDate
} from '@shared/ics'

/**
 * Kalender per iCal-Link.
 *
 * Geprüft wird mit Ausschnitten, wie Google, Outlook und iCloud sie
 * tatsächlich ausliefern: gefaltete Zeilen, TZID, UTC, ganztägig, Serien mit
 * Ausnahmen und verschobenen Einzelterminen.
 */

const cal = (body: string): string => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`

describe('parseIcsDate', () => {
  it('liest UTC', () => {
    assert.equal(parseIcsDate('20261020T080000Z')?.ms, Date.UTC(2026, 9, 20, 8, 0, 0))
  })
  it('liest TZID mit Sommerzeit', () => {
    assert.equal(parseIcsDate('20260715T100000', { TZID: 'Europe/Berlin' })?.ms, Date.UTC(2026, 6, 15, 8, 0, 0))
  })
  it('liest TZID mit Winterzeit', () => {
    assert.equal(parseIcsDate('20261215T100000', { TZID: 'Europe/Vienna' })?.ms, Date.UTC(2026, 11, 15, 9, 0, 0))
  })
  it('versteht Windows-Zonennamen', () => {
    assert.equal(parseIcsDate('20261215T100000', { TZID: 'W. Europe Standard Time' })?.ms, Date.UTC(2026, 11, 15, 9, 0, 0))
  })
  it('liest ganztägig als lokale Mitternacht', () => {
    const d = parseIcsDate('20261020', { VALUE: 'DATE' })
    assert.equal(d?.allDay, true)
    assert.equal(d?.ms, new Date(2026, 9, 20).getTime())
  })
})

describe('eventsInRange', () => {
  it('entfaltet Zeilen und Sonderzeichen', () => {
    const text = cal(
      'BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261020T080000Z\r\nDTEND:20261020T090000Z\r\nSUMMARY:Zahnarzt\\, Kontr\r\n olle\r\nLOCATION:Wien\\nPraxis\r\nEND:VEVENT'
    )
    const [e] = eventsInRange(text, Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 21))
    assert.equal(e.title, 'Zahnarzt, Kontrolle')
    assert.equal(e.location, 'Wien\nPraxis')
    assert.equal(e.end - e.start, 3600000)
  })

  it('ignoriert VALARM und abgesagte Termine', () => {
    const text = cal(
      'BEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261020T080000Z\r\nSUMMARY:Echt\r\nBEGIN:VALARM\r\nSUMMARY:Alarm\r\nEND:VALARM\r\nEND:VEVENT\r\n' +
        'BEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261020T100000Z\r\nSUMMARY:Weg\r\nSTATUS:CANCELLED\r\nEND:VEVENT'
    )
    const out = eventsInRange(text, Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 21))
    assert.deepEqual(out.map((e) => e.title), ['Echt'])
  })

  it('erweitert Wochenserien mit BYDAY, EXDATE und COUNT', () => {
    const text = cal(
      'BEGIN:VEVENT\r\nUID:s\r\nDTSTART:20261019T070000Z\r\nDTEND:20261019T073000Z\r\nSUMMARY:Standup\r\n' +
        'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5\r\nEXDATE:20261021T070000Z\r\nEND:VEVENT'
    )
    const out = eventsInRange(text, Date.UTC(2026, 9, 1), Date.UTC(2026, 11, 1))
    // Mo 19., (Mi 21. gestrichen), Mo 26., Mi 28., Mo 2.11. — COUNT zählt die gestrichene mit.
    assert.equal(out.length, 4)
    assert.equal(new Date(out[1].start).getUTCDate(), 26)
  })

  it('ersetzt verschobene Einzeltermine', () => {
    const text = cal(
      'BEGIN:VEVENT\r\nUID:s\r\nDTSTART:20261019T070000Z\r\nSUMMARY:Serie\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n' +
        'BEGIN:VEVENT\r\nUID:s\r\nRECURRENCE-ID:20261020T070000Z\r\nDTSTART:20261020T120000Z\r\nSUMMARY:Serie (verschoben)\r\nEND:VEVENT'
    )
    const out = eventsInRange(text, Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 25))
    assert.deepEqual(out.map((e) => e.title), ['Serie', 'Serie (verschoben)', 'Serie'])
    assert.equal(new Date(out[1].start).getUTCHours(), 12)
  })

  it('beachtet UNTIL und Monatsenden', () => {
    const text = cal(
      'BEGIN:VEVENT\r\nUID:m\r\nDTSTART:20260131T080000Z\r\nSUMMARY:Monat\r\nRRULE:FREQ=MONTHLY;UNTIL=20260601T000000Z\r\nEND:VEVENT'
    )
    const out = eventsInRange(text, Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1))
    // Januar, März, Mai — Februar und April haben keinen 31.
    assert.equal(out.length, 3)
  })

  it('zeigt laufende Termine, die vor dem Fenster begonnen haben', () => {
    const text = cal('BEGIN:VEVENT\r\nUID:a\r\nDTSTART;VALUE=DATE:20261019\r\nDTEND;VALUE=DATE:20261022\r\nSUMMARY:Urlaub\r\nEND:VEVENT')
    const out = eventsInRange(text, new Date(2026, 9, 20, 12).getTime(), new Date(2026, 9, 21).getTime())
    assert.equal(out.length, 1)
    assert.equal(out[0].allDay, true)
  })
})

describe('normalizeIcsUrl', () => {
  it('macht webcal zu https', () => {
    assert.equal(normalizeIcsUrl('webcal://p01-caldav.icloud.com/x'), 'https://p01-caldav.icloud.com/x')
  })
  it('lehnt http und Zugangsdaten ab', () => {
    assert.equal(normalizeIcsUrl('http://example.com/a.ics'), null)
    assert.equal(normalizeIcsUrl('https://u:p@example.com/a.ics'), null)
    assert.equal(normalizeIcsUrl('kein link'), null)
  })
})

describe('Termin zum Selbst-Speichern', () => {
  const draft = {
    title: 'Treffen; mit, Anna',
    start: new Date(Date.UTC(2026, 9, 20, 8, 0)),
    end: new Date(Date.UTC(2026, 9, 20, 9, 0)),
    location: 'Café'
  }

  it('baut eine gültige ICS, die der eigene Leser zurückliest', () => {
    const ics = buildIcs(draft, 'x@test', new Date(Date.UTC(2026, 9, 18)))
    assert.match(ics, /SUMMARY:Treffen\\; mit\\, Anna/)
    assert.ok(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75))
    const [e] = eventsInRange(ics, Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 21))
    assert.equal(e.title, 'Treffen; mit, Anna')
    assert.equal(e.start, draft.start.getTime())
  })

  it('faltet lange Zeilen', () => {
    const ics = buildIcs({ ...draft, description: 'ä'.repeat(200) }, 'x@test')
    assert.ok(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75))
    const [e] = eventsInRange(ics, Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 21))
    assert.equal(e.description, 'ä'.repeat(200))
  })

  it('baut Google- und Outlook-Links', () => {
    const g = new URL(googleCalendarLink(draft))
    assert.equal(g.hostname, 'calendar.google.com')
    assert.equal(g.searchParams.get('dates'), '20261020T080000Z/20261020T090000Z')
    const o = new URL(outlookCalendarLink(draft, true))
    assert.equal(o.hostname, 'outlook.office.com')
    assert.equal(o.searchParams.get('subject'), 'Treffen; mit, Anna')
  })
})
