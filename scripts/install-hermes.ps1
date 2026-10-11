param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Void James Hermes'),
  [switch]$Repair
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskArchive = (Resolve-Path -LiteralPath $Archive).Path
$taskTarget = [System.IO.Path]::GetFullPath($Destination)
$taskSource = Join-Path $taskTarget 'hermes-agent-main'
if ((Test-Path -LiteralPath (Join-Path $taskTarget 'installation.json')) -and -not $Repair) {
  Write-Output 'Diese Hermes-Installation besteht bereits. Die vorhandenen Daten bleiben erhalten.'
  exit 0
}
New-Item -ItemType Directory -Path $taskTarget -Force | Out-Null
$taskZip = [System.IO.Compression.ZipFile]::OpenRead($taskArchive)
try {
  if (-not $taskZip.GetEntry('hermes-agent-main/LICENSE')) { throw 'Das Archiv enthält nicht die erwartete Hermes-Quelle.' }
  foreach ($taskEntry in $taskZip.Entries) {
    $taskEntryTarget = [System.IO.Path]::GetFullPath((Join-Path $taskTarget $taskEntry.FullName))
    if (-not $taskEntryTarget.StartsWith($taskTarget + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Ungültiger Archivpfad außerhalb des Installationsordners.'
    }
  }
} finally { $taskZip.Dispose() }
if (-not (Test-Path -LiteralPath (Join-Path $taskSource 'pyproject.toml'))) {
  [System.IO.Compression.ZipFile]::ExtractToDirectory($taskArchive, $taskTarget, $false)
}
# Patch only this separate installation's known obsolete security pin.
$taskProject = Join-Path $taskSource 'pyproject.toml'
$taskProjectText = [System.IO.File]::ReadAllText($taskProject)
$taskProjectText = $taskProjectText.Replace('PyJWT[crypto]==2.13.0;', 'PyJWT[crypto]==2.15.1;')
$taskProjectText = $taskProjectText.Replace('httpx2==2.7.0', 'httpx2==2.13.1')
[System.IO.File]::WriteAllText($taskProject, $taskProjectText, [System.Text.UTF8Encoding]::new($false))
$taskUvCommand = Get-Command uv -ErrorAction SilentlyContinue
$taskUv = if ($taskUvCommand) { $taskUvCommand.Source } else { Join-Path $env:LOCALAPPDATA 'hermes\bin\uv.exe' }
if (-not (Test-Path -LiteralPath $taskUv)) { throw 'uv wurde nicht gefunden. Bitte uv installieren und erneut starten.' }
$taskPython = (Get-Command python -ErrorAction Stop).Source
$taskEnvironment = Join-Path $taskTarget 'venv'
if (-not (Test-Path -LiteralPath (Join-Path $taskEnvironment 'Scripts\python.exe'))) {
  & $taskUv venv --python $taskPython $taskEnvironment
  if ($LASTEXITCODE -ne 0) { throw 'Die eigene Python-Umgebung konnte nicht angelegt werden.' }
}
$taskExecutable = Join-Path $taskEnvironment 'Scripts\python.exe'
& $taskUv pip install --python $taskExecutable --only-binary ':all:' -e ($taskSource + '[all]') 'aiohttp==3.14.3'
if ($LASTEXITCODE -ne 0) { throw 'Hermes-Abhängigkeiten konnten nicht installiert werden; Quelle und Protokoll bleiben erhalten.' }
@{ source = $taskSource; python = $taskExecutable; profile = (Join-Path $taskTarget 'profile') } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskTarget 'installation.json') -Encoding utf8
Write-Output 'Hermes wurde separat installiert. Bestehende Hermes-Konten und Einstellungen wurden nicht verändert.'
