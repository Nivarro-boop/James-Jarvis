import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { modelTurn } from '@main/providers/geminiTurn'

describe('Modellzug für den Verlauf', () => {
  it('behält die thoughtSignature aus der Antwort', () => {
    const parts = [{ functionCall: { name: 'click', args: {} }, thoughtSignature: 'abc' }]
    const turn = modelTurn({ candidates: [{ content: { parts } }] }, [{ functionCall: { name: 'click', args: {} } }])
    assert.equal(turn.parts[0].thoughtSignature, 'abc')
  })

  it('baut nach, wenn die Antwort keine Teile hat', () => {
    const fallback = [{ functionCall: { name: 'click', args: {} } }]
    assert.deepEqual(modelTurn({}, fallback).parts, fallback)
  })
})
