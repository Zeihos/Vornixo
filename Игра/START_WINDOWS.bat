@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if errorlevel 1 goto folder_error

if not exist "server.js" goto files_missing
set "NODE_EXE="
where.exe node.exe >nul 2>&1
if not errorlevel 1 set "NODE_EXE=node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE goto node_missing

echo [VORNIXO] Checking Node.js...
"%NODE_EXE%" --version
if errorlevel 1 goto node_failed
echo [VORNIXO] Starting local game server...
echo [VORNIXO] Browser URL: http://127.0.0.1:3000
echo [VORNIXO] Keep this window open while playing.
echo.
start "" "http://127.0.0.1:3000"
"%NODE_EXE%" "server.js"
echo.
echo [VORNIXO] Server has stopped. Check the error above, if any.
pause
exit /b 0

:node_missing
echo ERROR: Node.js was not found.
echo Check that Node.js is installed (not just downloaded).
echo Download/install Node.js LTS: https://nodejs.org/
echo Then CLOSE all CMD windows and reopen this file.
echo Expected default path: C:\Program Files\nodejs\node.exe
pause
exit /b 1

:node_failed
echo ERROR: Node.js could not start. Reinstall Node.js LTS.
pause
exit /b 1

:files_missing
echo ERROR: server.js is missing. Extract the COMPLETE ZIP archive first.
pause
exit /b 1

:folder_error
echo ERROR: Cannot open the game folder.
pause
exit /b 1
