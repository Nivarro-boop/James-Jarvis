import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode, type RefAttributes } from 'react'
import { ActivityIndicator, Alert, AppState, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { WebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview'
import { canWake, configureWatch, healthAvailable, healthSummary, requestHealth, watchStatus, wake, type WakeTarget } from './modules/jarvis-wake'
import { parsePairing, sameOrigin, type Pairing } from './src/pairing'
import { asWakeTarget, forget, loadHealthSharing, loadPairing, loadWake, savePairing, saveHealthSharing, saveWake } from './src/storage'

/**
 * James auf dem iPhone.
 *
 * Der Rechner bleibt der Agent; das Telefon ist Mikrofon, Lautsprecher und
 * Anzeige. Die Bedienung selbst ist die Fernbedienungsseite, die James unter
 * `resources/companion/` ausliefert — dieselbe wie in Safari. Die App bringt
 * nur, was eine Webseite nicht darf: das Zauberpaket zum Aufwecken, und einen
 * Bildschirm für den Fall, dass der Rechner schläft und die Seite deshalb gar
 * nicht lädt.
 */

// Die mitgelieferten Typen setzen den Klassen-Parameter auf `undefined`, und
// `Props & undefined` ergibt `never`. Hier mit leerem Zusatz festgelegt.
type WebViewHandle = WebView<object>
const JamesWebView = WebView as unknown as ComponentType<WebViewProps & RefAttributes<WebViewHandle>>

type Phase =
  | { kind: 'loading' }
  | { kind: 'pair' }
  | { kind: 'remote'; pairing: Pairing }
  | { kind: 'offline'; pairing: Pairing; reason: string }

// Stellt `window.jarvisNative` bereit, bevor `app.js` danach sucht.
const BRIDGE = `(function () {
  var pending = {}, next = 1;
  function post(m) { window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
  window.jarvisNative = {
    wake: function (target) {
      return new Promise(function (resolve, reject) {
        var id = next++;
        pending[id] = { resolve: resolve, reject: reject };
        post({ type: 'wake', id: id, target: target });
      });
    },
    remember: function (target) { post({ type: 'remember', target: target }); }
  };
  window.__jarvisSettle = function (id, error) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    if (error) p.reject(error); else p.resolve();
  };
})(); true;`

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  useEffect(() => {
    loadPairing()
      .then(pairing => {
        void configureWatch(pairing?.secure ? pairing.url : null).catch(() => undefined)
        setPhase(pairing ? { kind: 'remote', pairing } : { kind: 'pair' })
      })
      .catch(() => setPhase({ kind: 'pair' }))
  }, [])

  const paired = useCallback(async (pairing: Pairing) => {
    await savePairing(pairing)
    await configureWatch(pairing.secure ? pairing.url : null).catch(() => undefined)
    setPhase({ kind: 'remote', pairing })
  }, [])

  const unpair = useCallback(() => {
    Alert.alert('Kopplung lösen?', 'Danach muss der QR-Code am Rechner neu gescannt werden.', [
      { text: 'Abbrechen', style: 'cancel' },
      { text: 'Lösen', style: 'destructive', onPress: () => void configureWatch(null).then(() => forget()).then(() => setPhase({ kind: 'pair' })) }
    ])
  }, [])

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {phase.kind === 'loading' && <Centered><ActivityIndicator color={COLORS.accent} /></Centered>}
      {phase.kind === 'pair' && <PairScreen onPaired={paired} />}
      {phase.kind === 'remote' && (
        <RemoteScreen
          pairing={phase.pairing}
          onUnpair={unpair}
          onOffline={reason => setPhase({ kind: 'offline', pairing: phase.pairing, reason })}
        />
      )}
      {phase.kind === 'offline' && (
        <OfflineScreen
          reason={phase.reason}
          onRetry={() => setPhase({ kind: 'remote', pairing: phase.pairing })}
          onUnpair={unpair}
        />
      )}
    </SafeAreaProvider>
  )
}

// ─────────────────────────────────────────────────────────────
// Koppeln
// ─────────────────────────────────────────────────────────────

