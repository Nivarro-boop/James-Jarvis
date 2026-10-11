<#
    Zertifikate für die Fernbedienung — eine eigene kleine Zertifizierungsstelle.

    Warum überhaupt: iOS gibt das Mikrofon nur in einem sicheren Kontext frei,
    und `http://192.168.1.20:8788` ist keiner. Es braucht also TLS, und für eine
    Adresse im Heimnetz stellt kein öffentlicher Aussteller ein Zertifikat aus.

    Warum eine Stelle und nicht ein einzelnes selbst unterschriebenes Papier:
    Beides muss auf dem Telefon einmal von Hand als vertrauenswürdig eingetragen
    werden. Bei einem einzelnen Zertifikat wäre das jedes Jahr wieder fällig —
    iOS nimmt keine langlebigen Serverzertifikate. Die Stelle darf zehn Jahre
    gelten; erneuert wird darunter, und davon merkt das Telefon nichts.

    Warum PowerShell: `New-SelfSignedCertificate` gehört zu Windows. Node kann
    von sich aus keine Zertifikate ausstellen, und die Bibliothek dafür wären
    anderthalb Megabyte für einen Aufruf im Jahr.

    Ausgabe ist JSON auf stdout, wie beim Windows-Helfer. Pfade und Datumsangaben,
    sonst nichts — der geheime Teil verlässt diese Datei nur als PFX auf der
    Platte, dessen Kennwort der Hauptprozess über DPAPI verwahrt.
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$Address,

    [Parameter(Mandatory = $true)]
    [string]$Dir,

    [Parameter(Mandatory = $true)]
    [string]$Password
)

$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $Dir | Out-Null

$caPfx   = Join-Path $Dir 'ca.pfx'
$caCer   = Join-Path $Dir 'ca.cer'
$leafPfx = Join-Path $Dir 'server.pfx'

$secret = ConvertTo-SecureString -String $Password -Force -AsPlainText

# Was wir in den Zertifikatsspeicher legen, holen wir hinterher wieder heraus.
# Der Speicher ist hier nur Werkbank: `New-SelfSignedCertificate` kann nirgendwo
# anders hin, und ein Schlüssel, der dort liegen bleibt, ist einer, den niemand
# mehr aufräumt.
$scratch = @()

try {
    # ── Die Stelle: einmal in zehn Jahren ────────────────────
    if (Test-Path $caPfx) {
        $ca = Import-PfxCertificate -FilePath $caPfx -Password $secret `
            -CertStoreLocation Cert:\CurrentUser\My -Exportable
        $scratch += $ca
    }

    # Auch eine Stelle läuft irgendwann ab. Ein Jahr Vorlauf, damit der Wechsel
    # nicht mit dem Ablauf zusammenfällt — das Telefon braucht dann ein neues
    # Profil, und das soll niemanden unterwegs erwischen.
    $caStale = $null -eq $ca -or $ca.NotAfter -lt (Get-Date).AddYears(1)

    if ($caStale) {
        $ca = New-SelfSignedCertificate `
            -Subject 'CN=Void James, O=Void James' `
            -Type Custom `
            -KeyUsage CertSign, CRLSign, DigitalSignature `
            -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
            -KeyExportPolicy Exportable `
            -NotAfter (Get-Date).AddYears(10) `
            -CertStoreLocation Cert:\CurrentUser\My `
            -TextExtension @('2.5.29.19={critical}{text}CA=true&pathlength=0')
        $scratch += $ca

        Export-PfxCertificate -Cert $ca -FilePath $caPfx -Password $secret | Out-Null
        # DER, nicht PEM: Das ist es, was iOS als Profil annimmt.
        Export-Certificate -Cert $ca -FilePath $caCer -Type CERT | Out-Null
    }

    # ── Das Serverzertifikat: gut ein Jahr ───────────────────
    #
    # 397 Tage, weil Apple ab 398 die Annahme verweigert. Erneuert wird zwei
    # Wochen vorher vom Hauptprozess aus; unterschrieben von derselben Stelle,
    # also ohne dass am Telefon etwas zu tun wäre.
    $leaf = New-SelfSignedCertificate `
        -Subject "CN=$Address" `
        -Signer $ca `
        -Type Custom `
        -KeyUsage DigitalSignature, KeyEncipherment `
        -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable `
        -NotAfter (Get-Date).AddDays(397) `
        -CertStoreLocation Cert:\CurrentUser\My `
        -TextExtension @(
            # serverAuth. Ohne diesen Verwendungszweck lehnt iOS ab, auch wenn
            # die Stelle vertraut wird.
            '2.5.29.37={text}1.3.6.1.5.5.7.3.1',
            # Der Name, auf den es lautet — als IP-Eintrag, nicht als DNS-Name.
            # Ein Zertifikat ohne diesen Abschnitt gilt seit iOS 13 als ungültig,
            # egal was im Betreff steht.
            "2.5.29.17={text}IPAddress=$Address"
        )
    $scratch += $leaf

    Export-PfxCertificate -Cert $leaf -FilePath $leafPfx -Password $secret | Out-Null
    # Der öffentliche Teil noch einmal einzeln: Damit liest der Hauptprozess
    # Ablauf und Adresse nach, ohne dafür PowerShell zu starten. Node kann eine
    # PFX-Datei zwar an OpenSSL weiterreichen, aber nicht selbst hineinsehen.
    Export-Certificate -Cert $leaf -FilePath (Join-Path $Dir 'server.cer') -Type CERT | Out-Null

    [pscustomobject]@{
        ok       = $true
        caFile   = $caCer
        pfxFile  = $leafPfx
        address  = $Address
        expires  = $leaf.NotAfter.ToString('o')
        caExpires = $ca.NotAfter.ToString('o')
    } | ConvertTo-Json -Compress
}
catch {
    [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
finally {
    # Aufräumen, auch nach einem Fehler. Was hier liegen bliebe, wäre ein
    # privater Schlüssel im Benutzerspeicher, den nie wieder jemand ansieht.
    foreach ($c in $scratch) {
        if ($null -ne $c) {
            Remove-Item -Path "Cert:\CurrentUser\My\$($c.Thumbprint)" -Force -ErrorAction SilentlyContinue
        }
    }
}
