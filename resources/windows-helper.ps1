<#
    Windows-Helfer für Void James.

    Node kann unter Windows weder Verknüpfungen auflösen noch Fenster
    aufzählen oder in den Vordergrund holen. Beides geht über COM bzw.
    user32.dll, und dafür ist PowerShell der kürzeste Weg — eine native
    Node-Erweiterung dafür wäre deutlich mehr Wartungsaufwand.

    Ausgabe ist immer JSON auf stdout, damit die Auswertung in TypeScript
    nicht von Textformaten abhängt.
#>

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('resolve-shortcuts', 'list-windows', 'focus-window', 'set-volume', 'get-volume',
        'arrange-window', 'close-window', 'lock', 'system-status')]
    [string]$Action,

    [string]$Match = '',
    [string]$How = '',
    [int]$Value = 0
)

$ErrorActionPreference = 'Stop'

# Bewusst über -InputObject statt über die Pipeline.
#
# ConvertTo-Json sammelt Pipeline-Eingaben und packt sie nur dann in ein
# JSON-Array, wenn mehr als eine ankommt. Bei genau einem Element kommt ein
# einzelnes Objekt heraus, bei keinem gar nichts. Für 'list-windows' und
# 'resolve-shortcuts' ist das fatal: Die Gegenseite erwartet eine Liste und
# ruft .find() darauf auf. Stand genau ein Fenster mit Titel auf dem
# Bildschirm — im Vollbildspiel der Normalfall, wenn James' eigenes Fenster
# versteckt ist — bekam sie ein Objekt und warf "find is not a function".
# Betroffen waren open_app, list_windows, minecraft_launch und die
# Fensterprüfung der Bildschirmsteuerung, also gleich vier Werkzeuge.
#
# Über -InputObject geht die Sammlung als ein Wert hinein und behält ihre Form:
# leere Liste bleibt [], ein Element wird [ {...} ].
function Write-Json($obj) {
    ConvertTo-Json -InputObject $obj -Depth 6 -Compress
}