function PairScreen({ onPaired }: { onPaired: (pairing: Pairing) => Promise<void> }) {
  const [permission, requestPermission] = useCameraPermissions()
  const [scanning, setScanning] = useState(false)
  const [link, setLink] = useState('')
  const [error, setError] = useState<string | null>(null)
  const handled = useRef(false)
  const accepting = useRef(false)

  const accept = async (text: string) => {
    if (accepting.current) return false
    const result = parsePairing(text)
    if (!result.ok) {
      setError(result.error)
      return false
    }
    accepting.current = true
    try { await onPaired(result.pairing); return true }
    catch (err) { setError(err instanceof Error ? err.message : 'Kopplung konnte nicht gespeichert werden.'); setScanning(false); return false }
    finally { accepting.current = false }
  }

  if (scanning) {
    return (
      <View style={styles.fill}>
        <CameraView
          style={styles.fill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current) return
            handled.current = true
            void accept(data).then(ok => { if (!ok) { setScanning(false); handled.current = false } })
          }}
        />
        <SafeAreaView style={styles.scanOverlay} edges={['bottom']}>
          <Button label="Abbrechen" onPress={() => setScanning(false)} subtle />
        </SafeAreaView>
      </View>
    )
  }

  const startScan = async () => {
    setError(null)
    try {
      const granted = permission?.granted || (await requestPermission()).granted
      if (granted) setScanning(true)
      else setError('Ohne Kamera bitte den Link unten einfügen.')
    } catch { setError('Kamera konnte nicht geöffnet werden. Bitte den Kopplungslink einfügen.') }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>James. Auch an deinem Handgelenk.</Text>
      <Text style={styles.body}>
        Am Rechner Einstellungen → Telefon öffnen und den Kopplungs-QR-Code scannen. Rechner und
        iPhone müssen im selben WLAN oder im selben Tailnet sein.
      </Text>
      <Text style={styles.body}>Apple Watch: Die gebaute App überträgt die Kopplung automatisch. Anmeldedaten bleiben auf dem iPhone.</Text>
      <Button label="QR-Code scannen" onPress={startScan} />
      <Text style={styles.label}>Oder Link einfügen</Text>
      <TextInput
        style={styles.input}
        value={link}
        onChangeText={setLink}
        placeholder="https://…#host=…&token=…"
        placeholderTextColor={COLORS.dim}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onSubmitEditing={() => { void accept(link) }}
      />
      <Button label="Verbinden" onPress={() => { void accept(link) }} subtle />
      {error && <Text style={styles.error}>{error}</Text>}
    </SafeAreaView>
  )
}

// ─────────────────────────────────────────────────────────────
// Fernbedienung
// ─────────────────────────────────────────────────────────────

