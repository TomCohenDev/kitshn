# kitshn join for Windows (SPEC K-625): installs the kitshn daemon for this user, joins the machine with a one-time
# code, and starts the daemon at logon through Task Scheduler (K-622). "Add machine" on the map prints the command:
#
#   & ([scriptblock]::Create((irm https://kit.example.com/join/windows.ps1))) <code> https://kit.example.com
#
# Optional: $env:KITSHN_DAEMON (a local kitshn.exe instead of the release download).
param([string]$Code, [string]$Server)
$ErrorActionPreference = 'Stop'
if (-not $Code -or -not $Server) { throw 'usage: & ([scriptblock]::Create((irm <kitshn address>/join/windows.ps1))) <code> <kitshn address>' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw "kitshn: no Windows daemon for the CPU $($env:PROCESSOR_ARCHITECTURE) (K-620)." }

$bin = Join-Path $env:LOCALAPPDATA 'Programs\kitshn'
New-Item -ItemType Directory -Force $bin | Out-Null
$next = Join-Path $bin 'kitshn.new.exe'
if ($env:KITSHN_DAEMON) {
  Copy-Item $env:KITSHN_DAEMON $next -Force
} else {
  # K-617: the release that this kitshn names, checked against its SHA256SUMS before it is unpacked.
  $version = (Invoke-RestMethod "$Server/join/version").ToString().Trim()
  if ($version -notmatch '^[0-9a-f]{12}$') { throw "kitshn: $Server names no release ($version), so there is no daemon to download." }
  $base = "https://github.com/Yarden-zamir/kitshn/releases/download/edge-$version"
  $file = 'kitshn-windows-x64.exe.gz'
  $packed = Join-Path $bin $file
  Write-Host "Downloading the kitshn daemon of release $version"
  Invoke-WebRequest "$base/$file" -OutFile $packed -UseBasicParsing
  $sums = (Invoke-WebRequest "$base/SHA256SUMS" -UseBasicParsing).Content
  $expected = ($sums -split "`n" | ForEach-Object { $parts = $_.Trim() -split '\s+\*?'; if ($parts[1] -eq $file) { $parts[0] } } | Select-Object -First 1)
  $actual = (Get-FileHash $packed -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) {
    Remove-Item $packed -Force
    throw "kitshn: the daemon does not match the SHA256SUMS of release $version."
  }
  $in = [IO.File]::OpenRead($packed)
  $out = [IO.File]::Create($next)
  try { (New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)).CopyTo($out) }
  finally { $out.Close(); $in.Close() }
  Remove-Item $packed -Force
}
$exe = Join-Path $bin 'kitshn.exe'
# A running daemon keeps its .exe open; Windows renames it but does not overwrite it (K-620).
if (Test-Path $exe) { Move-Item $exe (Join-Path $bin 'kitshn.old.exe') -Force }
Move-Item $next $exe -Force

& $exe join $Code --server $Server
if ($LASTEXITCODE -ne 0) { throw 'kitshn: the join failed.' }
& $exe service install
if ($LASTEXITCODE -ne 0) { throw 'kitshn: the daemon task could not start.' }
# K-618: the skill for coding agents on this machine. A failure here stops no join.
& $exe skill install
if ($LASTEXITCODE -ne 0) { Write-Warning "kitshn: the skill was not installed; run $exe skill install later." }
# The commands find kitshn in a new terminal.
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($path -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', "$path;$bin", 'User') }
Write-Host "Done. To remove kitshn from this machine: kitshn service uninstall"
