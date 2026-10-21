const LOCAL_CHANNELS = new Set([
  'settings:get', 'secrets:status', 'app:openSettings', 'app:quit', 'app:showLog', 'app:pauseGet',
  'brain:graph', 'brain:note', 'brain:widgets', 'activity:get', 'context:get',
  'skills:list', 'skills:proposals', 'contacts:list', 'memory:list',
  'reminder:list', 'timers:list', 'research:list', 'research:get', 'selfheal:status',
  'backup:list', 'backup:create', 'backup:openFolder',
  'recovery:status', 'recovery:preview', 'recovery:createProfile', 'recovery:activateProfile', 'recovery:returnToDefault',
  'packs:preview', 'packs:install', 'packs:list', 'packs:setEnabled', 'packs:remove', 'packs:widgets', 'packs:toggle',
  'workspace:get', 'workspace:task-create', 'workspace:task-set-done', 'workspace:task-delete', 'workspace:layout-set'
])

/** Recovery is an inspection profile, not an implicit grant to resume services.
 * New channels default to denied. A UI setting or a forged request cannot turn
 * on remote calendars, providers, microphone, phone, tools or account access.
 */
export function isRecoveryIpcAllowed(channel: string, payload: unknown): boolean {
  if (channel === 'workspace:calendar-enabled') return !!payload && typeof payload === 'object' && (payload as { enabled?: unknown }).enabled === false
  if (channel === 'app:pauseState') return !!payload && typeof payload === 'object' && (payload as { paused?: unknown }).paused === true && !(payload as { until?: unknown }).until
  return LOCAL_CHANNELS.has(channel)
}
