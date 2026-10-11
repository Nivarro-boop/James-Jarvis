<#
    Maus und Tastatur für Void James.

    Warum überhaupt: die übliche Lösung wäre nut.js. Die braucht aber native
    Bindings, und die lassen sich auf diesem Rechner nicht bauen — den
    Visual-Studio-Buildtools fehlt das ClangCL-Toolset. Ohne Rückfall wäre die
    gesamte Bildschirmsteuerung tot.

    Warum ein Dauerläufer und kein Aufruf pro Aktion: das Add-Type unten
    ruft den C#-Compiler. Das dauert beim ersten Mal rund eine Sekunde. Bei
    einem Prozess pro Klick käme ein Vision-Durchlauf mit fünfundzwanzig
    Schritten allein dadurch auf eine halbe Minute Wartezeit. Also läuft
    dieser Prozess durch und nimmt Befehle als JSON-Zeilen auf stdin
    entgegen; jede Antwort ist wieder eine JSON-Zeile auf stdout.

    Tastatur läuft über SendKeys statt über SendInput: das erledigt die
    Umsetzung auf das aktuelle Tastaturlayout selbst, und für einen deutschen
    Nutzer ist genau das der Unterschied zwischen "ä" und Müll.
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class JarvisInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, IntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

    // Fenstersteuerung. Sie lag bis vor Kurzem in einem eigenen Skript, das
    // pro Aufruf einen PowerShell-Prozess kostete — gemessen rund 750 ms für
    // ein „mach das Fenster zu". Hier kostet dasselbe einen Zeilenumbruch.
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);

    // Fensterwechsel per SetForegroundWindow schlägt fehl, wenn der eigene
    // Prozess nicht im Vordergrund ist — Windows lässt nur den Vordergrund
    // den Vordergrund vergeben. Der übliche Weg daran vorbei ist, sich kurz
    // an den Eingabestrang des aktuellen Vordergrundfensters zu hängen.
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
}
'@

# Ohne das rechnet Windows unsere Koordinaten auf einem skalierten Bildschirm
# still um, und jeder Klick landet im oberen linken Viertel.
[void][JarvisInput]::SetProcessDPIAware()

$wsh = New-Object -ComObject WScript.Shell

$MOUSE_MOVE = 0x0001
$LEFT_DOWN = 0x0002
$LEFT_UP = 0x0004
$RIGHT_DOWN = 0x0008
$RIGHT_UP = 0x0010
$MIDDLE_DOWN = 0x0020
$MIDDLE_UP = 0x0040
$WHEEL = 0x0800
# Waagrechtes Rad. Ohne das kommt man in breiten Tabellen und Zeitleisten
# nicht nach rechts, ohne die Bildlaufleiste zu treffen.
$HWHEEL = 0x1000

$KEY_UP = 0x0002
$VK_LWIN = 0x5B

# Für gehaltene Modifikatoren beim Klicken — Strg-Klick, Umschalt-Klick.
# SendKeys kann das nicht: dort endet der Modifikator mit der Zeichenkette.
$VK_MOD = @{ 'ctrl' = 0x11; 'strg' = 0x11; 'control' = 0x11;
             'shift' = 0x10; 'umschalt' = 0x10;
             'alt' = 0x12; 'win' = 0x5B; 'windows' = 0x5B }

# SendKeys deutet diese Zeichen als Steuerzeichen. Wer sie tippen will, muss
# sie in geschweifte Klammern setzen.
$SPECIAL = '+', '^', '%', '~', '(', ')', '{', '}', '[', ']'

