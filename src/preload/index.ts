import { contextBridge, ipcRenderer } from 'electron'
import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS } from '@shared/ipc'
import type { IpcEventMap, IpcInvokeMap } from '@shared/ipc'

/**
 * Enge Brücke: nur die Kanäle aus dem Vertrag kommen durch.
 * Kein `ipcRenderer` im Renderer, kein Node, keine Remote-Module.
 */

const invokeSet = new Set<string>(IPC_INVOKE_CHANNELS)
const eventSet = new Set<string>(IPC_EVENT_CHANNELS)

const api = {
  invoke<C extends keyof IpcInvokeMap>(
    channel: C,
    payload?: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> {
    if (!invokeSet.has(channel as string)) {
      return Promise.reject(new Error(`IPC-Kanal nicht erlaubt: ${String(channel)}`))
    }
    return ipcRenderer.invoke(channel as string, payload)
  },

  on<C extends keyof IpcEventMap>(
    channel: C,
    listener: (payload: IpcEventMap[C]) => void
  ): () => void {
    if (!eventSet.has(channel as string)) {
      throw new Error(`IPC-Ereignis nicht erlaubt: ${String(channel)}`)
    }
    const wrapped = (_e: unknown, payload: IpcEventMap[C]): void => listener(payload)
    ipcRenderer.on(channel as string, wrapped)
    return () => ipcRenderer.removeListener(channel as string, wrapped)
  },

  /** Nur für das Einstellungsfenster: Sprung zu einem Abschnitt. */
  onNavigate(listener: (section: string) => void): () => void {
    const wrapped = (_e: unknown, section: string): void => listener(section)
    ipcRenderer.on('settings:navigate', wrapped)
    return () => ipcRenderer.removeListener('settings:navigate', wrapped)
  },

  /**
   * Global registrierter Hotkey. Läuft über den Main-Prozess, damit er auch
   * greift, während Minecraft im Vordergrund ist.
   */
  onPushToTalk(listener: () => void): () => void {
    const wrapped = (): void => listener()
    ipcRenderer.on('hotkey:pushToTalk', wrapped)
    return () => ipcRenderer.removeListener('hotkey:pushToTalk', wrapped)
  },

  /** Fenstersteuerung aus dem Renderer heraus; der Rahmen kommt von Windows. */
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close'),
    setAlwaysOnTop: (v: boolean) => ipcRenderer.send('window:alwaysOnTop', v)
  }
}

contextBridge.exposeInMainWorld('jarvis', api)

export type JarvisApi = typeof api
