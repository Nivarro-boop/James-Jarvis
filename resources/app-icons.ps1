# Programmsymbole fuer die Denkblase an der Kugel.
#
# Liest das echte Symbol aus der Programmdatei, 64 Pixel mit Transparenz.
# Electrons app.getFileIcon liefert bei manchen Programmen (etwa dem NoRisk
# Launcher) nur das allgemeine Fenstersymbol; SHDefExtractIcon liest die
# Symbolressource selbst. Die Pfade kommen als JSON-Liste in JARVIS_ICON_PATHS,
# die Antwort ist ein JSON-Objekt Pfad -> PNG in Base64.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace JarvisIcons -Name Native -MemberDefinition @'
[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
public static extern int SHDefExtractIcon(string file, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
[DllImport("user32.dll")]
public static extern bool DestroyIcon(IntPtr handle);
'@
$paths = $env:JARVIS_ICON_PATHS | ConvertFrom-Json
$out = @{}
foreach ($p in $paths) {
  try {
    $large = [IntPtr]::Zero
    $small = [IntPtr]::Zero
    $bmp = $null
    $hr = [JarvisIcons.Native]::SHDefExtractIcon($p, 0, 0, [ref]$large, [ref]$small, (64 -bor (16 -shl 16)))
    if ($hr -eq 0 -and $large -ne [IntPtr]::Zero) {
      $bmp = [System.Drawing.Icon]::FromHandle($large).ToBitmap()
      [void][JarvisIcons.Native]::DestroyIcon($large)
      if ($small -ne [IntPtr]::Zero) { [void][JarvisIcons.Native]::DestroyIcon($small) }
    } else {
      $bmp = [System.Drawing.Icon]::ExtractAssociatedIcon($p).ToBitmap()
    }
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $out[$p] = [Convert]::ToBase64String($ms.ToArray())
  } catch { }
}
$out | ConvertTo-Json -Compress
