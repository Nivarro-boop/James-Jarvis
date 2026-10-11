<#
    Ausgabegeräte und laufende Wiedergabe.

    Zwei Dinge, für die Node unter Windows keinen Weg hat:

    1. Das Standard-Ausgabegerät auflisten und umstellen. Das ist der einzige
       Weg, beliebigen Ton — Apple Music, YouTube, was auch immer — auf einem
       Echo Dot landen zu lassen, der über Bluetooth gekoppelt ist. Spotify
       braucht das nicht, das kann Connect; alles andere schon.

    2. Auslesen, was gerade spielt. Windows führt darüber selbst Buch
       (System Media Transport Controls), und zwar für jede App, die sich bei
       den Medientasten anmeldet — Spotify, Apple Music, der Browser. Das ist
       die einzige Auskunft, die auch dann stimmt, wenn James gar nicht der
       war, der die Musik angemacht hat.

    Ausgabe ist immer JSON auf stdout.
#>

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('list', 'set', 'now-playing')]
    [string]$Action,

    [string]$Id = ''
)

$ErrorActionPreference = 'Stop'

function Write-Json($obj) {
    ConvertTo-Json -InputObject $obj -Depth 6 -Compress
}

<#
    Die COM-Schnittstellen der Audio-Endpunkte.

    Alles Wesentliche steckt in der C#-Klasse unten und nicht in PowerShell,
    und das hat einen handfesten Grund: PowerShell kann ein COM-Objekt nicht
    auf eine selbst deklarierte Schnittstelle umwandeln. Weder
    `[IMMDeviceEnumerator](New-Object …)` noch der Umweg über `CoClass`
    funktionieren — das eine wirft „kann nicht konvertiert werden", das andere
    „kein Konstruktor gefunden". In C# macht die Laufzeitumgebung beim
    Umwandeln von selbst ein QueryInterface, und damit geht es.

    Von jeder Schnittstelle stehen nur die Methoden drin, die gebraucht
    werden — der Rest ist als Platzhalter da, damit die Reihenfolge der vtable
    stimmt. Fehlt eine, zeigt der Aufruf auf die falsche Methode, und das
    äußert sich nicht als Fehler, sondern als Absturz des ganzen Prozesses.

    IPolicyConfig ist von Microsoft nicht dokumentiert. Es ist trotzdem der
    einzige Weg, das Standardgerät von außen umzustellen: Windows bietet dafür
    keine offizielle Schnittstelle an, nur den Regler in den Einstellungen.
#>
$signature = @'
using System;
using System.Runtime.InteropServices;

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, out IntPtr iface);
    int OpenPropertyStore(int access, out IntPtr properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig {
    int GetMixFormat(string device, out IntPtr format);
    int GetDeviceFormat(string device, bool bDefault, out IntPtr format);
    int ResetDeviceFormat(string device);
    int SetDeviceFormat(string device, IntPtr endpointFormat, IntPtr mixFormat);
    int GetProcessingPeriod(string device, bool bDefault, out IntPtr defaultPeriod, out IntPtr minimumPeriod);
    int SetProcessingPeriod(string device, IntPtr period);
    int GetShareMode(string device, out IntPtr mode);
    int SetShareMode(string device, IntPtr mode);
    int GetPropertyValue(string device, bool bFxStore, IntPtr key, out IntPtr value);
    int SetPropertyValue(string device, bool bFxStore, IntPtr key, IntPtr value);
    int SetDefaultEndpoint(string device, int role);
    int SetEndpointVisibility(string device, bool visible);
}

public static class AudioEndpoint {
    static readonly Guid EnumeratorClsid = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid PolicyClsid = new Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9");

    // dataFlow 0 = eRender (Ausgabe), role 0 = eConsole.
    public static string GetDefaultId() {
        var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(
            Type.GetTypeFromCLSID(EnumeratorClsid));
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(0, 0, out device) != 0 || device == null) return "";
        string id;
        device.GetId(out id);
        return id ?? "";
    }

    // Rolle 0 (eConsole) und 1 (eMultimedia) — beides, weil Windows sie
    // getrennt führt und Musik je nach App an der einen oder der anderen
    // hängt. Rolle 2 (eCommunications) bleibt bewusst stehen: Dort hängt die
    // Sprachausgabe von Chat-Programmen, und die soll nicht mitwandern, nur
    // weil jemand Musik auf den Lautsprecher im Wohnzimmer legt.
    public static int SetDefault(string id) {
        var config = (IPolicyConfig)Activator.CreateInstance(
            Type.GetTypeFromCLSID(PolicyClsid));
        int hr = config.SetDefaultEndpoint(id, 0);
        if (hr != 0) return hr;
        return config.SetDefaultEndpoint(id, 1);
    }
}
'@

function Use-AudioTypes {
    if (-not ('AudioEndpoint' -as [type])) {
        Add-Type -TypeDefinition $signature
    }
}

