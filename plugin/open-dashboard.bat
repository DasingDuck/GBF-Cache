@echo off
rem Opens the dashboard window, or brings it to front if already open.
rem Implemented in PowerShell so it can find an existing window and avoid
rem opening duplicates.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0open-dashboard.ps1"
