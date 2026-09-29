@echo off
title Install SpatialStage Helper
rem Double-click to install. Everything happens in install.ps1; this only
rem gets it past PowerShell's default "scripts are disabled" policy for this
rem one run, without changing the policy itself.
if not exist "%~dp0install.ps1" (
    echo.
    echo This file has to stay next to install.ps1.
    echo If you opened it straight from the zip, extract the zip first
    echo ^(right-click it, Extract All^), then run it from the extracted folder.
    echo.
    pause
    exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
