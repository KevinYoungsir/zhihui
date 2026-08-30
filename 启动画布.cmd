@echo off
setlocal

title Zuoge Canvas - Local Development
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-canvas-local.ps1"
set "CANVAS_EXIT_CODE=%ERRORLEVEL%"

if not "%CANVAS_EXIT_CODE%"=="0" (
  echo.
  echo Canvas startup failed. Review the message above, then try again.
  pause
)

exit /b %CANVAS_EXIT_CODE%