$KEYMAP = @{
    'enter' = '{ENTER}'; 'eingabe' = '{ENTER}'; 'return' = '{ENTER}'
    'tab' = '{TAB}'; 'tabulator' = '{TAB}'
    'esc' = '{ESC}'; 'escape' = '{ESC}'
    'entf' = '{DEL}'; 'delete' = '{DEL}'; 'del' = '{DEL}'
    'backspace' = '{BACKSPACE}'; 'rücktaste' = '{BACKSPACE}'
    'space' = ' '; 'leertaste' = ' '; 'leer' = ' '
    'hoch' = '{UP}'; 'up' = '{UP}'; 'oben' = '{UP}'
    'runter' = '{DOWN}'; 'down' = '{DOWN}'; 'unten' = '{DOWN}'
    'links' = '{LEFT}'; 'left' = '{LEFT}'
    'rechts' = '{RIGHT}'; 'right' = '{RIGHT}'
    'pos1' = '{HOME}'; 'home' = '{HOME}'
    'ende' = '{END}'; 'end' = '{END}'
    'bildhoch' = '{PGUP}'; 'pageup' = '{PGUP}'
    'bildrunter' = '{PGDN}'; 'pagedown' = '{PGDN}'
    'einfg' = '{INSERT}'; 'insert' = '{INSERT}'
    'druck' = '{PRTSC}'
}

function Escape-Text([string]$text) {
    $out = New-Object System.Text.StringBuilder
    foreach ($ch in $text.ToCharArray()) {
        if ($SPECIAL -contains [string]$ch) { [void]$out.Append('{').Append($ch).Append('}') }
        else { [void]$out.Append($ch) }
    }
    return $out.ToString()
}

function Convert-Key([string]$part) {
    $key = $part.ToLower()
    if ($KEYMAP.ContainsKey($key)) { return $KEYMAP[$key] }
    if ($key -match '^f([1-9]|1[0-9]|2[0-4])$') { return '{' + $key.ToUpper() + '}' }
    if ($key.Length -eq 1) { return (Escape-Text $key) }
    throw "Unbekannte Taste: $part"
}

function Send-Combo([string]$combo) {
    $parts = @($combo.ToLower() -split '[+\s]+' | Where-Object { $_ })
    if ($parts.Count -eq 0) { throw 'Leere Tastenkombination' }

    $prefix = ''
    $needsWin = $false
    $keys = @()

    foreach ($part in $parts) {
        switch ($part) {
            { $_ -in 'strg', 'ctrl', 'control', 'steuerung' } { $prefix += '^'; continue }
            { $_ -in 'alt', 'altgr' } { $prefix += '%'; continue }
            { $_ -in 'shift', 'umschalt' } { $prefix += '+'; continue }
            { $_ -in 'win', 'windows' } { $needsWin = $true; continue }
            default { $keys += (Convert-Key $part) }
        }
    }

    if ($keys.Count -eq 0) {
        # Nur Modifikatoren, etwa "win" allein.
        if ($needsWin) {
            [JarvisInput]::keybd_event([byte]$VK_LWIN, 0, 0, [IntPtr]::Zero)
            [JarvisInput]::keybd_event([byte]$VK_LWIN, 0, $KEY_UP, [IntPtr]::Zero)
            return
        }
        throw 'Kombination ohne Taste'
    }

    $body = if ($keys.Count -eq 1) { $keys[0] } else { '(' + ($keys -join '') + ')' }

    # Die Windows-Taste kennt SendKeys nicht — die halten wir selbst gedrückt,
    # während der Rest der Kombination durchgeht.
    if ($needsWin) { [JarvisInput]::keybd_event([byte]$VK_LWIN, 0, 0, [IntPtr]::Zero) }
    try { $wsh.SendKeys($prefix + $body) }
    finally {
        if ($needsWin) { [JarvisInput]::keybd_event([byte]$VK_LWIN, 0, $KEY_UP, [IntPtr]::Zero) }
    }
}

function Get-ButtonFlags([string]$button) {
    switch ($button) {
        'right' { return @($RIGHT_DOWN, $RIGHT_UP) }
        'middle' { return @($MIDDLE_DOWN, $MIDDLE_UP) }
        default { return @($LEFT_DOWN, $LEFT_UP) }
    }
}

<#
    Klickt ein- bis dreimal, wahlweise mit gehaltenen Modifikatoren.

    Der Zwischenabstand liegt unter der Doppelklickzeit von Windows (Standard
    500 ms), sonst wertet die Oberfläche zwei Einzelklicks statt eines
    Doppelklicks. Drei Klicks markieren in den meisten Textfeldern die Zeile —
    der zuverlässigste Weg, ein Feld vor dem Neubeschriften zu leeren.
