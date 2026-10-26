const assert = require('node:assert/strict')
const { it } = require('node:test')
const forge = require('node-forge')

it('verifies normal RSA signatures and rejects extra nested DigestAlgorithm elements', () => {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 })
  const md = forge.md.sha256.create().update('synthetic test')
  const digest = md.digest().getBytes()
  assert.equal(keys.publicKey.verify(digest, keys.privateKey.sign(md)), true)
  const a = forge.asn1
  const der = a.toDer(a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
    a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
      a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer(forge.oids.sha256).getBytes()),
      a.create(a.Class.UNIVERSAL, a.Type.NULL, false, ''),
      a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, 'extra')
    ]),
    a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, digest)
  ])).getBytes()
  assert.throws(() => keys.publicKey.verify(digest, keys.privateKey.sign(der, 'NONE')), /DigestInfo/)
})

it('rejects oversized arrays before allocating per-element issues in CJS and ESM', async () => {
  for (const z of [require('zod').z, (await import('zod')).z]) {
    let visited = 0
    const schema = z.array(z.number().superRefine(() => { visited++ })).max(2)
    const result = schema.safeParse(new Array(100_000).fill(1))
    assert.equal(result.success, false)
    assert.equal(result.error.issues.length, 1)
    assert.equal(visited, 0)
    assert.equal(z.array(z.number()).safeParse(new Array(10_001).fill(1)).success, false)
    assert.equal(z.array(z.number()).safeParse([1, 2]).success, true)
  }
})
