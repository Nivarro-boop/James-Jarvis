import type { Page, Locator } from 'playwright-core'
import type { WebsiteAccountInput } from '@shared/websiteAccounts'
import { sameLoginOrigin, websiteLoginUrl } from '@shared/websiteAccounts'
import { detectBlock } from './chromeCdp'

export interface WebsiteLoginResult { status: 'submitted' | 'needs-user' | 'check-page' | 'rejected'; reason?: string }
async function onlyVisible(locator: Locator): Promise<Locator | null> {
  const visible: Locator[] = []
  for (let i = 0, n = Math.min(await locator.count(), 30); i < n; i++) if (await locator.nth(i).isVisible()) visible.push(locator.nth(i))
  return visible.length === 1 ? visible[0] : null
}

/** Credentials stay in this function and the exact approved HTTPS origin. No model-selected selectors. */
export async function performWebsiteLogin(page: Page, account: WebsiteAccountInput, signal: AbortSignal): Promise<WebsiteLoginResult> {
  const origin = websiteLoginUrl(account.loginUrl).origin
  const verify = (): void => { signal.throwIfAborted(); if (!sameLoginOrigin(page.url(), origin)) throw new Error('origin-changed') }
  try {
    // Drei Schritte: viele Seiten fragen erst die E-Mail, dann auf einer zweiten Seite das Passwort.
    for (let step = 0; step < 3; step++) {
      verify()
      const blocked = await detectBlock(page, { allowLogin: true })
      if (blocked) return { status: 'needs-user', reason: blocked }
      const password = await onlyVisible(page.locator('input[type="password"]:not([autocomplete="new-password"])'))
      let scope = password ? password.locator('xpath=ancestor::form') : page.locator('form')
      if (await scope.count() !== 1) {
        if (await scope.count() > 1) scope = (await onlyVisible(scope)) ?? scope
        // Einzelseiten-Apps haben oft gar kein <form>; dann gilt die Seite als Formular.
        if (await scope.count() !== 1) scope = page.locator('body')
      }
      const action = await scope.getAttribute('action')
      if (action && !sameLoginOrigin(new URL(action, page.url()).toString(), origin)) return { status: 'needs-user', reason: 'Das Formular sendet an eine andere Website. Kontodaten wurden nicht eingetragen.' }
      if (await scope.locator('input[autocomplete="new-password"]').count()) return { status: 'needs-user', reason: 'Das Formular könnte eine Registrierung sein. Bitte im Browser übernehmen.' }
      const username = await onlyVisible(scope.locator('input[type="email"], input[autocomplete="username"], input[autocomplete="email"], input[name="username"], input[name="email"], input[name="login"], input[id*="email" i], input[id*="user" i], input[name*="user" i]'))
        ?? (password ? null : await onlyVisible(scope.locator('input[type="text"], input[type="tel"]')))
      const submitNames = /^(jetzt )?(anmelden|einloggen|log ?in|sign ?in|weiter|next|continue|fortfahren|login)( ?→| ?›)?$/i
      // Knöpfe für fremde Anmeldedienste („Mit Google anmelden") nie drücken.
      const foreign = /google|apple|facebook|microsoft|github|amazon|passkey|sso/i
      let submit = await onlyVisible(scope.getByRole('button', { name: submitNames }))
      if (!submit) {
        const generic = await onlyVisible(scope.locator('button[type="submit"], input[type="submit"]'))
        if (generic && !foreign.test((await generic.innerText().catch(() => '')) + (await generic.getAttribute('value') ?? ''))) submit = generic
      }
      if (!username && !password) return { status: 'needs-user', reason: 'Anmeldefelder sind nicht eindeutig. Bitte im Browser übernehmen.' }
      if (username) { verify(); await username.fill(account.username, { timeout: 5000 }) }
      if (password) { verify(); await password.fill(account.password, { timeout: 5000 }) }
      verify()
      // Recheck the form after filling: input handlers can change the submission target.
      const finalAction = await scope.getAttribute('action')
      if (finalAction && !sameLoginOrigin(new URL(finalAction, page.url()).toString(), origin)) return { status: 'needs-user', reason: 'Das Formularziel wurde geändert. Anmeldung wurde nicht abgesendet.' }
      const challenge = await detectBlock(page, { allowLogin: true })
      if (challenge) return { status: 'needs-user', reason: challenge }
      const beforeUrl = page.url()
      const beforeText = await page.locator('body').innerText({ timeout: 1500 })
      verify()
      if (submit) await submit.click({ timeout: 5000 })
      else await (password ?? username)!.press('Enter', { timeout: 5000 })
      await page.waitForFunction(({ url, text }) => location.href !== url || document.body.innerText !== text, { url: beforeUrl, text: beforeText }, { timeout: 8000 }).catch(() => undefined)
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined)
      if (password) {
        const nextGate = await detectBlock(page, { allowLogin: true })
        if (nextGate) return { status: 'needs-user', reason: nextGate }
        // Steht das Passwortfeld noch da und ist eine Fehlermeldung sichtbar, hat die Seite die Daten abgelehnt.
        const stillLogin = await page.locator('input[type="password"]').first().isVisible().catch(() => false)
        const errorText = stillLogin && /falsch|ungültig|incorrect|invalid|wrong|nicht erkannt|stimmt nicht|try again|erneut versuchen/i
          .test(await page.locator('[role="alert"], .error, .alert, [class*="error" i], [aria-live]').allInnerTexts().then(t => t.join(' ')).catch(() => ''))
        if (errorText) return { status: 'rejected', reason: 'Die Website hat die gespeicherten Anmeldedaten abgelehnt. Bitte unter Einstellungen → Zugänge prüfen.' }
        return stillLogin ? { status: 'check-page', reason: 'Das Anmeldefeld ist noch sichtbar. Mit chrome_read_page prüfen.' } : { status: 'submitted' }
      }
    }
    return { status: 'needs-user', reason: 'Die Anmeldung braucht weitere Schritte. Bitte im Browser übernehmen.' }
  } catch {
    // Playwright errors may embed fill values. Never forward the original error or stack.
    return { status: 'needs-user', reason: signal.aborted ? 'Anmeldung abgebrochen.' : 'Die Seite wurde geändert oder konnte nicht sicher bedient werden. Bitte im Browser übernehmen.' }
  }
}
