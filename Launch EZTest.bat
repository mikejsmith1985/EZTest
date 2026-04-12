@echo off
title EZTest — AI Testing Companion
cd /d "%~dp0"

:: ── Check Node.js is installed ─────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Node.js is not installed or not on your PATH.
    echo.
    echo Download Node.js from https://nodejs.org  (LTS version recommended)
    echo After installing, close and reopen this file.
    echo.
    pause
    exit /b 1
)

:: ── Build if dist/ is missing (first-time run) ────────────────────────────
if not exist "%~dp0dist\cli\index.js" (
    echo Building EZTest for the first time — this takes about 10 seconds...
    call npm run build
    if errorlevel 1 (
        echo.
        echo Build failed. Try running: npm install   then try again.
        pause
        exit /b 1
    )
)

:: ── Launch the wizard (browser opens automatically) ──────────────────────
echo Starting EZTest wizard...
node "%~dp0dist\cli\index.js" ui

:: ── If we get here the user pressed Ctrl+C or it crashed ─────────────────
if errorlevel 1 (
    echo.
    echo EZTest exited with an error. Check the output above for details.
    pause
)