#>
function Invoke-Click([string]$button, [int]$count, $modifiers) {
    $flags = Get-ButtonFlags $button
    $down = $flags[0]; $up = $flags[1]
    if ($count -lt 1) { $count = 1 }

    $held = @()
    foreach ($mod in @($modifiers)) {
        if (-not $mod) { continue }
        $vk = $VK_MOD[[string]$mod.ToString().ToLower()]
        if ($null -eq $vk) { throw "Unbekannter Modifikator: $mod" }
        $held += $vk
    }

    foreach ($vk in $held) { [JarvisInput]::keybd_event([byte]$vk, 0, 0, [IntPtr]::Zero) }
    try {
        for ($i = 0; $i -lt $count; $i++) {
            if ($i -gt 0) { Start-Sleep -Milliseconds 60 }
            [JarvisInput]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero)
            [JarvisInput]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero)
        }
    }
    finally {
        # Rückwärts loslassen und immer im finally: bliebe Strg hängen, wäre
        # der ganze Rechner unbedienbar, auch für den Nutzer selbst.
        [array]::Reverse($held)
        foreach ($vk in $held) { [JarvisInput]::keybd_event([byte]$vk, 0, $KEY_UP, [IntPtr]::Zero) }
    }
}

# ─────────────────────────────────────────────────────────────
# Fenster
# ─────────────────────────────────────────────────────────────

<#
    Das passende Fenster zu einem gesprochenen Namen.

    Nicht einfach das erste, das den Suchbegriff irgendwo im Titel trägt.
    Gesagt wird „schließ Claude", und im Titel steht bei jedem zweiten
    Browserfenster irgendwo „Claude" — der Treffer wäre dann ein Tab, nicht
    das Programm. Deshalb wird bewertet: der Programmname wiegt schwerer als
    der Fenstertitel, ein Anfang schwerer als ein Fund in der Mitte, und bei
    gleichem Rang gewinnt das zuletzt benutzte Fenster.
#>
function Find-Window([string]$match) {
    $needle = $match.Trim().ToLower()
    if (-not $needle) { return $null }

    $best = $null
    $bestScore = 0

    foreach ($p in Get-Process) {
        if ($p.MainWindowHandle -eq 0) { continue }
        $title = [string]$p.MainWindowTitle
        if (-not $title) { continue }

        $name = $p.ProcessName.ToLower()
        $lower = $title.ToLower()
        $score = 0

        if ($name -eq $needle) { $score = 100 }
        elseif ($name.StartsWith($needle)) { $score = 90 }
        elseif ($name.Contains($needle)) { $score = 80 }
        elseif ($lower.StartsWith($needle)) { $score = 60 }
        elseif ($lower.Contains($needle)) { $score = 50 }
        else { continue }

        # Das eigene Fenster ist fast nie gemeint. „Mach James zu" wäre der
        # einzige Fall, und dafür gibt es den Kristall.
        if ($name -eq 'void jarvis' -or $name -eq 'void james' -or $name -eq 'electron') { $score -= 40 }

        if ($score -gt $bestScore) { $bestScore = $score; $best = $p }
    }

    return $best
}

function Get-WindowBounds([IntPtr]$h) {
    $rect = New-Object JarvisInput+RECT
    if (-not [JarvisInput]::GetWindowRect($h, [ref]$rect)) { return $null }
    return @{
        x      = $rect.Left
        y      = $rect.Top
        width  = $rect.Right - $rect.Left
        height = $rect.Bottom - $rect.Top
    }
}

<#
    Ein Fenster wirklich nach vorn holen.

    `SetForegroundWindow` allein reicht unter Windows nicht: Wer nicht selbst
    im Vordergrund steht, darf ihn auch nicht vergeben — der Aufruf gibt dann
    zwar `true` zurück, aber das Fenster blinkt nur in der Taskleiste. Für
    einen Sprachassistenten ist das der Normalfall, denn im Vordergrund steht
    immer das, womit der Nutzer gerade arbeitet.
