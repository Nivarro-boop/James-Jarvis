import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ToolLoopGuard, budgetNotice, callSignature, clipResult, digestDropped, guardedCall, isRunawayRepetition } from '@shared/agentLoop'
import { budgetConversation } from '@shared/conversationBudget'

/**
 * Hermes-Leitplanken der Werkzeugschleifen: wiederholte Fehlschläge werden
 * erst angemerkt, dann blockiert; ein Werkzeug, das dauernd scheitert, hält
 * die Schleife an; gegen Ende der Runden kommt Budgetdruck.
 */
describe('ToolLoopGuard', () => {
  it('Signatur hängt nicht von der Reihenfolge der Argumente ab', () => {
    assert.equal(callSignature('a', { x: 1, y: [2, { b: 1, a: 2 }] }), callSignature('a', { y: [2, { a: 2, b: 1 }], x: 1 }))
  })

  it('warnt nach zwei gleichen Fehlschlägen und blockiert nach fünf', async () => {
    const guard = new ToolLoopGuard()
    let runs = 0
    const fail = () => { runs++; return Promise.resolve({ ok: false, error: 'kaputt' }) }
    const first = await guardedCall(guard, 'web_fetch', { url: 'x' }, fail)
    assert.equal(first.error, 'kaputt')
    const second = await guardedCall(guard, 'web_fetch', { url: 'x' }, fail)
    assert.match(second.error ?? '', /2-mal fehlgeschlagen/)
    for (let i = 0; i < 3; i++) await guardedCall(guard, 'web_fetch', { url: 'x' }, fail)
    const blocked = await guardedCall(guard, 'web_fetch', { url: 'x' }, fail)
    assert.equal(runs, 5)
    assert.match(blocked.error ?? '', /Nicht ausgeführt/)
  })

  it('hält nach acht Fehlschlägen desselben Werkzeugs an', async () => {
    const guard = new ToolLoopGuard()
    for (let i = 0; i < 8; i++) await guardedCall(guard, 'mail_send', { n: i }, async () => ({ ok: false, error: 'nein' }))
    const decision = guard.before('mail_send', { n: 99 })
    assert.equal(decision.action, 'halt')
    assert.equal(guard.halted, true)
  })

  it('merkt fehlenden Fortschritt bei immer gleichem Ergebnis', async () => {
    const guard = new ToolLoopGuard()
    const same = async () => ({ ok: true, result: 'gleich' })
    await guardedCall(guard, 'file_read', { p: 1 }, same)
    await guardedCall(guard, 'file_read', { p: 1 }, same)
    const third = await guardedCall(guard, 'file_read', { p: 1 }, same)
    assert.match(String(third.result), /Kein Fortschritt/)
  })

  it('Erfolg setzt den Fehlerzähler des Werkzeugs zurück', async () => {
    const guard = new ToolLoopGuard()
    for (let i = 0; i < 7; i++) await guardedCall(guard, 't', { i }, async () => ({ ok: false, error: 'x' }))
    await guardedCall(guard, 't', { ok: 1 }, async () => ({ ok: true, result: 'ja' }))
    await guardedCall(guard, 't', { i: 100 }, async () => ({ ok: false, error: 'x' }))
    assert.equal(guard.before('t', { i: 101 }).action, 'run')
  })
})

describe('Budgetdruck', () => {
  it('meldet sich erst ab 70 % und drängt ab 90 %', () => {
    assert.equal(budgetNotice(0, 10), undefined)
    assert.match(budgetNotice(6, 10) ?? '', /3 Runden übrig/)
    assert.match(budgetNotice(8, 10) ?? '', /Jetzt abschließen/)
  })

  it('hängt den Hinweis an das Ergebnis', async () => {
    const out = await guardedCall(new ToolLoopGuard(), 'x', {}, async () => ({ ok: true, result: 'ok' }), { round: 8, limit: 10 })
    assert.match(String(out.result), /^ok\n\n\[Budget\]/)
  })

  it('kürzt sehr lange Ergebnisse', () => {
    const text = clipResult('a'.repeat(20000), 1000)
    assert.ok(text.length < 1100)
    assert.match(text, /gekürzt/)
  })
})

describe('Wiederholungswächter', () => {
  it('erkennt eine festgefahrene Antwort', () => {
    assert.equal(isRunawayRepetition('Das Wetter ist schön und warm. '.repeat(30)), true)
  })
  it('lässt normalen Text in Ruhe', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Satz Nummer ${i} sagt etwas anderes.`).join(' ')
    assert.equal(isRunawayRepetition(text), false)
    assert.equal(isRunawayRepetition('kurz'), false)
  })
})

describe('Verlaufsverdichtung', () => {
  it('fasst Weggefallenes als Notiz zusammen', () => {
    const digest = digestDropped([{ role: 'user', content: 'Wie heißt mein Hund?' }, { role: 'assistant', content: 'Bello.' }])
    assert.match(digest ?? '', /Nutzer: Wie heißt mein Hund\?\nJames: Bello\./)
  })
  it('stellt die Notiz beim Kürzen voran und beginnt danach mit einer Frage', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Nachricht ${i}` }))
    const out = budgetConversation(history as never, false)
    assert.match(String(out[0].content), /^\[Früher im Gespräch\]/)
    assert.equal(out[1].role, 'user')
    assert.ok(out.length <= 13)
  })
  it('lässt kurzen Verlauf unverändert', () => {
    const history = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]
    assert.deepEqual(budgetConversation(history as never, false), history)
  })
})
