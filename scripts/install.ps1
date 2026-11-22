$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$release = 'https://github.com/praxgroup/installer/releases/latest/download'
$asset = 'prax-windows-x64.exe'
$home_dir = Join-Path $env:LOCALAPPDATA 'Prax'
New-Item -ItemType Directory -Force -Path $home_dir | Out-Null

$exe = Join-Path $home_dir 'prax.exe'
$partial = "$exe.part"
$checksum = Join-Path $home_dir 'prax.sha256'

Write-Host 'Téléchargement du programme Prax...'
Invoke-WebRequest -UseBasicParsing -Uri "$release/$asset" -OutFile $partial
Invoke-WebRequest -UseBasicParsing -Uri "$release/$asset.sha256" -OutFile $checksum

$expected = ((Get-Content -Raw $checksum).Trim() -split '\s+')[0].ToLower()
$actual = (Get-FileHash -Algorithm SHA256 $partial).Hash.ToLower()
if ($expected -ne $actual) {
    Remove-Item $partial -Force
    throw 'Empreinte différente : le téléchargement est abîmé ou modifié. Rien n''a été lancé.'
}

Move-Item -Force $partial $exe
Remove-Item $checksum -Force

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (-not (($userPath -split ';') -contains $home_dir)) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $home_dir).TrimStart(';')), 'User')
    Write-Host "Commande prax ajoutée au PATH ($home_dir)."
}
if (-not (($env:Path -split ';') -contains $home_dir)) { $env:Path = "$env:Path;$home_dir" }

& $exe install
