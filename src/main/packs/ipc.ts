import type { FeaturePackIpcMap } from '@shared/featurePacks'
import { FeaturePackService } from './service'

/**
 * Parent bridge integration: spread/dispatch these typed handlers through its
 * existing trustedSender-guarded `handle()` helper. This module deliberately
 * does not register raw ipcMain handlers.
 */
export function createFeaturePackHandlers(userDataPath: string): { [C in keyof FeaturePackIpcMap]: (payload: FeaturePackIpcMap[C]['req']) => FeaturePackIpcMap[C]['res'] | Promise<FeaturePackIpcMap[C]['res']> } {
  const packs = new FeaturePackService(userDataPath)
  return {
    'packs:preview': (payload) => packs.preview(payload.json),
    'packs:install': (payload) => packs.install(payload),
    'packs:list': () => packs.list(),
    'packs:setEnabled': (payload) => packs.setEnabled(payload.id, payload.enabled),
    'packs:remove': async (payload) => { await packs.remove(payload.id) },
    'packs:widgets': () => packs.widgets(),
    'packs:toggle': (payload) => packs.toggle(payload)
  }
}
