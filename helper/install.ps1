# Installs SpatialStage Helper for the current Windows user - no admin rights,
# nothing outside the user's own folders:
#
#   %LOCALAPPDATA%\SpatialStage\Helper\
#       python\      portable Python 3.11 (python.org's embeddable zip)
#       app\         the helper itself (copied from next to this script)
#       models\      Demucs model weights (HuggingFace cache)
#       songs\       split songs, one folder each
#       Start SpatialStage Helper.bat
#       Uninstall.bat
#
# plus Start menu / desktop shortcuts, an entry in Settings > Apps, and the
# spatialstage-helper:// link the web page's "Start helper" button uses.
# Running it again upgrades in place and keeps songs\ and models\.
#
# Downloads: Python (~11 MB), PyTorch (~250 MB for CPU, ~3 GB with NVIDIA
# GPU support), Demucs and its libraries (~30 MB), the 6-stem model (~53 MB).
#
#   install.ps1 [-Yes] [-Cpu] [-Dir <folder>] [-NoStart]
#     -Yes     no questions (takes the default answers)
#     -Cpu     skip NVIDIA GPU support even if a GPU is found
#     -Dir     install somewhere else
#     -NoStart do not start the helper at the end

param([switch]$Yes, [switch]$Cpu, [string]$Dir, [switch]$NoStart)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower with its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Version    = '1.1.0'
$PyVersion  = '3.11.9'   # last 3.11 with Windows binaries; the combination below is tested on it
$Torch      = '2.14.0'
$Demucs     = '4.1.0'
$Model      = 'htdemucs_6s'
$PyZipUrl   = "https://www.python.org/ftp/python/$PyVersion/python-$PyVersion-embed-amd64.zip"
$GetPipUrl  = 'https://bootstrap.pypa.io/get-pip.py'
$TorchIndex = 'https://download.pytorch.org/whl'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = if ($Dir) { $Dir } else { Join-Path $env:LOCALAPPDATA 'SpatialStage\Helper' }
$Py   = Join-Path $Root 'python\python.exe'

function Say($text) { Write-Host $text }
function Step($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ''; Write-Host "Install failed: $text" -ForegroundColor Red; exit 1 }
function Ask($question, $default) {
    if ($Yes) { return $default }
    $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
    $a = Read-Host "$question $hint"
    if ([string]::IsNullOrWhiteSpace($a)) { return $default }
    return $a.Trim().ToLower().StartsWith('y')
}
function Download($url, $dest) {
    for ($i = 1; $i -le 3; $i++) {
        try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; return }
        catch { if ($i -eq 3) { throw } ; Say "   download failed ($($_.Exception.Message)), retrying..."; Start-Sleep -Seconds 3 }
    }
}
function RunPy([string[]]$argv, $what) {
    & $Py @argv
    if ($LASTEXITCODE -ne 0) { Fail "$what (exit code $LASTEXITCODE)" }
}
# Last line a Python one-liner prints, or $null if it fails. Error output
# is dropped with the preference relaxed: Windows PowerShell turns a
# redirected native stderr line into a terminating error under 'Stop',
# which would abort the install precisely when a probe says "not yet".
function PyOut([string]$code) {
    if (-not (Test-Path $Py)) { return $null }
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $r = & $Py -c $code 2>$null
        if ($LASTEXITCODE -eq 0 -and $r) { return (@($r) | Select-Object -Last 1).ToString().Trim() }
        return $null
    } catch { return $null } finally { $ErrorActionPreference = $old }
}

Write-Host ''
Write-Host "SpatialStage Helper $Version - installer" -ForegroundColor Green
Say 'Splits songs into stems on this PC for the SpatialStage web app.'
Say "Installs into: $Root"

if (-not [Environment]::Is64BitOperatingSystem) { Fail 'SpatialStage Helper needs 64-bit Windows.' }
foreach ($f in 'spatialstage_helper.py', 'separate_worker.py', 'drums_worker.py', 'uninstall.ps1') {
    if (-not (Test-Path (Join-Path $Here $f))) { Fail "$f is missing next to install.ps1 - extract the whole zip first, then run the installer from the extracted folder." }
}

