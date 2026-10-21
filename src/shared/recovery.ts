export interface RecoveryPreview {
  fileName: string
  digest: string
  backupFormat: 'void-james-backup'
  backupVersion: number
  createdAt: number
  appVersion: string
  compressedBytes: number
  databaseBytes: number
  integrity: 'ok'
  tables: string[]
  included: string[]
  excluded: string[]
  warnings: string[]
}

export interface RecoveryProfileResult {
  profileId: string
  digest: string
  directory: string
  launchArgument: string
}

const SAFE_PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Accept only one exact, UUID-shaped recovery switch; never accept arbitrary userData paths. */
export function safeRecoveryProfileId(args: readonly string[]): string | null {
  const matches = args.filter(value => value.startsWith('--james-recovery-profile='))
  if (matches.length !== 1) return null
  const id = matches[0].slice('--james-recovery-profile='.length)
  return SAFE_PROFILE_ID.test(id) ? id : null
}

/** Add this interface to IpcInvokeMap when integrating the recovery IPC handlers. */
export interface RecoveryIpcMap {
  'recovery:status': { req: void; res: { active: boolean } }
  'recovery:preview': { req: { fileName: string }; res: RecoveryPreview }
  'recovery:createProfile': { req: { fileName: string; digest: string; confirmed: true }; res: RecoveryProfileResult }
  'recovery:activateProfile': { req: { profileId: string; confirmed: true }; res: void }
  'recovery:returnToDefault': { req: { confirmed: true }; res: void }
}
