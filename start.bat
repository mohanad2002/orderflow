@echo off
REM ──────────────────────────────────────────────────────────────
REM  Orderflow - local launcher (SQLite via sql.js + Nextcloud sync)
REM  Settings come from the .env file in this folder.
REM ──────────────────────────────────────────────────────────────

REM Uncomment and set this if Node.js isn't in your global PATH:
REM set PATH=D:\Tools\node;%PATH%

cd /d "%~dp0"

if not exist ".env" (
  echo.
  echo  No .env file found.
  echo  Copy .env.example to .env and fill in the Nextcloud values first.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo  Installing dependencies - first run only...
  call npm install
)

echo.
echo  Starting Orderflow...
echo  Open http://localhost:3000 in your browser
echo  Press Ctrl+C to stop the server
echo.

node server.js
pause