# --- GPU? ---------------------------------------------------------------
# NVIDIA only: PyTorch's Windows GPU builds are CUDA. The driver's CUDA
# version (from nvidia-smi) decides which build it can run.
$cuda = $null
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $smi -and (Test-Path "$env:SystemRoot\System32\nvidia-smi.exe")) { $smi = "$env:SystemRoot\System32\nvidia-smi.exe" }
if ($smi -and -not $Cpu) {
    $ErrorActionPreference = 'Continue'
    try {
        $out = (& $smi 2>$null) -join "`n"
        $gpuName = (& $smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1)
        if ($out -match 'CUDA Version:\s*(\d+)\.(\d+)') {
            $v = [int]$Matches[1] * 100 + [int]$Matches[2]
            if ($v -ge 1300) { $cuda = 'cu130' } elseif ($v -ge 1206) { $cuda = 'cu126' }
            if ($cuda) {
                Say ''
                Say "NVIDIA GPU found: $gpuName"
                Say 'GPU support splits songs many times faster, but is a ~3 GB download instead of ~250 MB.'
                if (-not (Ask 'Install GPU support?' $true)) { $cuda = $null }
            } else {
                Say "NVIDIA GPU found ($gpuName), but its driver is too old for GPU support (needs CUDA 12.6+). Update the driver and run this again to use it; installing the CPU version for now."
            }
        }
    } catch { $cuda = $null }
    $ErrorActionPreference = 'Stop'
}

$sizeNote = if ($cuda) { 'about 3.5 GB' } else { 'about 1 GB' }
Say ''
Say "This downloads $sizeNote (Python, PyTorch, Demucs and the 6-stem model)."
Say 'It takes 5-15 minutes depending on your connection.'
if (-not (Ask 'Continue?' $true)) { Say 'Nothing was installed.'; exit 0 }

