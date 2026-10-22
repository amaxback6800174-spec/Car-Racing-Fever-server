@echo off
title CarGame 1v1 Authoritative Racing Server
echo ========================================================
echo   Starting CarGame Real-Time Authoritative Server...
echo   Port: 3000
echo ========================================================
cd /d "%~dp0"
if not exist node_modules (
    echo Installing dependencies...
    npm install
)
node server.js
pause
