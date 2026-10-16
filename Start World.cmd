@echo off
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 or newer from https://nodejs.org, then open this launcher again.
) else (
  node scripts\local-launch.mjs
)
popd
pause
