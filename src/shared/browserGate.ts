/** Recognize a request for human interaction; never solve or evade the challenge. */
export function browserGate(input: { url: string; title: string; text: string; visibleChallenge?: boolean }): 'captcha' | 'login' | null {
  let url: URL
  try { url = new URL(input.url) } catch { return null }
  if (/\/errors\/validateCaptcha/i.test(url.pathname) || input.visibleChallenge ||
      /robot check|captcha|sicherheitsabfrage|security check|just a moment|checking your browser/i.test(input.title) ||
      /verify (?:that )?you are human|bestätige[n]?[,]? dass du ein mensch bist|überprüfe[n]?[,]? ob du ein mensch bist|ich bin kein roboter|i(?:'m| am) not a robot/i.test(input.text)) return 'captcha'
  if (/(^|\.)amazon\.[a-z.]+$/i.test(url.hostname) && /\/ap\/signin/i.test(url.pathname)) return 'login'
  return null
}
