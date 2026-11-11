@echo off
chcp 65001 >nul
title MrPG Folder Organizer
cd /d "%~dp0"
set "MRPG_HOME=%~dp0."
if not exist "runtime\python\python.exe" (
  echo Die Laufzeit fehlt. Bitte die ZIP zuerst vollstaendig entpacken ^(Rechtsklick - Alle extrahieren^).
  pause
  exit /b 1
)
"runtime\python\python.exe" "app\main.py" %*
if errorlevel 1 pause
