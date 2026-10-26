// Narrow local mitigations while Expo 58 depends on affected upstream versions.
// Keep version checks: dependency changes require a deliberate patch review.
const fs = require('node:fs')
const path = require('node:path')
const root = path.dirname(require.resolve('../package.json'))
function patch(pkg, version, relative, marker, transform) {
  const base = path.join(root, 'node_modules', pkg)
  const installed = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')).version
  if (installed !== version) throw new Error(`Review security patch for ${pkg}@${installed} (expected ${version})`)
  const file = path.join(base, relative), source = fs.readFileSync(file, 'utf8')
  if (source.includes(marker)) return
  const next = transform(source)
  if (source === next || !next.includes(marker)) throw new Error(`Security patch did not match ${file}`)
  fs.writeFileSync(file, next)
}
patch('node-forge', '1.4.0', 'lib/rsa.js', 'JAMES_STRICT_DIGEST_ALGORITHM', source => source.replace(
  'obj.value.length !== 2) {',
  `obj.value.length !== 2 ||
            // JAMES_STRICT_DIGEST_ALGORITHM: reject ignored nested ASN.1 elements.
            !Array.isArray(obj.value[0].value) ||
            obj.value[0].value.length < 1 || obj.value[0].value.length > 2) {`
))
for (const [file, issue, code, invalid] of [
  ['v3/types.cjs', '(0, parseUtil_js_1.addIssueToContext)', 'ZodError_js_1.ZodIssueCode', 'parseUtil_js_1.INVALID'],
  ['v3/types.js', 'addIssueToContext', 'ZodIssueCode', 'INVALID']
]) {
  patch('zod', '3.25.76', file, 'JAMES_ARRAY_PARSE_LIMIT', source => {
    const index = source.indexOf('class ZodArray extends ZodType')
    if (index < 0) return source
    const before = source.slice(0, index), body = source.slice(index)
    return before + body.replace('        if (def.exactLength !== null) {', `        // JAMES_ARRAY_PARSE_LIMIT: bound issue allocation before visiting items.
        const parseLimit = Math.min(10000, def.maxLength?.value ?? Infinity, def.exactLength?.value ?? Infinity);
        if (ctx.data.length > parseLimit) {
            ${issue}(ctx, { code: ${code}.too_big, maximum: parseLimit, type: 'array', inclusive: true, exact: false });
            return ${invalid};
        }
        if (def.exactLength !== null) {`)
  })
}
console.log('Applied/verified Expo 58 local security mitigations (forge and Zod v3).')
