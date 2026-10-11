import { Database } from 'node-sqlite3-wasm'

/**
 * „database is locked“ — woher es kommt und was dagegen hilft.
 *
 * node-sqlite3-wasm kennt keine Dateisperren des Betriebssystems. Es sperrt
 * über ein Verzeichnis `<datei>.lock`: Wer es anlegen kann, hat die Sperre, wer
 * auf `EEXIST` läuft, bekommt SQLITE_BUSY — und SQLite wartet darauf nicht,
 * weil das WASM-Modul keinen Busy-Handler hat. Jeder Zugriff, der auf ein
 * vorhandenes Verzeichnis trifft, scheitert also sofort.
 *
 * Das Verzeichnis ist vorhanden, wenn
 *   - ein Absturz oder das Beenden durch den Installer es hinterlassen hat, oder
 *   - ein anderer Prozess gerade mitten in einer Anweisung steckt.
 * Innerhalb dieses Prozesses kann es nicht passieren: Es gibt genau ein Handle
 * (siehe `initDb`), und jeder Aufruf läuft synchron durch.
 *
 * Gegen den zweiten Fall hilft Warten — eine Anweisung dauert Millisekunden.
 * Das geschieht hier synchron, denn alle Aufrufer sind synchron und sollen es
 * bleiben. Der Hauptprozess steht dabei kurz still, aber nur im Ausnahmefall
 * und nur so lange, wie die Wartezeiten unten zusammen ergeben.
 */

/** Im Betrieb: kurz, denn ein Hänger blockiert den Hauptprozess (rund 0,6 s). */
export const STEADY_RETRY_MS: readonly number[] = [5, 10, 20, 40, 80, 160, 320]

/** Beim Start: großzügiger, hier wartet ohnehin noch kein Fenster (rund 2,5 s). */
export const STARTUP_RETRY_MS: readonly number[] = [50, 100, 200, 400, 800, 1000]

/**
 * Ist das SQLITE_BUSY?
 *
 * Bewusst nicht „database table is locked“ (SQLITE_LOCKED): Das entsteht
 * innerhalb derselben Verbindung, etwa beim Löschen einer Tabelle unter einer
 * offenen Abfrage, und verschwindet durch Warten nicht.
 */
export function isLockedError(err: unknown): boolean {
  return err instanceof Error && /database is locked|SQLITE_BUSY/i.test(err.message)
}

/** Schlafen, ohne den Prozess zu beschäftigen — `Atomics.wait` ist dafür gedacht. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export interface RetryOptions {
  /** Wartezeiten zwischen den Versuchen; ihre Anzahl ist die Zahl der Wiederholungen. */
  delays?: readonly number[]
  /** Austauschbar, damit Tests nicht wirklich warten müssen. */
  sleep?: (ms: number) => void
  /** Vor jeder Wiederholung, z. B. um eine hinterlassene Sperre wegzuräumen. */
  onBusy?: (attempt: number, err: Error) => void
  /** Nach einem Fehlschlag gefragt: `false` bricht ab und wirft den Fehler weiter. */
  canRetry?: () => boolean
}

/**
 * Führt `work` aus und wiederholt es, solange die Datenbank gesperrt ist.
 *
 * Jeder andere Fehler geht sofort durch — eine Wiederholung ändert weder an
 * einer verletzten Bedingung noch an einem Tippfehler im SQL etwas. Ist die
 * Sperre nach der letzten Wartezeit noch da, wird der ursprüngliche Fehler
 * geworfen und nicht ein neuer: Wer ihn liest, sieht SQLites eigene Meldung.
 */
export function retryWhileLocked<T>(work: () => T, options: RetryOptions = {}): T {
  const { delays = STEADY_RETRY_MS, sleep = sleepSync, onBusy, canRetry } = options
  for (let attempt = 0; ; attempt++) {
    try {
      return work()
    } catch (err) {
      if (!isLockedError(err) || attempt >= delays.length || (canRetry && !canRetry())) throw err
      onBusy?.(attempt + 1, err as Error)
      sleep(delays[attempt])
    }
  }
}

/**
 * Die Datenbank, die bei „database is locked“ kurz wartet, statt sofort zu werfen.
 *
 * Als Unterklasse und nicht als Hülle um jede der gut sechzig Aufrufstellen:
 * Sie alle gehen über `run`, `get`, `all` und `exec`, und so ändert sich an
 * keiner von ihnen etwas.
 */
export class LockTolerantDatabase extends Database {
  /** Wartezeiten dieses Handles; der Start setzt sie vorübergehend höher. */
  lockRetryDelays: readonly number[] = STEADY_RETRY_MS
  /** Wird vor jeder Wiederholung gerufen — der Start räumt hier alte Sperren weg. */
  lockBusyHook: (() => void) | undefined

  private retry<T>(work: () => T, canRetry?: () => boolean): T {
    return retryWhileLocked(work, {
      delays: this.lockRetryDelays,
      onBusy: () => this.lockBusyHook?.(),
      canRetry
    })
  }

  // `exec` führt womöglich mehrere Anweisungen aus. Blieb dabei eine
  // Transaktion offen, würde das erneute Ausführen ein zweites BEGIN
  // schicken — dann lieber den Fehler durchreichen, der Aufrufer rollt zurück.
  override exec(sql: string): void {
    this.retry(() => super.exec(sql), () => !this.inTransaction)
  }

  override run(...args: Parameters<Database['run']>): ReturnType<Database['run']> {
    return this.retry(() => super.run(...args))
  }

  override get(...args: Parameters<Database['get']>): ReturnType<Database['get']> {
    return this.retry(() => super.get(...args))
  }

  override all(...args: Parameters<Database['all']>): ReturnType<Database['all']> {
    return this.retry(() => super.all(...args))
  }
}
