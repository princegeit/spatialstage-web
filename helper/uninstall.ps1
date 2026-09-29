# Removes SpatialStage Helper: the install folder, its shortcuts, the
# spatialstage-helper:// link and the Settings > Apps entry. Run through
# Uninstall.bat in the install folder (or from Settings > Apps).
# Split songs can be kept: they stay in the songs folder.

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $env:TEMP

Write-Host ''
Write-Host 'Uninstall SpatialStage Helper' -ForegroundColor Yellow
Write-Host "Folder: $Root"
$a = Read-Host 'Remove it? [y/N]'
if (-not $a -or -not $a.Trim().ToLower().StartsWith('y')) { Write-Host 'Nothing was removed.'; exit 0 }

$songs = Join-Path $Root 'songs'
$keepSongs = $false
$count = @(Get-ChildItem $songs -Directory -ErrorAction SilentlyContinue).Count
if ($count -gt 0) {
    $b = Read-Host "Also delete the $count song(s) you have split? [y/N]"
    $keepSongs = -not ($b -and $b.Trim().ToLower().StartsWith('y'))
}

# Stop the helper (and any split it is running) so its files can go.
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

foreach ($lnk in (Join-Path ([Environment]::GetFolderPath('Programs')) 'SpatialStage Helper.lnk'),
                 (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SpatialStage Helper.lnk')) {
    Remove-Item $lnk -Force -ErrorAction SilentlyContinue
}
Remove-Item 'HKCU:\Software\Classes\spatialstage-helper' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SpatialStageHelper' -Recurse -Force -ErrorAction SilentlyContinue

Get-ChildItem $Root -Force -ErrorAction SilentlyContinue |
    Where-Object { -not ($keepSongs -and $_.Name -eq 'songs') } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
if (-not $keepSongs) { Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ''
if ($keepSongs) { Write-Host "Removed. Your split songs are still in $songs" -ForegroundColor Green }
else { Write-Host 'SpatialStage Helper has been removed.' -ForegroundColor Green }