function RemoteScreen({ pairing, onOffline, onUnpair }: { pairing: Pairing; onOffline: (reason: string) => void; onUnpair: () => void }) {
  const web = useRef<WebViewHandle>(null)
  const [watch, setWatch] = useState<ReturnType<typeof watchStatus>>({ supported: false })
  useEffect(() => {
    const refresh = () => setWatch(watchStatus())
    refresh()
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') refresh() })
    return () => subscription.remove()
  }, [])

  // Apple Health: aus, bis der Nutzer es einschaltet. Danach gehen die
  // Tageswerte bei jedem Öffnen der App an den Rechner.
  const [health, setHealth] = useState<'off' | 'on' | 'unavailable'>(() => (healthAvailable() ? 'off' : 'unavailable'))
  const [healthBusy, setHealthBusy] = useState(false)
  const [healthError, setHealthError] = useState('')
  const healthRequest = useRef(false)
  useEffect(() => {
    void loadHealthSharing().then(on => { if (on && healthAvailable()) setHealth('on') }).catch(() => undefined)
  }, [])

  const pushHealth = useCallback(async () => {
    try {
      const data = await healthSummary()
      if (!data) throw new Error('Apple Health ist hier nicht verfügbar.')
      web.current?.injectJavaScript(`window.__jarvisHealth && window.__jarvisHealth(${JSON.stringify(data)}); true;`)
      setHealthError('')
    } catch {
      setHealthError('Health-Werte konnten nicht geladen werden. Beim nächsten Öffnen versuchen wir es erneut.')
    }
  }, [])

  useEffect(() => {
    if (health !== 'on') return
    void Promise.resolve().then(pushHealth)
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void pushHealth() })
    return () => subscription.remove()
  }, [health, pushHealth])

  const toggleHealth = async () => {
    if (healthRequest.current) return
    if (health === 'on') {
      Alert.alert('Apple Health nicht mehr teilen?', 'Der Rechner behält den letzten Stand, bis du ihn dort löschst.', [
        { text: 'Abbrechen', style: 'cancel' },
        { text: 'Nicht mehr teilen', style: 'destructive', onPress: () => { void saveHealthSharing(false).then(() => { setHealth('off'); setHealthError('') }).catch(() => Alert.alert('Apple Health', 'Die Änderung konnte nicht gespeichert werden. Bitte erneut versuchen.')) } }
      ])
      return
    }
    healthRequest.current = true
    setHealthBusy(true)
    try {
      if (!(await requestHealth())) throw new Error('Apple Health ist auf diesem Gerät nicht verfügbar.')
      await saveHealthSharing(true)
      setHealth('on')
    } catch (err) {
      Alert.alert('Apple Health', err instanceof Error ? err.message : 'Der Zugriff ging nicht.')
    } finally {
      healthRequest.current = false
      setHealthBusy(false)
    }
  }

  const settle = (id: number, error: string | null) => {
    web.current?.injectJavaScript(`window.__jarvisSettle(${id}, ${JSON.stringify(error)}); true;`)
  }

  const onMessage = async (event: WebViewMessageEvent) => {
    // Nur die Seite des gekoppelten Rechners darf die Brücke benutzen.
    if (!sameOrigin(pairing, event.nativeEvent.url)) return
    let message: { type?: unknown; id?: unknown; target?: unknown }
    try {
      message = JSON.parse(event.nativeEvent.data)
    } catch {
      return
    }
    const target = asWakeTarget(message.target)
    if (message.type === 'remember' && target) {
      await saveWake(target).catch(() => undefined)
    } else if (message.type === 'wake' && typeof message.id === 'number' && Number.isInteger(message.id)) {
      if (!target) return settle(message.id, 'Weckziel ungültig.')
      try {
        await wake(target)
        settle(message.id, null)
      } catch (err) {
        settle(message.id, err instanceof Error ? err.message : String(err))
      }
    }
  }

  return (
    <View style={styles.web}>
      {watch.paired && !watch.installed && <Text style={styles.body}>Watch gekoppelt · James-Watch-App über die Watch-App installieren.</Text>}
      <Pressable accessibilityRole="button" onPress={onUnpair}><Text style={styles.body}>Rechner wechseln · neuen QR-Code scannen</Text></Pressable>
      {health !== 'unavailable' && (
        <Pressable disabled={healthBusy} accessibilityRole="switch" accessibilityState={{ checked: health === 'on', disabled: healthBusy, busy: healthBusy }} onPress={() => { void toggleHealth() }}>
          <Text style={styles.body}>{healthBusy ? 'Apple Health wird eingerichtet …' : health === 'on' ? 'Apple Health: Teilen eingeschaltet' : 'Apple Health verbinden · antippen'}</Text>
        </Pressable>
      )}
      {health === 'on' && <Text style={styles.body}>Freigegebene Werte werden beim Öffnen übertragen. Leserechte verwaltest du in Apple Health.</Text>}
      {healthError && <Text accessibilityRole="alert" style={styles.error}>{healthError}</Text>}
      <JamesWebView
        ref={web}
        source={{ uri: pairing.url }}
        style={styles.web}
        originWhitelist={[pairing.origin]}
        onShouldStartLoadWithRequest={request => {
          if (sameOrigin(pairing, request.url) || request.url === 'about:blank') return true
          // Fremde Links gehören in Safari, nicht in die Fernbedienung.
          if (/^https?:/i.test(request.url)) void Linking.openURL(request.url)
          return false
        }}
        injectedJavaScriptBeforeContentLoaded={BRIDGE}
        onMessage={onMessage}
        onLoadEnd={() => { if (health === 'on') void pushHealth() }}
        onError={({ nativeEvent }) => onOffline(describe(nativeEvent.code, nativeEvent.description))}
        onHttpError={({ nativeEvent }) => onOffline(`Der Rechner antwortet mit Fehler ${nativeEvent.statusCode}.`)}
        onContentProcessDidTerminate={() => web.current?.reload()}
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        keyboardDisplayRequiresUserAction={false}
        allowsBackForwardNavigationGestures={false}
        bounces={false}
        contentInsetAdjustmentBehavior="never"
        sharedCookiesEnabled={false}
      />
    </View>
  )
}