switch ($Action) {

    <#
        Alle aktiven Ausgabegeräte mit Namen und Kennung.

        Die Namen stehen in der Registrierung; sie dort zu holen spart die
        vollständige COM-Aufzählung über IPropertyStore und PROPVARIANT, und
        die ist aus PowerShell heraus mehr als hundert Zeilen Zwischencode für
        eine Zeichenkette.

        Zusammengesetzt wird aus zwei Werten, weil Windows es genauso macht:
        „Lautsprecher" allein steht dreimal in der Liste, sobald ein Headset
        und zwei Monitore angeschlossen sind — erst mit dem Gerät dahinter
        wird daraus „Lautsprecher (Razer BlackShark V2)".
    #>
    'list' {
        $root = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
        $default = ''
        try {
            Use-AudioTypes
            $default = [AudioEndpoint]::GetDefaultId()
        }
        catch {
            # Ohne diese Auskunft fehlt nur die Markierung, welches Gerät
            # gerade eingestellt ist. Die Liste selbst bleibt brauchbar.
        }

        $devices = @()
        foreach ($key in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
            # 1 = aktiv. 2 ist deaktiviert, 4 nicht vorhanden, 8 ausgesteckt —
            # nichts davon ist ein Ziel, auf das man Musik schicken kann.
            $state = (Get-ItemProperty -Path $key.PSPath -Name 'DeviceState' -ErrorAction SilentlyContinue).DeviceState
            if ($state -ne 1) { continue }

            $entry = Get-ItemProperty -Path (Join-Path $key.PSPath 'Properties') -ErrorAction SilentlyContinue
            if (-not $entry) { continue }

            # Was auf dem Anschluss steht ("Lautsprecher", "Kopfhörer") …
            $describe = $entry.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
            # … und das Gerät dahinter ("Razer BlackShark V2 HS USB").
            $adapter = $entry.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'

            $name = if ($describe -and $adapter) { "$describe ($adapter)" }
            elseif ($describe) { [string]$describe }
            elseif ($adapter) { [string]$adapter }
            else { $null }
            if (-not $name) { continue }

            $endpointId = '{0.0.0.00000000}.' + $key.PSChildName
            $devices += [pscustomobject]@{
                id       = $endpointId
                name     = $name
                kind     = [string]$describe
                isActive = ($endpointId -eq $default)
            }
        }

        Write-Json @{ ok = $true; devices = @($devices) }
    }

    # Das Standardgerät umstellen.
    'set' {
        if (-not $Id) { Write-Json @{ ok = $false; error = 'Keine Gerätekennung' }; break }

        try {
            Use-AudioTypes
            $hr = [AudioEndpoint]::SetDefault($Id)
            if ($hr -ne 0) {
                Write-Json @{ ok = $false; error = "Windows lehnt den Wechsel ab (0x$('{0:X8}' -f $hr))" }
            }
            else {
                Write-Json @{ ok = $true; id = $Id }
            }
        }
        catch {
            Write-Json @{ ok = $false; error = [string]$_.Exception.Message }
        }
    }

    # Was gerade spielt — egal welche App es spielt.
    'now-playing' {
        try {
            Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop

            # WinRT-Aufrufe sind asynchron und liefern IAsyncOperation<T>.
            # PowerShell 5.1 kann darauf nicht warten; der Umweg geht über die
            # generische AsTask-Methode, die pro Ergebnistyp einmal konkret
            # gemacht werden muss.
            $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
                    $_.Name -eq 'AsTask' -and
                    $_.GetParameters().Count -eq 1 -and
                    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
                })[0]

            function Await($operation, $resultType) {
                $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
                # Mit Frist: Ein WinRT-Aufruf, der nie zurückkommt, hinge sonst
                # so lange wie die Sitzung selbst.
                if (-not $task.Wait(4000)) { throw 'Windows antwortet nicht.' }
                $task.Result
            }

            $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
            $manager = Await ($managerType::RequestAsync()) $managerType
            $session = $manager.GetCurrentSession()

            if (-not $session) {
                Write-Json @{ ok = $true; playing = $false; empty = $true }
                break
            }

            $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
            $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType
            $info = $session.GetPlaybackInfo()

            Write-Json @{
                ok      = $true
                # 4 = Playing. Alles andere (gestoppt, pausiert, im Wechsel)
                # ist für die Frage „läuft was" ein Nein.
                playing = ($info.PlaybackStatus -eq 4)
                title   = [string]$props.Title
                artist  = [string]$props.Artist
                album   = [string]$props.AlbumTitle
                app     = [string]$session.SourceAppUserModelId
            }
        }
        catch {
            # Kein Grund zum Lärmen: Auf einem Windows ohne laufende
            # Medien-App gibt es diese Auskunft schlicht nicht, und der
            # Aufrufer hat für den Fall einen anderen Weg.
            Write-Json @{ ok = $false; error = [string]$_.Exception.Message }
        }
    }
}
