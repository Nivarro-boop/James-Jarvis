export interface WebsiteAccountInfo { origin: string; loginUrl: string }
export interface WebsiteAccountInput { loginUrl: string; username: string; password: string }

export function websiteLoginUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('Bitte eine vollständige HTTPS-Anmeldeadresse eingeben.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || raw.length > 2048) {
    throw new Error('Die Anmeldeadresse muss HTTPS verwenden und darf keine Zugangsdaten, Parameter oder Anker enthalten.')
  }
  return url
}
export function sameLoginOrigin(pageUrl: string, origin: string): boolean {
  try { const u = new URL(pageUrl); return u.protocol === 'https:' && u.origin === origin && !u.username && !u.password }
  catch { return false }
}
