@echo off
title PrintPulse Agent Setup
echo ============================================
echo PrintPulse Agent — Setup
echo ============================================
echo.

REM Check Python
echo [1/3] Checking Python...
where python >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo    Python not found. Installing...
  echo    Please install Python 3.8+ from https://www.python.org/downloads/
  echo    Make sure to check "Add Python to PATH"
  echo.
  echo    Or manually install then re-run this script.
  start https://www.python.org/downloads/
  pause
  exit /b 1
) else (
  for /f "tokens=2" %%a in ('python --version 2^>^&1') do set PYVER=%%a
  echo    Found Python %PYVER%
)

REM Install snmpy
echo.
echo [2/3] Installing snmpy (fast SNMP library)...
pip install git+https://github.com/snmpware/snmpy.git
if %ERRORLEVEL% NEQ 0 (
  echo    WARNING: snmpy install failed. Agent will use fallback mode.
  echo    This is OK — Node.js SNMP will still work but slower.
) else (
  echo    snmpy installed successfully!
)

REM Verify agent
echo.
echo [3/3] Verifying agent...
if exist dist\printpulse-agent.exe (
  echo    Agent executable found: dist\printpulse-agent.exe
) else (
  echo    Building agent...
  cd /d "%~dp0"
  call npm install 2>nul
  npm run build 2>nul
  if exist dist\printpulse-agent.exe (
    echo    Agent built: dist\printpulse-agent.exe
  ) else (
    echo    WARNING: Agent binary not found. Run 'npm run build' manually.
  )
)

echo.
echo ============================================
echo ✅ Setup complete!
echo.
echo Quick test:
echo   snmpy_scanner.py 10.10.30.244 --probe
echo.
echo Run agent:
echo   dist\printpulse-agent.exe
echo ============================================
pause
