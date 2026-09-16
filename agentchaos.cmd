@echo off
setlocal
set "ROOT=%~dp0"
node "%ROOT%bin\agentchaos.js" %*
exit /b %ERRORLEVEL%
