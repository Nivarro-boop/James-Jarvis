<#
    Bedienelemente statt Bildpunkte.

    Windows fuehrt zu jedem Fenster einen Baum aus Rollen, Namen und
    Faehigkeiten - gedacht fuer Vorlese- und Hilfsprogramme, aber genau das,
    was ein Modell braucht, um ein Fenster zu bedienen. Drei Dinge kann er, die
    ein Bildschirmfoto nicht kann:

    Erstens braucht er keinen Vordergrund. Ein Klick per Nachricht verpufft bei
    einem Fenster, das nicht aktiv ist; ein Invoke ueber diesen Baum kommt an.
    Damit arbeitet James, ohne die Maus zu uebernehmen.

    Zweitens ist er genau. "Druecke Settings" trifft, "klicke bei 487, 203"
    raet - und raet spaetestens dann falsch, wenn das Fenster verschoben wurde.

    Drittens kostet er fast nichts. Ein Fensterbaum sind ein paar hundert
    Zeichen, ein Bildschirmfoto mit zwei Kacheln rund sechzehnhundert Token,
    und zwar bei jedem einzelnen Schritt.

    Ein Dauerlaeufer wie der Eingabeserver daneben, und zwar aus zwei Gruenden:
    Add-Type ruft den Compiler, und die Verweise auf die gefundenen Elemente
    muessen zwischen zwei Befehlen ueberleben - erst lesen, dann handeln.

    Bewusst ohne Sonderzeichen jenseits von ASCII: Diese Datei wird ohne
    Bytemarke gespeichert, und PowerShell liest sie dann als ANSI. Ein
    Geviertstrich im Quelltext zerfaellt dabei in Zeichen, die den Parser
    zerlegen - beobachtet, gekostet, hier vermieden.
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class JarvisUia {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@

# Ohne das meldet UIA auf einem skalierten Bildschirm Koordinaten, die nicht zu
# denen der Bildschirmaufnahme passen - und der Rueckfall auf Pixelklicks
# zielte daneben.
[void][JarvisUia]::SetProcessDPIAware()

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

<#
    Die Verweistabelle.

    Gelesen wird einmal, gehandelt wird danach: "ref_7" aus der Ausgabe von
    tree muss beim naechsten Befehl noch dasselbe Element meinen. Sie wird bei
    jedem tree neu aufgebaut - ein Verweis aus einem alten Baum zeigt sonst auf
    ein Element, das es nicht mehr gibt, und das faellt niemandem auf.
#>
$script:refs = @{}
$script:refSeq = 0

function Get-Fenster([string]$titel) {
    $kinder = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)

    if (-not $titel -or $titel -eq 'aktiv') {
        $vorn = [JarvisUia]::GetForegroundWindow()
        foreach ($k in $kinder) {
            if ([IntPtr]$k.Current.NativeWindowHandle -eq $vorn) { return $k }
        }
    }

    # Erst genau, dann ungefaehr: Wer "Ollama" sagt, meint eher das Fenster mit
    # genau diesem Namen als das, in dessen Titel das Wort vorkommt.
    foreach ($k in $kinder) { if ($k.Current.Name -eq $titel) { return $k } }
    foreach ($k in $kinder) { if ($k.Current.Name -like "*$titel*") { return $k } }
    return $null
}

function Get-Muster($element) {
    $namen = @()
    foreach ($p in $element.GetSupportedPatterns()) {
        $namen += ($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern', '')
    }
    return $namen
}

<#
    Was ein Element hergibt, in der Form, in der es dem Modell hilft.

    Die Muster sind dabei das Entscheidende und nicht die Rolle: Sie sagen,
    was mit dem Element ueberhaupt geht. Invoke heisst druecken, Value heisst
    beschreiben, Toggle heisst umschalten. Ein Modell, das die Muster sieht,
    muss nicht raten, ob ein Klick etwas bewirkt.
#>
function ConvertTo-Eintrag($element, [int]$ref) {
    $c = $element.Current
    $r = $c.BoundingRectangle
    $muster = Get-Muster $element

    $eintrag = @{
        ref = $ref
        rolle = ($c.ControlType.ProgrammaticName -replace 'ControlType\.', '')
        name = $c.Name
        kann = @($muster | Where-Object { $_ -match '^(Invoke|Toggle|Value|SelectionItem|ExpandCollapse|Scroll|RangeValue|Text)$' })
    }
    if ($c.AutomationId) { $eintrag.id = $c.AutomationId }
    if (-not [double]::IsInfinity($r.X)) {
        $eintrag.x = [int]($r.X + $r.Width / 2)
        $eintrag.y = [int]($r.Y + $r.Height / 2)
    }
    # Der aktuelle Inhalt eines Textfeldes - sonst weiss das Modell nicht, ob
    # es ergaenzen oder ersetzen muss.
    if ($muster -contains 'Value') {
        try {
            $v = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
            if ($v) { $eintrag.wert = [string]$v }
        } catch { }
    }
    if ($muster -contains 'Toggle') {
        try {
            $eintrag.zustand = [string]$element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState
        } catch { }
    }
    return $eintrag
}

function Read-Baum([string]$titel, [int]$grenze) {
    $fenster = Get-Fenster $titel
    if (-not $fenster) { throw "Kein Fenster gefunden, das auf '$titel' passt." }

    # Nur echte Bedienelemente, und nur sichtbare. Ohne diesen Filter kommen
    # bei einer Webansicht Tausende Textknoten mit, die niemand bedienen kann.
    $bed = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition($AE::IsControlElementProperty, $true)),
        (New-Object System.Windows.Automation.PropertyCondition($AE::IsOffscreenProperty, $false))
    )

    <#
        Zweimal lesen, wenn der erste Blick duenn ausfaellt.

        Anwendungen auf Chromium-Grundlage - und das sind heute die meisten,
        von Chrome ueber Electron bis zur Ollama-App - halten ihren Baum
        abgeschaltet, solange niemand ihn anfordert. Der erste Zugriff weckt
        ihn, der zweite liefert Inhalt. Beim Ollama-Fenster waren das zwei
        brauchbare Elemente gegen fuenfzehn.
    #>
    $treffer = $fenster.FindAll($TS::Descendants, $bed)
    if ($treffer.Count -lt 8) {
        Start-Sleep -Milliseconds 400
        $treffer = $fenster.FindAll($TS::Descendants, $bed)
    }

    $script:refs = @{}
    $script:refSeq = 0
    $liste = @()
    foreach ($e in $treffer) {
        if ($liste.Count -ge $grenze) { break }
        $c = $e.Current
        # Namenlos und ohne Kennung ist ein Element nicht ansprechbar, und dem
        # Modell zu sagen "da ist etwas, ich weiss nicht was" hilft ihm nicht.
        if (-not $c.Name -and -not $c.AutomationId) { continue }
        $script:refSeq++
        $script:refs[$script:refSeq] = $e
        $liste += (ConvertTo-Eintrag $e $script:refSeq)
    }

    return @{
        fenster = $fenster.Current.Name
        gefunden = $treffer.Count
        gezeigt = $liste.Count
        elemente = $liste
    }
}

