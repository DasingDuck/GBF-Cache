@echo off
chcp 65001 >nul
title GBF Local Cache Server
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "H:\DevTools\nodejs\node-v24.21.0-win-x64\node.exe" set "NODE_EXE=H:\DevTools\nodejs\node-v24.21.0-win-x64\node.exe"

if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Install Node.js, or edit this file and set NODE_EXE to the full path of node.exe
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting GBF local cache server...
echo   A console window (dashboard) will open automatically.
echo   Keep THIS window open, minimize it is fine.
echo.

"%NODE_EXE%" server.js

echo.
echo   Server stopped.
pause