function describe(code: number, description: string): string {
  // NSURLErrorDomain: -1200…-1206 sind Zertifikatsfehler.
  if (code <= -1200 && code >= -1206) {
    return 'Das iPhone traut dem Zertifikat des Rechners nicht. Am Rechner unter Einstellungen → ' +
      'Telefon den ersten QR-Code mit der Kamera-App scannen, das Profil installieren und unter ' +
      'Allgemein → Info → Zertifikatsvertrauenseinstellungen einschalten.'
  }
  if (code === -1004 || code === -1001 || code === -1003 || code === -1009) {
    return 'Der Rechner ist nicht erreichbar. Vielleicht schläft er, oder James läuft nicht.'
  }
  return description || 'Die Verbindung zum Rechner ist fehlgeschlagen.'
}

// ─────────────────────────────────────────────────────────────
// Rechner nicht erreichbar
// ─────────────────────────────────────────────────────────────

function OfflineScreen({ reason, onRetry, onUnpair }: { reason: string; onRetry: () => void; onUnpair: () => void }) {
  const [target, setTarget] = useState<WakeTarget | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadWake().then(setTarget).catch(() => setTarget(null))
  }, [])

  // Zurück in die App: gleich noch einmal probieren, statt auf einen Knopf zu warten.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => { if (state === 'active') onRetry() })
    return () => sub.remove()
  }, [onRetry])

  const wakeUp = async () => {
    if (!target) return
    setBusy(true)
    setNote('Zauberpaket unterwegs…')
    try {
      await wake(target)
      setNote('Geweckt. Er braucht einen Moment — ich versuche es gleich wieder.')
      setTimeout(onRetry, 8000)
    } catch (err) {
      setNote(`Das Wecken hat nicht geklappt: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>Rechner nicht erreichbar</Text>
      <Text style={styles.body}>{reason}</Text>
      {target && canWake && <Button label={busy ? 'Weckt…' : 'Rechner aufwecken'} onPress={wakeUp} disabled={busy} />}
      {!target && (
        <Text style={styles.hint}>
          Aufwecken geht, sobald die Verbindung einmal gestanden hat — dann kennt die App die Netzwerkkarte.
        </Text>
      )}
      {target && !canWake && <Text style={styles.hint}>Aufwecken geht nur in der installierten App, nicht in Expo Go.</Text>}
      <Button label="Erneut verbinden" onPress={onRetry} subtle />
      {note && <Text style={styles.body}>{note}</Text>}
      <View style={styles.spacer} />
      <Button label="Kopplung lösen" onPress={onUnpair} subtle />
    </SafeAreaView>
  )
}

// ─────────────────────────────────────────────────────────────
// Bausteine
// ─────────────────────────────────────────────────────────────

function Centered({ children }: { children: ReactNode }) {
  return <View style={[styles.fill, styles.center]}>{children}</View>
}

function Button({ label, onPress, subtle, disabled }: { label: string; onPress: () => void; subtle?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, subtle && styles.buttonSubtle, (pressed || disabled) && styles.pressed]}
    >
      <Text style={[styles.buttonText, subtle && styles.buttonTextSubtle]}>{label}</Text>
    </Pressable>
  )
}

const COLORS = {
  bg: '#05080c',
  text: '#e8f1f5',
  dim: '#7f93a0',
  accent: '#3fd6d0',
  error: '#ff8a7a',
  field: '#101820'
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: COLORS.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  web: { flex: 1, backgroundColor: COLORS.bg },
  screen: { flex: 1, backgroundColor: COLORS.bg, paddingHorizontal: 24, paddingTop: 32, gap: 16 },
  title: { color: COLORS.text, fontSize: 28, fontWeight: '700' },
  body: { color: COLORS.text, fontSize: 16, lineHeight: 23 },
  hint: { color: COLORS.dim, fontSize: 14, lineHeight: 20 },
  label: { color: COLORS.dim, fontSize: 13, marginTop: 12, textTransform: 'uppercase', letterSpacing: 0.8 },
  input: { backgroundColor: COLORS.field, color: COLORS.text, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  error: { color: COLORS.error, fontSize: 15, lineHeight: 21 },
  spacer: { flex: 1 },
  scanOverlay: { position: 'absolute', left: 24, right: 24, bottom: 24 },
  button: { backgroundColor: COLORS.accent, borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  buttonSubtle: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#24343f' },
  buttonText: { color: '#03211f', fontSize: 17, fontWeight: '600' },
  buttonTextSubtle: { color: COLORS.text },
  pressed: { opacity: 0.6 }
})
