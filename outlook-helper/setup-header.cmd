@echo off
setlocal
title Orderflow - Outlook button setup
set "OF_SETUP=%~f0"
echo.
echo   Orderflow - Outlook button setup
echo   ---------------------------------
echo   This lets Orderflow open its emails straight in Outlook on this PC.
echo   It only changes settings for your own Windows user (no admin rights).
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $d=Join-Path $env:LOCALAPPDATA 'Orderflow'; New-Item -ItemType Directory -Force -Path $d | Out-Null; $h=Join-Path $d 'OrderflowOutlook.ps1'; $t=[IO.File]::ReadAllText($env:OF_SETUP); $i=$t.LastIndexOf('#__HELPER__'); if ($i -lt 0) { throw 'Setup file is damaged - download it again.' }; [IO.File]::WriteAllText($h, $t.Substring($i), (New-Object Text.UTF8Encoding $true)); $p=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'; $q=[char]34; $c=$q+$p+$q+' -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File '+$q+$h+$q+' '+$q+'%%1'+$q; $k='HKCU:\Software\Classes\orderflow-mail'; New-Item -Path $k -Value 'URL:Orderflow Outlook email' -Force | Out-Null; New-ItemProperty -Path $k -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null; New-Item -Path ($k+'\shell') -Force | Out-Null; New-Item -Path ($k+'\shell\open') -Force | Out-Null; New-Item -Path ($k+'\shell\open\command') -Value $c -Force | Out-Null; Write-Host '  Done - the Outlook button is installed.' -ForegroundColor Green } catch { Write-Host ('  Setup failed: '+$_.Exception.Message) -ForegroundColor Red; exit 1 }"
echo.
echo   You can close this window and go back to Orderflow.
echo.
pause
exit /b
