import type { ChildProcess } from 'node:child_process'

/** Stop only the process this application owns, giving its persistence hook time. */
export async function stopOwnedChild(
  processChild: ChildProcess,
  requestStop: () => Promise<void>,
  forceStop: () => Promise<void>,
  graceMs = 10_000
): Promise<void> {
  if (!processChild.pid || processChild.exitCode !== null || processChild.signalCode !== null) return
  let timer: ReturnType<typeof setTimeout> | undefined
  let onExit: () => void = () => {}
  const exited = new Promise<void>(resolve => {
    onExit = resolve
    processChild.once('exit', onExit)
    timer = setTimeout(resolve, graceMs)
  })
  try {
    // The exit listener is installed before requesting shutdown.
    void requestStop().catch(() => {})
    await exited
    if (processChild.exitCode === null && processChild.signalCode === null) await forceStop()
  } finally {
    if (timer) clearTimeout(timer)
    processChild.removeListener('exit', onExit)
  }
}
