# Packs the helper's installer files into SpatialStage-Helper.zip, next to
# this script - the file the web page's "Download the helper" button links
# to. serve.bat and publish.bat run it, so the zip always matches the code.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$files = 'Install SpatialStage Helper.bat', 'install.ps1', 'spatialstage_helper.py', 'separate_worker.py', 'drums_worker.py', 'uninstall.ps1', 'README.txt' |
    ForEach-Object { Join-Path $here $_ }
$zip = Join-Path $here 'SpatialStage-Helper.zip'
Compress-Archive -Path $files -DestinationPath $zip -Force
Write-Host "Built $zip"
