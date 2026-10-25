import assert from 'node:assert/strict'
import { it } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { ICLOUD_SERVICES, isICloudContentUrl, isICloudServiceUrl } from '@shared/icloud'

it('restricts iCloud content to HTTPS Apple hosts', () => {
  for (const url of Object.values(ICLOUD_SERVICES)) assert.equal(isICloudContentUrl(url), true)
  assert.equal(isICloudContentUrl('https://p123-mailws.icloud.com/'), true)
  assert.equal(isICloudServiceUrl('https://www.icloud.com/mail', 'mail'), true)
  assert.equal(isICloudServiceUrl('https://www.icloud.com/mail/?folder=inbox', 'mail'), true)
  assert.equal(isICloudServiceUrl('https://www.icloud.com/mailish', 'mail'), false)
  assert.equal(isICloudServiceUrl('https://evil.test/mail/', 'mail'), false)
  for (const url of ['https://icloud.com.evil.test/', 'https://fakeicloud.com/', 'http://www.icloud.com/', 'data:text/html,test']) {
    assert.equal(isICloudContentUrl(url), false)
  }
})

it('routes Apple services into the integrated browser and waits for a loaded page before reading', async () => {
  const fixture = { opened: [] as string[], visibility: [] as boolean[], reads: 0, state: { open: true, activeId: 'a', tabs: [] as Array<{ id: string; url: string; loading: boolean }> } }
  const bundled = await build({ entryPoints: [resolve('src/main/tools/impl/icloud.ts')], bundle: true,
    write: false, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
    alias: { '@shared': resolve('src/shared') }, plugins: [{ name: 'icloud-fixture', setup(b) {
      b.onResolve({ filter: /\/(registry|windows\/crystal|browser\/panel)$/ }, () => ({ path: 'dependencies', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const defineTool = x => x;
        export const createCrystalWindow = () => {};
        export const getCrystalWindow = () => ({});
        export const browserState = () => fixture.state;
        export const browserAction = () => {};
        export const openBrowser = (url, reuse, visible = true) => { fixture.opened.push(url); fixture.visibility.push(visible); };
        export const readBrowserText = async (limit, allowed) => {
          if (!allowed('https://www.icloud.com/mail/') || allowed('https://evil.test/')) throw new Error('Invalid frame filter');
          fixture.reads++;
          return { url: 'https://www.icloud.com/mail/', text: 'Posteingang' };
        };
      ` }))
    } }] })
  const module = { exports: {} as typeof import('../src/main/tools/impl/icloud') }
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, fixture, URL, Error,
    require: createRequire(resolve('package.json')) })
  const read = module.exports.icloudTools.find(t => t.name === 'icloud_read')!
  const open = module.exports.icloudTools.find(t => t.name === 'icloud_open')!
  await read.execute({ service: 'mail' }, {} as never)
  assert.deepEqual(fixture.opened, [ICLOUD_SERVICES.mail])
  assert.equal(fixture.visibility[0], false)
  assert.equal(fixture.reads, 0)
  fixture.state.tabs = [{ id: 'a', url: ICLOUD_SERVICES.mail, loading: true }]
  await read.execute({ service: 'mail' }, {} as never)
  assert.equal(fixture.reads, 0)
  fixture.state.tabs[0].loading = false
  fixture.state.open = false
  const result = await read.execute({ service: 'mail', maxChars: 200 }, {} as never) as { inhalt: string; hinweis: string }
  assert.equal(result.inhalt, 'Posteingang')
  assert.match(result.hinweis, /Anmeldung nicht automatisch bestätigt/)
  await open.execute({ service: 'photos' }, {} as never)
  assert.equal(fixture.opened.at(-1), ICLOUD_SERVICES.photos)
  assert.equal(fixture.visibility.at(-1), true)
  assert.equal(read.schema.safeParse({ service: 'https://evil.test/' }).success, false)
})
