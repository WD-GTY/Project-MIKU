@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title Project MIKU Server

echo ============================================================
echo   Project MIKU - server start
echo   Press Ctrl+C to stop
echo ============================================================
echo.

where npm >nul 2>&1
if %errorlevel% neq 0 (
  echo [ERROR] npm not found. Install Node.js first.
  timeout /t 5 >nul
  exit /b 1
)

set "CHROMA_CMD="
where chroma >nul 2>&1
if %errorlevel%==0 (
  set "CHROMA_CMD=chroma"
) else (
  if exist "%LOCALAPPDATA%\Programs\Python\Python310\Scripts\chroma.exe" (
    set "CHROMA_CMD=%LOCALAPPDATA%\Programs\Python\Python310\Scripts\chroma.exe"
  ) else (
    if exist "%LOCALAPPDATA%\Programs\Python\Python311\Scripts\chroma.exe" (
      set "CHROMA_CMD=%LOCALAPPDATA%\Programs\Python\Python311\Scripts\chroma.exe"
    ) else (
      if exist "%LOCALAPPDATA%\Programs\Python\Python312\Scripts\chroma.exe" (
        set "CHROMA_CMD=%LOCALAPPDATA%\Programs\Python\Python312\Scripts\chroma.exe"
      )
    )
  )
)

netstat -ano | findstr :25565 >nul 2>&1
if %errorlevel%==0 (
  echo [App] Port 25565 already in use. Opening app...
  start "" http://localhost:25565
  timeout /t 3 >nul
  exit /b 0
)

set "CHROMA_MINE="
netstat -ano | findstr :8000 >nul 2>&1
if %errorlevel%==0 (
  echo [Chroma] Already running on :8000 - reusing.
) else (
  if defined CHROMA_CMD (
    echo [Chroma] Starting chromadb...
    start "Chroma DB" /min "%CHROMA_CMD%" run --host 127.0.0.1 --port 8000 --path "%CD%\server\store\chroma"
    set "CHROMA_MINE=1"
    echo [Chroma] Waiting for ready...
    ping -n 6 127.0.0.1 >nul
    curl -s -o nul http://127.0.0.1:8000/api/v2/version
    if not errorlevel 1 (
      echo [Chroma] Ready.
    ) else (
      echo [Chroma] Could not confirm ready; continuing.
    )
  ) else (
    echo [Chroma] chroma not found - skipping. RAG unavailable.
  )
)

call npm start
echo.
echo [App] Server stopped.

if defined CHROMA_MINE (
  echo [Chroma] Stopping chromadb...
  taskkill /f /im chroma.exe >nul 2>&1
)

echo [Done] All stopped.
timeout /t 3 >nul