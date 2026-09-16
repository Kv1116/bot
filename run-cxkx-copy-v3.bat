@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo          CXKX COPY V3 - EMERGENCY SELL RECOVERY
echo ============================================================
echo LIVE MODE - uses your existing cxkx-copy.env.
echo Emergency SELL recovery is ENABLED.
echo.

if not exist "cxkx-copy.env" (
  echo ERROR: cxkx-copy.env not found.
  pause
  exit /b 1
)

if not exist "src\cxkx-copy-v3.ts" (
  echo ERROR: src\cxkx-copy-v3.ts not found.
  pause
  exit /b 1
)

set EMERGENCY_SELL_RETRY_ENABLED=true
set EMERGENCY_SELL_MAX_RETRIES=3
set EMERGENCY_SELL_SLIPPAGES=15,25,40
set EMERGENCY_SELL_PRIORITY_FEE_MICROLAMPORTS=350000
set EMERGENCY_SELL_RETRY_DELAY_MS=35

node --env-file=cxkx-copy.env --import tsx src/cxkx-copy-v3.ts

echo.
pause