function Get-Element([int]$ref) {
    if (-not $script:refs.ContainsKey($ref)) {
        throw "Verweis $ref ist unbekannt. Lies das Fenster erst mit read_window."
    }
    return $script:refs[$ref]
}

function Invoke-Op($cmd) {
    switch ($cmd.op) {
        'ping' { return @{ backend = 'uia' } }

        'windows' {
            $kinder = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
            $vorn = [JarvisUia]::GetForegroundWindow()
            $liste = @()
            foreach ($k in $kinder) {
                if (-not $k.Current.Name) { continue }
                $liste += @{
                    titel = $k.Current.Name
                    aktiv = ([IntPtr]$k.Current.NativeWindowHandle -eq $vorn)
                }
            }
            return @{ fenster = $liste }
        }

        'tree' {
            $grenze = if ($cmd.limit) { [int]$cmd.limit } else { 120 }
            return (Read-Baum ([string]$cmd.window) $grenze)
        }

        'invoke' {
            $e = Get-Element ([int]$cmd.ref)
            $muster = Get-Muster $e
            # Nicht jedes Element laesst sich druecken. Wo Invoke fehlt, ist
            # oft SelectionItem gemeint - Listeneintraege etwa werden gewaehlt,
            # nicht gedrueckt.
            if ($muster -contains 'Invoke') {
                $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                return @{ getan = 'invoke' }
            }
            if ($muster -contains 'SelectionItem') {
                $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
                return @{ getan = 'select' }
            }
            if ($muster -contains 'Toggle') {
                $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
                return @{ getan = 'toggle' }
            }
            throw "Dieses Element laesst sich nicht betaetigen. Es kann: $($muster -join ', ')"
        }

        'setValue' {
            $e = Get-Element ([int]$cmd.ref)
            $muster = Get-Muster $e
            if ($muster -notcontains 'Value') { throw 'Dieses Element nimmt keinen Text an.' }
            $p = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($p.Current.IsReadOnly) { throw 'Dieses Feld ist schreibgeschuetzt.' }
            $p.SetValue([string]$cmd.text)
            return @{ getan = 'setValue' }
        }

        'toggle' {
            $e = Get-Element ([int]$cmd.ref)
            $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
            return @{ getan = 'toggle' }
        }

        'expand' {
            $e = Get-Element ([int]$cmd.ref)
            $p = $e.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($cmd.close) { $p.Collapse() } else { $p.Expand() }
            return @{ getan = 'expand' }
        }

        'focus' {
            $e = Get-Element ([int]$cmd.ref)
            $e.SetFocus()
            return @{ getan = 'focus' }
        }

        default { throw "Unbekannter Befehl: $($cmd.op)" }
    }
}

# Bereitmeldung, damit die Gegenseite weiss, dass Add-Type durch ist.
Write-Output (ConvertTo-Json @{ ready = $true } -Compress)

while ($true) {
    $zeile = [Console]::In.ReadLine()
    if ($null -eq $zeile) { break }
    $zeile = $zeile.Trim()
    if (-not $zeile) { continue }

    $id = 0
    try {
        $cmd = $zeile | ConvertFrom-Json
        $id = if ($cmd.id) { [int]$cmd.id } else { 0 }
        $daten = Invoke-Op $cmd
        # Tiefe zehn: Die Elementliste ist verschachtelt, und die Vorgabe von
        # zwei schnitte sie zu einer Reihe von "System.Object[]" ab.
        Write-Output (ConvertTo-Json @{ id = $id; ok = $true; data = $daten } -Compress -Depth 10)
    } catch {
        Write-Output (ConvertTo-Json @{ id = $id; ok = $false; error = $_.Exception.Message } -Compress)
    }
}
