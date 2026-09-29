@echo off
REM ============================================================
REM  Launch ZCode WITH the Chrome DevTools debug port (9222).
REM
REM  Why: dsh-zcode2api can only solve Aliyun's captcha inside the
REM  client's own session via CDP. Verified result: even then the
REM  upstream replies 3007/3012, so this route is currently CLOSED.
REM  Kept for future experiments.
REM
REM  Two things this script fixes:
REM    1. clears ELECTRON_RUN_AS_NODE (if inherited, Electron runs as
REM       plain Node and exits instantly - the "flash and close" bug)
REM    2. keeps this window open so any error is readable
REM ============================================================

set "ELECTRON_RUN_AS_NODE="
set "ZCODE=C:\Users\zy\AppData\Local\Programs\ZCode\ZCode.exe"

if not exist "%ZCODE%" (
  echo [ERROR] ZCode.exe not found: %ZCODE%
  pause
  exit /b 1
)

echo Starting ZCode with --remote-debugging-port=9222 ...
start "" "%ZCODE%" --remote-debugging-port=9222 --remote-allow-origins=*

echo.
echo Started. Debug endpoint: http://127.0.0.1:9222/json/version
echo This window closes in 10 seconds.
timeout /t 10 >nul
