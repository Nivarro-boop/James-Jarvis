import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  ICLOUD_SERVICE_IDS,
  ICLOUD_SERVICE_LABELS,
  davCalendarData,
  davCalendars,
  davHref,
  hasICloudAuthCookie,
  iCloudDriveCandidates,
  isICloudDavUrl,
  normalizeAppPassword,
  normalizeICloudAddress
} from '@shared/icloud'
import { eventsInRange } from '@shared/ics'

it('accepts only app-specific passwords in Apple format', () => {
  assert.equal(normalizeAppPassword('abcd-efgh-ijkl-mnop'), 'abcd-efgh-ijkl-mnop')
  assert.equal(normalizeAppPassword(' ABCD EFGH IJKL MNOP '), 'abcd-efgh-ijkl-mnop')
  assert.equal(normalizeAppPassword('abcdefghijklmnop'), 'abcd-efgh-ijkl-mnop')
  for (const bad of ['', 'meinPasswort123', 'abcd-efgh-ijkl', 'abcd-efgh-ijkl-mno1', 'abcd-efgh-ijkl-mnopq']) {
    assert.equal(normalizeAppPassword(bad), null, bad)
  }
})

it('normalizes iCloud mail addresses', () => {
  assert.equal(normalizeICloudAddress(' Hans@iCloud.com '), 'hans@icloud.com')
  assert.equal(normalizeICloudAddress('hans@example.at'), 'hans@example.at')
  for (const bad of ['', 'hans', 'hans@', '@icloud.com', 'a b@icloud.com', 'x@icloud.com\r\nBcc: y@z.com']) {
    assert.equal(normalizeICloudAddress(bad), null, bad)
  }
})

it('sends DAV credentials only to Apple CalDAV hosts', () => {
  assert.equal(isICloudDavUrl('https://caldav.icloud.com/'), true)
  assert.equal(isICloudDavUrl('https://p52-caldav.icloud.com:443/123/calendars/'), true)
  for (const bad of ['http://caldav.icloud.com/', 'https://caldav.icloud.com.evil.test/', 'https://p52-caldav.evil.test/', 'https://www.icloud.com/', 'not a url']) {
    assert.equal(isICloudDavUrl(bad), false, bad)
  }
})

it('lists every service with a label', () => {
  for (const id of ICLOUD_SERVICE_IDS) assert.ok(ICLOUD_SERVICE_LABELS[id])
  assert.ok(ICLOUD_SERVICE_IDS.includes('drive'))
  assert.ok(ICLOUD_SERVICE_IDS.includes('mail'))
})

it('detects only unexpired iCloud auth cookies', () => {
  const now = 1_000_000
  assert.equal(hasICloudAuthCookie([{ name: 'X-APPLE-WEBAUTH-TOKEN', domain: '.icloud.com', expirationDate: now + 100 }], now), true)
  assert.equal(hasICloudAuthCookie([{ name: 'X-APPLE-WEBAUTH-TOKEN', domain: '.icloud.com', expirationDate: now - 1 }], now), false)
  assert.equal(hasICloudAuthCookie([{ name: 'X-APPLE-WEBAUTH-TOKEN', domain: '.evil.test' }], now), false)
  assert.equal(hasICloudAuthCookie([{ name: 'other', domain: '.icloud.com' }], now), false)
})

it('finds the iCloud for Windows drive folder candidates', () => {
  assert.deepEqual(iCloudDriveCandidates('C:\\Users\\Hans\\'), ['C:\\Users\\Hans\\iCloudDrive', 'C:\\Users\\Hans\\iCloud Drive'])
})

it('reads CalDAV discovery and calendar responses regardless of prefix', () => {
  const principal = '<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><href>/123456/principal/</href></current-user-principal></prop></propstat></response></multistatus>'
  assert.equal(davHref(principal, 'current-user-principal'), '/123456/principal/')
  const home = '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><cal:calendar-home-set xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:href>https://p52-caldav.icloud.com:443/123456/calendars/</d:href></cal:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>'
  assert.equal(davHref(home, 'calendar-home-set'), 'https://p52-caldav.icloud.com:443/123456/calendars/')
  const list = `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
    <response><href>/123456/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>
    <response><href>/123456/calendars/home/</href><propstat><prop><displayname>Privat &amp; Familie</displayname><resourcetype><collection/><C:calendar/></resourcetype><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></prop></propstat></response>
    <response><href>/123456/calendars/tasks/</href><propstat><prop><displayname>Erinnerungen</displayname><resourcetype><collection/><C:calendar/></resourcetype><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></prop></propstat></response>
  </multistatus>`
  assert.deepEqual(davCalendars(list), [{ href: '/123456/calendars/home/', name: 'Privat & Familie' }])
  const report = '<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/e1.ics</href><propstat><prop><C:calendar-data>' +
    'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:e1\nSUMMARY:Zahnarzt &amp; Kontrolle\nDTSTART:20261026T080000Z\nDTEND:20261026T090000Z\nEND:VEVENT\nEND:VCALENDAR' +
    '</C:calendar-data></prop></propstat></response></multistatus>'
  const [ics] = davCalendarData(report)
  const events = eventsInRange(ics, Date.UTC(2026, 9, 26), Date.UTC(2026, 9, 27))
  assert.equal(events.length, 1)
  assert.equal(events[0].title, 'Zahnarzt & Kontrolle')
})