switch ($Action) {

    # Alle Verknüpfungen auf Desktop und im Startmenü mit ihren Zielen.
    'resolve-shortcuts' {
        $dirs = @(
            [Environment]::GetFolderPath('Desktop'),
            [Environment]::GetFolderPath('CommonDesktopDirectory'),
            (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
            (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
        ) | Where-Object { $_ -and (Test-Path $_) }

        $shell = New-Object -ComObject WScript.Shell
        $result = @()

        foreach ($dir in $dirs) {
            $links = Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue
            foreach ($link in $links) {
                try {
                    $sc = $shell.CreateShortcut($link.FullName)
                    if ($sc.TargetPath -and (Test-Path $sc.TargetPath)) {
                        $result += [pscustomobject]@{
                            name      = [IO.Path]::GetFileNameWithoutExtension($link.Name)
                            target    = $sc.TargetPath
                            arguments = $sc.Arguments
                            workDir   = $sc.WorkingDirectory
                        }
                    }
                }
                catch {
                    # Kaputte Verknüpfung — überspringen.
                }
            }
        }

        Write-Json @($result)
    }

    # Sichtbare Fenster mit Titel. Basis für "hol Chrome nach vorn".
    'list-windows' {
        $procs = Get-Process |
            Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
            ForEach-Object {
                [pscustomobject]@{
                    pid     = $_.Id
                    name    = $_.ProcessName
                    title   = $_.MainWindowTitle
                    handle  = [int64]$_.MainWindowHandle
                }
            }
        Write-Json @($procs)
    }

    'focus-window' {
        if (-not $Match) { Write-Json @{ ok = $false; error = 'Kein Suchbegriff' }; break }

        Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@

        # Ohne das meldet GetWindowRect auf einem skalierten Bildschirm
        # umgerechnete statt echter Bildpunkte, und der Aufrufer sucht den
        # zugehörigen Monitor an der falschen Stelle.
        [void][Win]::SetProcessDPIAware()

        $target = Get-Process |
            Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Match*" } |
            Select-Object -First 1

        if (-not $target) {
            Write-Json @{ ok = $false; error = "Kein Fenster passt auf '$Match'" }
            break
        }

        $h = $target.MainWindowHandle
        # Minimierte Fenster erst wiederherstellen, sonst bleibt der
        # Vordergrundwechsel wirkungslos.
        if ([Win]::IsIconic($h)) { [void][Win]::ShowWindow($h, 9) }
        [void][Win]::SetForegroundWindow($h)

        # Die Lage kommt mit zurück: bei zwei Monitoren muss die
        # Bildschirmsteuerung wissen, auf welchem das Fenster steht.
        $rect = New-Object Win+RECT
        $hasRect = [Win]::GetWindowRect($h, [ref]$rect)

        Write-Json @{
            ok     = $true
            title  = $target.MainWindowTitle
            pid    = $target.Id
            bounds = if ($hasRect) {
                @{ x = $rect.Left; y = $rect.Top
                   width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
            } else { $null }
        }
    }

    # Lautstärke über simulierte Medientasten. Der COM-Weg über den
    # Audio-Endpunkt ist zwar exakter, aber je nach Windows-Build instabil.
    'set-volume' {
        $wsh = New-Object -ComObject WScript.Shell
        $steps = [Math]::Abs($Value)
        $key = if ($Value -ge 0) { [char]175 } else { [char]174 }
        for ($i = 0; $i -lt $steps; $i++) { $wsh.SendKeys([string]$key) }
        Write-Json @{ ok = $true; steps = $steps }
    }

    'get-volume' {
        # Windows bietet dafür keine schlanke Skript-Schnittstelle.
        Write-Json @{ ok = $false; error = 'Lautstärke lässt sich nicht auslesen' }
    }

    # Fenster nach links, nach rechts, groß, klein oder zurück.
    'arrange-window' {
        if (-not $Match) { Write-Json @{ ok = $false; error = 'Kein Suchbegriff' }; break }

        Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WinArrange {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, ref RECT rect, uint winIni);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

        $target = Get-Process |
            Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Match*" } |
            Select-Object -First 1

        if (-not $target) {
            Write-Json @{ ok = $false; error = "Kein Fenster passt auf '$Match'" }
            break
        }

        $h = $target.MainWindowHandle

        # Arbeitsbereich statt Bildschirmgröße: sonst verschwindet die halbe
        # Fensterzeile hinter der Taskleiste.
        $work = New-Object WinArrange+RECT
        [void][WinArrange]::SystemParametersInfo(0x0030, 0, [ref]$work, 0)
        $w = $work.Right - $work.Left
        $t = $work.Bottom - $work.Top

        switch ($How) {
            'left' {
                [void][WinArrange]::ShowWindow($h, 9)
                [void][WinArrange]::MoveWindow($h, $work.Left, $work.Top, [int]($w / 2), $t, $true)
            }
            'right' {
                [void][WinArrange]::ShowWindow($h, 9)
                [void][WinArrange]::MoveWindow($h, $work.Left + [int]($w / 2), $work.Top, [int]($w / 2), $t, $true)
            }
            'maximize' { [void][WinArrange]::ShowWindow($h, 3) }
            'minimize' { [void][WinArrange]::ShowWindow($h, 6) }
            default { [void][WinArrange]::ShowWindow($h, 9) }
        }

        if ($How -ne 'minimize') { [void][WinArrange]::SetForegroundWindow($h) }
        Write-Json @{ ok = $true; title = $target.MainWindowTitle }
    }

    # Fenster schließen heißt hier: freundlich bitten. Kein Kill — ungesicherte
    # Arbeit in einem Editor wäre sonst weg.
    'close-window' {
        if (-not $Match) { Write-Json @{ ok = $false; error = 'Kein Suchbegriff' }; break }

        $target = Get-Process |
            Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Match*" } |
            Select-Object -First 1

        if (-not $target) {
            Write-Json @{ ok = $false; error = "Kein Fenster passt auf '$Match'" }
            break
        }

        $title = $target.MainWindowTitle
        [void]$target.CloseMainWindow()
        Write-Json @{ ok = $true; title = $title }
    }

    'lock' {
        rundll32.exe user32.dll, LockWorkStation
        Write-Json @{ ok = $true }
    }

    'system-status' {
        # Nur die drei gebrauchten Felder abfragen statt der ganzen Klasse:
        # gemessen 13 ms statt 396. WMI holt sonst jede Eigenschaft, auch die
        # teuren, von denen hier keine einzige gelesen wird.
        $os = Get-CimInstance -Query 'SELECT TotalVisibleMemorySize,FreePhysicalMemory,LastBootUpTime FROM Win32_OperatingSystem'
        $totalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
        $freeGb = [math]::Round($os.FreePhysicalMemory / 1MB, 1)

        <#
            Prozessorlast — die mit Abstand teuerste Zeile hier.

            `Win32_Processor` kostet auf diesem Rechner gemessen 1,3 Sekunden,
            und zwar unabhängig davon, wie wenige Eigenschaften man anfordert;
            das ist der WMI-Anbieter selbst. Abgefragt wurde er zweimal, mit
            200 ms Pause dazwischen, weil ein einzelner Abgriff direkt nach dem
            Systemstart auf null stehen kann — macht rund drei der 3,7 Sekunden,
            die „wie läuft der PC" gebraucht hat.

            Der Grund war richtig, der Preis nicht: Jetzt wird einmal gefragt
            und nur dann ein zweites Mal, wenn wirklich null herauskam. Der
            seltene Fall zahlt, was vorher jeder Aufruf gezahlt hat.
        #>
        $cpu = 0
        try {
            $cpu = [int](((Get-CimInstance -Query 'SELECT LoadPercentage FROM Win32_Processor').LoadPercentage |
                Measure-Object -Average).Average)
            if ($cpu -le 0) {
                Start-Sleep -Milliseconds 200
                $cpu = [int](((Get-CimInstance -Query 'SELECT LoadPercentage FROM Win32_Processor').LoadPercentage |
                    Measure-Object -Average).Average)
            }
        }
        catch { $cpu = 0 }

        $disks = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
            [pscustomobject]@{
                drive   = $_.DeviceID
                freeGb  = [math]::Round($_.FreeSpace / 1GB, 1)
                totalGb = [math]::Round($_.Size / 1GB, 1)
            }
        }

        $battery = $null
        try {
            $b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
            if ($b) { $battery = [int]$b.EstimatedChargeRemaining }
        }
        catch { }

        $gpu = $null
        try {
            $g = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
                Sort-Object AdapterRAM -Descending | Select-Object -First 1
            if ($g) { $gpu = $g.Name }
        }
        catch { }

        Write-Json @{
            cpuLoad       = $cpu
            memoryUsedGb  = [math]::Round($totalGb - $freeGb, 1)
            memoryTotalGb = $totalGb
            disks         = @($disks)
            uptimeHours   = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
            batteryPercent = $battery
            gpu           = $gpu
        }
    }
}
