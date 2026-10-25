import assert from 'node:assert/strict'
import { it } from 'node:test'
import { DEFAULT_SETTINGS } from '@shared/config/defaults'
import { validateSettingsPatch } from '@shared/config/validation'
import { VOICES, type Settings } from '@shared/types'
import { VOICE_GALLERY, activeGalleryVoice, galleryPatch, galleryVoice, pcmRate, pcmToWav } from '@shared/voiceGallery'

const base = structuredClone(DEFAULT_SETTINGS) as unknown as Settings

it('gallery voices exist at their provider and ids are unique', () => {
  const ids = new Set<string>()
  for (const entry of VOICE_GALLERY) {
    assert.ok(!ids.has(entry.id), entry.id)
    ids.add(entry.id)
    if (entry.provider === 'gemini') assert.ok(VOICES.some((v) => v.name === entry.voice), entry.voice)
    if (entry.provider === 'elevenlabs') assert.ok(entry.elevenId, entry.id)
  }
  assert.ok(VOICE_GALLERY.filter((v) => v.siriLike).length >= 2)
})

it('choosing a gallery voice yields a valid settings patch and becomes active', () => {
  for (const entry of VOICE_GALLERY) {
    const patch = galleryPatch(base, entry)
    validateSettingsPatch(patch)
    const next = { ...base, ...patch, speech: { ...base.speech, ...patch.speech }, piper: { ...base.piper, ...patch.piper } } as Settings
    if (entry.provider === 'piper') next.piper.voicePath = `C:/voices/${entry.voice}.onnx`
    assert.equal(next.speech.provider, entry.provider)
    assert.equal(activeGalleryVoice(next)?.id, entry.id)
  }
})

it('a manually changed voice is no longer reported as the gallery choice', () => {
  const entry = galleryVoice('gemini-erinome')!
  const patch = galleryPatch(base, entry)
  const next = { ...base, ...patch, speech: { ...base.speech, ...patch.speech } } as Settings
  assert.equal(activeGalleryVoice({ ...next, voice: 'Puck' })?.id, undefined)
  assert.equal(activeGalleryVoice({ ...next, speech: { ...next.speech, provider: 'piper' } })?.id, undefined)
})

it('wraps Gemini PCM into a playable WAV header', () => {
  const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]), 24000)
  assert.equal(wav.length, 48)
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE')
  const view = new DataView(wav.buffer)
  assert.equal(view.getUint32(24, true), 24000)
  assert.equal(view.getUint32(40, true), 4)
  assert.equal(pcmRate('audio/L16;codec=pcm;rate=16000'), 16000)
  assert.equal(pcmRate(undefined), 24000)
  assert.equal(pcmRate('rate=999999'), 24000)
})