#>
function Set-Foreground([IntPtr]$h) {
    if ([JarvisInput]::IsIconic($h)) { [void][JarvisInput]::ShowWindow($h, 9) }

    $foreground = [JarvisInput]::GetForegroundWindow()
    $theirs = [JarvisInput]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
    $ours = [JarvisInput]::GetCurrentThreadId()

    $attached = $false
    if ($theirs -ne 0 -and $theirs -ne $ours) {
        $attached = [JarvisInput]::AttachThreadInput($ours, $theirs, $true)
    }
    try { [void][JarvisInput]::SetForegroundWindow($h) }
    finally { if ($attached) { [void][JarvisInput]::AttachThreadInput($ours, $theirs, $false) } }
}

function Invoke-Op($cmd) {
    switch ($cmd.op) {
        'ping' { return @{ backend = 'powershell' } }

        # Alle sichtbaren Fenster. Ersetzt den Einzelaufruf von
        # windows-helper.ps1 und kostet statt 720 ms rund zehn.
        'windows' {
            $list = @()
            foreach ($p in Get-Process) {
                if ($p.MainWindowHandle -eq 0 -or -not $p.MainWindowTitle) { continue }
                $list += @{
                    pid    = $p.Id
                    name   = $p.ProcessName
                    title  = [string]$p.MainWindowTitle
                    handle = [int64]$p.MainWindowHandle
                }
            }
            return @{ windows = @($list) }
        }

        'focus' {
            $target = Find-Window ([string]$cmd.match)
            if ($null -eq $target) { return @{ ok = $false; error = "Kein Fenster passt auf '$($cmd.match)'" } }
            $h = $target.MainWindowHandle
            Set-Foreground $h
            return @{ ok = $true; title = [string]$target.MainWindowTitle; pid = $target.Id; bounds = (Get-WindowBounds $h) }
        }

        # Schließen heißt freundlich bitten, nicht abschießen: Ungesicherte
        # Arbeit soll das Programm selbst abfragen dürfen.
        'close' {
            $target = Find-Window ([string]$cmd.match)
            if ($null -eq $target) { return @{ ok = $false; error = "Kein Fenster passt auf '$($cmd.match)'" } }
            $title = [string]$target.MainWindowTitle
            [void]$target.CloseMainWindow()
            return @{ ok = $true; title = $title }
        }

        <#
            Fenster setzen — und zwar dorthin, wo der Aufrufer es haben will.

            Der Rechteck kommt fertig von der anderen Seite, in echten
            Bildpunkten. Das ist Absicht: Welche Bildschirme es gibt, wo sie
            liegen und wie sie skaliert sind, weiß Electron genau, und bei
            zwei unterschiedlich skalierten Monitoren rechnet es das auch
            richtig um. Hier nachzurechnen hieße, dieselbe Arbeit ein zweites
            Mal und schlechter zu machen.
        #>
        'arrange' {
            $target = Find-Window ([string]$cmd.match)
            if ($null -eq $target) { return @{ ok = $false; error = "Kein Fenster passt auf '$($cmd.match)'" } }

            $h = $target.MainWindowHandle
            $how = [string]$cmd.how
            $title = [string]$target.MainWindowTitle

            if ($how -eq 'minimize') {
                [void][JarvisInput]::ShowWindow($h, 6)
                return @{ ok = $true; title = $title }
            }

            # Aus dem Maximierten heraus lässt sich nicht verschieben: Windows
            # nimmt die neue Lage an und stellt sie sofort wieder her.
            if ([JarvisInput]::IsIconic($h) -or [JarvisInput]::IsZoomed($h)) {
                [void][JarvisInput]::ShowWindow($h, 9)
                Start-Sleep -Milliseconds 40
            }

            if ($null -ne $cmd.w -and [int]$cmd.w -gt 0) {
                [void][JarvisInput]::MoveWindow($h, [int]$cmd.x, [int]$cmd.y, [int]$cmd.w, [int]$cmd.t, $true)
            }

            # Maximieren erst nach dem Verschieben: Windows maximiert immer auf
            # den Bildschirm, auf dem das Fenster gerade steht. Andersherum
            # landete „auf den rechten Schirm und groß" auf dem linken.
            if ($how -eq 'maximize') {
                Start-Sleep -Milliseconds 40
                [void][JarvisInput]::ShowWindow($h, 3)
            }

            Set-Foreground $h
            return @{ ok = $true; title = $title; bounds = (Get-WindowBounds $h) }
        }

        'metrics' {
            return @{
                width         = [JarvisInput]::GetSystemMetrics(0)
                height        = [JarvisInput]::GetSystemMetrics(1)
                virtualLeft   = [JarvisInput]::GetSystemMetrics(76)
                virtualTop    = [JarvisInput]::GetSystemMetrics(77)
                virtualWidth  = [JarvisInput]::GetSystemMetrics(78)
                virtualHeight = [JarvisInput]::GetSystemMetrics(79)
            }
        }

        'move' {
            [void][JarvisInput]::SetCursorPos([int]$cmd.x, [int]$cmd.y)
            return @{ moved = $true }
        }

        'click' {
            if ($null -ne $cmd.x) { [void][JarvisInput]::SetCursorPos([int]$cmd.x, [int]$cmd.y); Start-Sleep -Milliseconds 30 }
            $count = if ($null -ne $cmd.count) { [int]$cmd.count } elseif ([bool]$cmd.double) { 2 } else { 1 }
            Invoke-Click ([string]$cmd.button) $count $cmd.modifiers
            return @{ clicked = $count }
        }

        # Taste getrennt drücken und lösen — für Ziehen über weite Strecken,
        # Mehrfachauswahl und alles, wo zwischendurch etwas anderes passieren
        # muss, während die Taste unten bleibt.
        'mousedown' {
            if ($null -ne $cmd.x) { [void][JarvisInput]::SetCursorPos([int]$cmd.x, [int]$cmd.y); Start-Sleep -Milliseconds 30 }
            $flags = Get-ButtonFlags ([string]$cmd.button)
            [JarvisInput]::mouse_event($flags[0], 0, 0, 0, [IntPtr]::Zero)
            return @{ down = $true }
        }

        'mouseup' {
            if ($null -ne $cmd.x) { [void][JarvisInput]::SetCursorPos([int]$cmd.x, [int]$cmd.y); Start-Sleep -Milliseconds 30 }
            $flags = Get-ButtonFlags ([string]$cmd.button)
            [JarvisInput]::mouse_event($flags[1], 0, 0, 0, [IntPtr]::Zero)
            return @{ up = $true }
        }

        'drag' {
            [void][JarvisInput]::SetCursorPos([int]$cmd.x, [int]$cmd.y)
            Start-Sleep -Milliseconds 40
            [JarvisInput]::mouse_event($LEFT_DOWN, 0, 0, 0, [IntPtr]::Zero)
            # In Schritten ziehen: ein Sprung von A nach B wird von vielen
            # Oberflächen gar nicht als Ziehen erkannt.
            $steps = 12
            $fromX = [int]$cmd.x; $fromY = [int]$cmd.y
            $toX = [int]$cmd.x2; $toY = [int]$cmd.y2
            for ($i = 1; $i -le $steps; $i++) {
                $nx = $fromX + [int](($toX - $fromX) * $i / $steps)
                $ny = $fromY + [int](($toY - $fromY) * $i / $steps)
                [void][JarvisInput]::SetCursorPos($nx, $ny)
                Start-Sleep -Milliseconds 12
            }
            [JarvisInput]::mouse_event($LEFT_UP, 0, 0, 0, [IntPtr]::Zero)
            return @{ dragged = $true }
        }

        'scroll' {
            # Erst zeigen, dann drehen: das Rad geht immer an das Fenster
            # unter dem Zeiger. Ohne die Position scrollt man das, was gerade
            # zufällig darunter liegt — in einer geteilten Oberfläche die
            # falsche Hälfte.
            if ($null -ne $cmd.x) { [void][JarvisInput]::SetCursorPos([int]$cmd.x, [int]$cmd.y); Start-Sleep -Milliseconds 30 }

            $clicks = [int]$cmd.amount
            if ($clicks -eq 0) { $clicks = 3 }
            $direction = [string]$cmd.direction

            switch ($direction) {
                'up'    { [JarvisInput]::mouse_event($WHEEL,  0, 0,  120 * $clicks, [IntPtr]::Zero) }
                'down'  { [JarvisInput]::mouse_event($WHEEL,  0, 0, -120 * $clicks, [IntPtr]::Zero) }
                'right' { [JarvisInput]::mouse_event($HWHEEL, 0, 0,  120 * $clicks, [IntPtr]::Zero) }
                'left'  { [JarvisInput]::mouse_event($HWHEEL, 0, 0, -120 * $clicks, [IntPtr]::Zero) }
                default { throw "Unbekannte Scrollrichtung: $direction" }
            }
            return @{ scrolled = $clicks; direction = $direction }
        }

        'type' {
            $text = [string]$cmd.text
            if ($text.Length -eq 0) { return @{ typed = 0 } }
            # In Häppchen: SendKeys verschluckt bei sehr langen Zeichenketten
            # gelegentlich Zeichen, wenn das Zielfenster nicht hinterherkommt.
            $chunkSize = 60
            for ($i = 0; $i -lt $text.Length; $i += $chunkSize) {
                $len = [Math]::Min($chunkSize, $text.Length - $i)
                $wsh.SendKeys((Escape-Text $text.Substring($i, $len)))
                Start-Sleep -Milliseconds 25
            }
            return @{ typed = $text.Length }
        }

        'keys' {
            # Wiederholung im Server statt in einer Schleife auf der anderen
            # Seite: zehnmal Pfeil-runter wären sonst zehn Runden über stdin.
            $repeat = if ($null -ne $cmd.repeat) { [Math]::Max(1, [Math]::Min(60, [int]$cmd.repeat)) } else { 1 }
            for ($i = 0; $i -lt $repeat; $i++) {
                if ($i -gt 0) { Start-Sleep -Milliseconds 25 }
                Send-Combo ([string]$cmd.combo)
            }
            return @{ pressed = [string]$cmd.combo; repeat = $repeat }
        }

        'media' {
            $map = @{ 'play' = 0xB3; 'next' = 0xB0; 'previous' = 0xB1; 'stop' = 0xB2 }
            $vk = $map[[string]$cmd.action]
            if ($null -eq $vk) { throw "Unbekannte Medienaktion: $($cmd.action)" }
            [JarvisInput]::keybd_event([byte]$vk, 0, 0, [IntPtr]::Zero)
            [JarvisInput]::keybd_event([byte]$vk, 0, $KEY_UP, [IntPtr]::Zero)
            return @{ media = [string]$cmd.action }
        }

        'volume' {
            # 0xAF lauter, 0xAE leiser. Ein Schritt sind zwei Prozent.
            $steps = [Math]::Abs([int]$cmd.steps)
            $vk = if ([int]$cmd.steps -ge 0) { 0xAF } else { 0xAE }
            for ($i = 0; $i -lt $steps; $i++) {
                [JarvisInput]::keybd_event([byte]$vk, 0, 0, [IntPtr]::Zero)
                [JarvisInput]::keybd_event([byte]$vk, 0, $KEY_UP, [IntPtr]::Zero)
            }
            return @{ steps = $steps }
        }

        'cursor' {
            $p = New-Object JarvisInput+POINT
            [void][JarvisInput]::GetCursorPos([ref]$p)
            return @{ x = $p.X; y = $p.Y }
        }

        default { throw "Unbekannter Befehl: $($cmd.op)" }
    }
}

# Bereitmeldung, damit die Gegenseite weiß, dass Add-Type durch ist.
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $id = 0
    try {
        $cmd = $line | ConvertFrom-Json
        $id = [int]$cmd.id
        $data = Invoke-Op $cmd
        $reply = @{ id = $id; ok = $true; data = $data } | ConvertTo-Json -Compress -Depth 5
    }
    catch {
        $reply = @{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
    [Console]::Out.WriteLine($reply)
    [Console]::Out.Flush()
}
