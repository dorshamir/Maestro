# Builds Maestro.exe from tools/Launcher.cs.
#
# Uses csc.exe from the .NET Framework, which is present on every supported
# Windows install - so this needs no SDK, no toolchain and no npm packages.
#
#   powershell -ExecutionPolicy Bypass -File tools\build-launcher.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$icon = Join-Path $root 'assets\maestro.ico'
$src  = Join-Path $PSScriptRoot 'Launcher.cs'
$out  = Join-Path $root 'Maestro.exe'

if (-not (Test-Path $icon)) {
    Write-Host 'assets\maestro.ico missing - generating it first...'
    & node (Join-Path $PSScriptRoot 'make-icon.js')
}

$csc = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64\v4.*\csc.exe' -ErrorAction SilentlyContinue |
       Sort-Object FullName -Descending | Select-Object -First 1
if (-not $csc) {
    $csc = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework\v4.*\csc.exe' -ErrorAction SilentlyContinue |
           Sort-Object FullName -Descending | Select-Object -First 1
}
if (-not $csc) { throw 'csc.exe not found. Install the .NET Framework 4.x developer files, or just use start.cmd.' }

# /target:winexe is what makes it a GUI-subsystem binary - that is the setting
# that stops Windows attaching a console window to the process.
& $csc.FullName `
    /nologo `
    /target:winexe `
    /optimize+ `
    /out:"$out" `
    /win32icon:"$icon" `
    /reference:System.dll `
    /reference:System.Windows.Forms.dll `
    "$src"

if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

$kb = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host "Built $out ($kb KB)"
