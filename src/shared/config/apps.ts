/**
 * App-Registry.
 *
 * Bekannte Pfade sind vorbefüllt (auf diesem Rechner verifiziert), alles andere
 * wird zur Laufzeit über Desktop-Verknüpfungen und Startmenü aufgelöst.
 * `aliases` sind die Wörter, die du tatsächlich sagst — James matcht darauf,
 * nicht auf den exakten Programmnamen.
 */

export interface AppEntry {
  id: string
  label: string
  /** Absoluter Pfad. Null = zur Laufzeit auflösen. */
  path: string | null
  args?: string[]
  /** Gesprochene Varianten, kleingeschrieben. */
  aliases: string[]
  category: 'browser' | 'game' | 'launcher' | 'social' | 'creative' | 'dev' | 'system'
  /** Fenstertitel-Muster zum Wiederfinden eines bereits laufenden Fensters. */
  windowMatch?: string
}

const LOCAL = '%LOCALAPPDATA%'
const ROAMING = '%APPDATA%'
const PF = '%ProgramFiles%'
const PF86 = '%ProgramFiles(x86)%'

export const APP_REGISTRY: AppEntry[] = [
  // ── Minecraft ──────────────────────────────────────────────
  {
    id: 'norisk',
    label: 'NoRisk Client',
    path: `${LOCAL}\\NoRisk Launcher\\noriskclient-launcher-v3.exe`,
    aliases: ['norisk', 'no risk', 'noriskclient', 'norisk launcher', 'minecraft norisk', 'nrc'],
    category: 'launcher',
    windowMatch: 'NoRisk'
  },
  {
    id: 'modrinth',
    label: 'Modrinth App',
    path: `${LOCAL}\\Modrinth App\\Modrinth App.exe`,
    aliases: ['modrinth', 'modrinth app'],
    category: 'launcher',
    windowMatch: 'Modrinth'
  },
  {
    id: 'enderclient',
    label: 'EnderClient',
    path: null,
    aliases: ['ender', 'enderclient', 'ender client'],
    category: 'launcher',
    windowMatch: 'Ender'
  },
  {
    id: 'fastclient',
    label: 'FastClient',
    path: null,
    aliases: ['fastclient', 'fast client'],
    category: 'launcher',
    windowMatch: 'Fast'
  },
  {
    id: 'minecraft',
    label: 'Minecraft',
    path: null,
    aliases: ['minecraft', 'mc', 'vanilla minecraft'],
    category: 'game',
    windowMatch: 'Minecraft'
  },

  // ── Browser ────────────────────────────────────────────────
  {
    id: 'chrome',
    label: 'Google Chrome',
    path: `${PF}\\Google\\Chrome\\Application\\chrome.exe`,
    aliases: ['chrome', 'google chrome', 'browser'],
    category: 'browser',
    windowMatch: 'Chrome'
  },
  {
    id: 'brave',
    label: 'Brave',
    path: `${PF}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    aliases: ['brave'],
    category: 'browser',
    windowMatch: 'Brave'
  },
  {
    id: 'operagx',
    label: 'Opera GX',
    path: `${LOCAL}\\Programs\\Opera GX\\opera.exe`,
    aliases: ['opera', 'opera gx', 'gx'],
    category: 'browser',
    windowMatch: 'Opera'
  },

  // ── Social / Streaming ─────────────────────────────────────
  {
    id: 'discord',
    label: 'Discord',
    path: `${LOCAL}\\Discord\\Update.exe`,
    args: ['--processStart', 'Discord.exe'],
    aliases: ['discord', 'diskord'],
    category: 'social',
    windowMatch: 'Discord'
  },
  {
    id: 'streamlabs',
    label: 'Streamlabs Highlighter',
    path: null,
    aliases: ['streamlabs', 'highlighter', 'stream labs'],
    category: 'creative',
    windowMatch: 'Streamlabs'
  },
  {
    id: 'medal',
    label: 'Medal',
    path: null,
    aliases: ['medal', 'medal tv'],
    category: 'creative',
    windowMatch: 'Medal'
  },

  // ── Kreativ ────────────────────────────────────────────────
  {
    id: 'capcut',
    label: 'CapCut',
    path: null,
    aliases: ['capcut', 'cap cut', 'schnittprogramm'],
    category: 'creative',
    windowMatch: 'CapCut'
  },
  {
    id: 'quietcut',
    label: 'QuietCut',
    path: null,
    aliases: ['quietcut', 'quiet cut'],
    category: 'creative',
    windowMatch: 'QuietCut'
  },

  // ── Spiele ─────────────────────────────────────────────────
  {
    id: 'fortnite',
    label: 'Fortnite',
    path: null,
    aliases: ['fortnite', 'fortnight'],
    category: 'game',
    windowMatch: 'Fortnite'
  },

  // ── Entwicklung ────────────────────────────────────────────
  {
    id: 'antigravity',
    label: 'Antigravity',
    path: null,
    aliases: ['antigravity', 'anti gravity'],
    category: 'dev',
    windowMatch: 'Antigravity'
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    path: null,
    aliases: ['opencode', 'open code'],
    category: 'dev',
    windowMatch: 'OpenCode'
  },

  // ── System ─────────────────────────────────────────────────
  {
    id: 'explorer',
    label: 'Explorer',
    path: 'explorer.exe',
    aliases: ['explorer', 'dateien', 'ordner', 'datei explorer'],
    category: 'system'
  },
  {
    id: 'taskmgr',
    label: 'Task-Manager',
    path: 'taskmgr.exe',
    aliases: ['taskmanager', 'task manager', 'taskmgr'],
    category: 'system'
  }
]

/** Häufig gesagte Webziele — schneller als der Umweg über die Websuche. */
export const URL_SHORTCUTS: Record<string, string> = {
  twitch: 'https://www.twitch.tv/',
  youtube: 'https://www.youtube.com/',
  gmail: 'https://mail.google.com/',
  amazon: 'https://www.amazon.de/',
  geizhals: 'https://geizhals.at/',
  idealo: 'https://www.idealo.de/',
  github: 'https://github.com/',
  modrinth: 'https://modrinth.com/',
  namemc: 'https://namemc.com/'
}

/** Ordner, in denen zur Laufzeit nach Verknüpfungen gesucht wird. */
export const SHORTCUT_SEARCH_DIRS = [
  '%USERPROFILE%\\Desktop',
  '%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs',
  '%ProgramData%\\Microsoft\\Windows\\Start Menu\\Programs'
]

export const PATH_VARS: Record<string, string> = {
  '%LOCALAPPDATA%': LOCAL,
  '%APPDATA%': ROAMING,
  '%ProgramFiles%': PF,
  '%ProgramFiles(x86)%': PF86
}