# --- stop a running copy so its files can be replaced -------------------
try {
    Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch { }

New-Item -ItemType Directory -Force -Path $Root, (Join-Path $Root 'app'), (Join-Path $Root 'models'), (Join-Path $Root 'songs') | Out-Null
$tmp = Join-Path $env:TEMP ('spatialstage-helper-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    # --- Python ---------------------------------------------------------
    if ((PyOut 'import sys; print(sys.version.split()[0])') -eq $PyVersion -and (PyOut 'import pip; print(1)') -eq '1') {
        Step "Python $PyVersion is already installed"
    } else {
        Step "Downloading Python $PyVersion"
        $pyDir = Join-Path $Root 'python'
        if (Test-Path $pyDir) { Remove-Item -Recurse -Force $pyDir }
        Download $PyZipUrl (Join-Path $tmp 'python.zip')
        Expand-Archive -Path (Join-Path $tmp 'python.zip') -DestinationPath $pyDir -Force
        # The embeddable build ignores site-packages until "import site" is
        # switched on in its ._pth file - pip and everything it installs
        # live there.
        $pth = Get-ChildItem $pyDir -Filter 'python*._pth' | Select-Object -First 1
        (Get-Content $pth.FullName) -replace '^#\s*import site', 'import site' | Set-Content -Encoding ASCII $pth.FullName
        Step 'Installing pip'
        Download $GetPipUrl (Join-Path $tmp 'get-pip.py')
        RunPy @((Join-Path $tmp 'get-pip.py'), '--no-warn-script-location', '--disable-pip-version-check') 'installing pip'
    }

    # --- PyTorch --------------------------------------------------------
    $pipArgs = @('-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check')
    $want = if ($cuda) { "$Torch+$cuda" } else { "$Torch+cpu" }
    $have = PyOut 'import torch; print(torch.__version__)'
    if ($have -eq $want) {
        Step "PyTorch $have is already installed"
    } else {
        $installed = $false
        if ($cuda) {
            Step "Downloading PyTorch $Torch with GPU support ($cuda) - the big one, ~3 GB"
            & $Py @($pipArgs + @("torch==$Torch", '--index-url', "$TorchIndex/$cuda"))
            if ($LASTEXITCODE -eq 0) { $installed = $true } else { Say 'GPU version failed to install - falling back to the CPU version.' }
        }
        if (-not $installed) {
            Step "Downloading PyTorch $Torch (CPU) - ~250 MB"
            RunPy ($pipArgs + @("torch==$Torch", '--index-url', "$TorchIndex/cpu")) 'installing PyTorch'
        }
    }

    # --- Demucs ---------------------------------------------------------
    Step "Installing Demucs $Demucs"
    RunPy ($pipArgs + @("demucs==$Demucs", 'numpy')) 'installing Demucs'

    # --- the helper -----------------------------------------------------
    Step 'Installing the helper'
    foreach ($f in 'spatialstage_helper.py', 'separate_worker.py', 'drums_worker.py', 'uninstall.ps1') {
        Copy-Item (Join-Path $Here $f) (Join-Path $Root "app\$f") -Force
    }
    $launcher = Join-Path $Root 'Start SpatialStage Helper.bat'
    @(
        '@echo off',
        'title SpatialStage Helper',
        'set "HF_HOME=%~dp0models"',
        'set "HF_HUB_DISABLE_SYMLINKS_WARNING=1"',
        'set "HF_HUB_VERBOSITY=error"',
        'set "SPATIALSTAGE_HELPER_HOME=%~dp0."',
        '"%~dp0python\python.exe" -u "%~dp0app\spatialstage_helper.py" %*',
        'if errorlevel 1 pause'
    ) | Set-Content -Encoding ASCII $launcher
    # One line on purpose: uninstall.ps1 deletes this folder, this .bat
    # included, and cmd would otherwise try to read the next line of a
    # file that is gone. "(goto)" ends the batch without that read ("exit /b"
    # still printed "The batch file cannot be found."). It also steps out
    # of the folder first - Windows will not delete a folder that is some
    # window's current directory.
    '@cd /d "%TEMP%" & powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\uninstall.ps1" & pause & (goto) 2>nul' |
        Set-Content -Encoding ASCII (Join-Path $Root 'Uninstall.bat')

    # --- the model ------------------------------------------------------
    Step "Downloading the $Model model (~53 MB)"
    $env:HF_HOME = Join-Path $Root 'models'
    # HuggingFace's download warns about Windows symlinks and anonymous
    # downloads - harmless, and alarming in an installer window.
    $env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
    $env:HF_HUB_VERBOSITY = 'error'
    RunPy @('-c', "from demucs.pretrained import get_model; get_model('$Model'); print('   model ready')") 'downloading the model'

    # --- shortcuts, link handler, Settings > Apps -----------------------
    Step 'Adding shortcuts'
    $shell = New-Object -ComObject WScript.Shell
    $programs = [Environment]::GetFolderPath('Programs')
    $desktop = [Environment]::GetFolderPath('Desktop')
    foreach ($lnkPath in (Join-Path $programs 'SpatialStage Helper.lnk'), (Join-Path $desktop 'SpatialStage Helper.lnk')) {
        $lnk = $shell.CreateShortcut($lnkPath)
        $lnk.TargetPath = $launcher
        $lnk.WorkingDirectory = $Root
        $lnk.Description = 'Splits songs into stems for the SpatialStage web app'
        $lnk.Save()
    }

    # spatialstage-helper://start - the page's "Start helper" button. The URL
    # itself is never passed on; any such link just starts the helper.
    $proto = 'HKCU:\Software\Classes\spatialstage-helper'
    New-Item -Path "$proto\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path $proto -Name '(default)' -Value 'URL:SpatialStage Helper'
    Set-ItemProperty -Path $proto -Name 'URL Protocol' -Value ''
    Set-ItemProperty -Path "$proto\shell\open\command" -Name '(default)' -Value "`"$env:ComSpec`" /c `"`"$launcher`"`""

    $un = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SpatialStageHelper'
    New-Item -Path $un -Force | Out-Null
    $kb = [int]((Get-ChildItem $Root -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1KB)
    foreach ($p in @(
        @('DisplayName', 'SpatialStage Helper', 'String'), @('DisplayVersion', $Version, 'String'),
        @('Publisher', 'SpatialStage', 'String'), @('InstallLocation', $Root, 'String'),
        @('UninstallString', "`"$(Join-Path $Root 'Uninstall.bat')`"", 'String'),
        @('NoModify', 1, 'DWord'), @('NoRepair', 1, 'DWord'), @('EstimatedSize', $kb, 'DWord'))) {
        New-ItemProperty -Path $un -Name $p[0] -Value $p[1] -PropertyType $p[2] -Force | Out-Null
    }
} catch {
    Fail $_.Exception.Message
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'SpatialStage Helper is installed.' -ForegroundColor Green
Say 'Start it any time from the Start menu or the desktop shortcut "SpatialStage Helper",'
Say 'or with the "Start helper" button on the SpatialStage page.'
Say 'To remove it: Settings > Apps > SpatialStage Helper, or Uninstall.bat in the install folder.'
if (-not $NoStart) {
    Say ''
    Say 'Starting it now - go back to the SpatialStage page; it connects by itself.'
    Start-Process -FilePath $launcher -WorkingDirectory $Root
}
exit 0
