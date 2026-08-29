@echo off
cd /d "%~dp0"
start http://127.0.0.1:15722
node src\index.js
pause
