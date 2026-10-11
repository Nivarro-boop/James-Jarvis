import type { Settings } from './types'

/** Preserve edit order and let later edits proceed after a rejected update. */
export class SettingsWriteQueue {
  private tail: Promise<void> = Promise.resolve()
  constructor(private write: (patch: Partial<Settings>) => Promise<Settings>) {}
  enqueue(patch: Partial<Settings>): Promise<Settings> {
    const next = this.tail.then(() => this.write(patch))
    this.tail = next.then(() => {}, () => {})
    return next
  }
}
