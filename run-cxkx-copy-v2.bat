@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo              CXKX COPY V2 - FAST PROFIT TEST
echo ============================================================
echo LIVE MODE - real trades, tiny 0.005 SOL test size.
echo Direct Pump.fun only for this validation run.
echo.

if not exist "cxkx-copy.env" (
  if not exist "signal-sniper-v2.env" (
    echo ERROR: cxkx-copy.env and signal-sniper-v2.env are both missing.
    pause
    exit /b 1
  )
  copy /Y "signal-sniper-v2.env" "cxkx-copy-v2.env" >nul
) else (
  copy /Y "cxkx-copy.env" "cxkx-copy-v2.env" >nul
)

if not exist "src\cxkx-copy-v2.ts" (
  echo ERROR: src\cxkx-copy-v2.ts not found.
  pause
  exit /b 1
)

PowerShell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='cxkx-copy-v2.env'; $s=Get-Content $p -Raw;" ^
  "$r=@{" ^
  "'^TARGET_WALLET=.*$'='TARGET_WALLET=CxkxCQYLWVRStkWwdCcsAX6BWcPnMeKGQ3zm2m6jVjV8';" ^
  "'^BUY_SOL=.*$'='BUY_SOL=0.005';" ^
  "'^BUY_USD=.*$'='BUY_USD=0.5';" ^
  "'^MAX_SOL_PER_TRADE=.*$'='MAX_SOL_PER_TRADE=0.005';" ^
  "'^SIGNAL_MIN_TARGET_BUY_SOL=.*$'='SIGNAL_MIN_TARGET_BUY_SOL=0.05';" ^
  "'^SIGNAL_MAX_TARGET_BUY_SOL=.*$'='SIGNAL_MAX_TARGET_BUY_SOL=1.5';" ^
  "'^SIGNAL_LEADER_MIN_BUY_SOL=.*$'='SIGNAL_LEADER_MIN_BUY_SOL=10';" ^
  "'^SIGNAL_REQUIRE_LEADER_FOR_SMALL_BUY=.*$'='SIGNAL_REQUIRE_LEADER_FOR_SMALL_BUY=false';" ^
  "'^SIGNAL_MIN_CUMULATIVE_BUY_SOL=.*$'='SIGNAL_MIN_CUMULATIVE_BUY_SOL=10';" ^
  "'^SIGNAL_MIN_REAL_SOL_RESERVE=.*$'='SIGNAL_MIN_REAL_SOL_RESERVE=0.5';" ^
  "'^SIGNAL_MAX_REAL_SOL_RESERVE=.*$'='SIGNAL_MAX_REAL_SOL_RESERVE=60';" ^
  "'^SIGNAL_FULL_EXIT_ON_TARGET_SELL=.*$'='SIGNAL_FULL_EXIT_ON_TARGET_SELL=true';" ^
  "'^SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT=.*$'='SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT=4';" ^
  "'^SAFE_COPY_MAX_OPEN_POSITIONS=.*$'='SAFE_COPY_MAX_OPEN_POSITIONS=1';" ^
  "'^SAFE_COPY_ONE_BUY_PER_MINT=.*$'='SAFE_COPY_ONE_BUY_PER_MINT=true';" ^
  "'^SAFE_COPY_HARD_STOP_PERCENT=.*$'='SAFE_COPY_HARD_STOP_PERCENT=6';" ^
  "'^SAFE_COPY_TAKE_PROFIT_PERCENT=.*$'='SAFE_COPY_TAKE_PROFIT_PERCENT=9';" ^
  "'^SAFE_COPY_TRAILING_ACTIVATE_PERCENT=.*$'='SAFE_COPY_TRAILING_ACTIVATE_PERCENT=6';" ^
  "'^SAFE_COPY_TRAILING_PERCENT=.*$'='SAFE_COPY_TRAILING_PERCENT=2.5';" ^
  "'^SAFE_COPY_BREAKEVEN_ARM_PERCENT=.*$'='SAFE_COPY_BREAKEVEN_ARM_PERCENT=4';" ^
  "'^SAFE_COPY_BREAKEVEN_FLOOR_PERCENT=.*$'='SAFE_COPY_BREAKEVEN_FLOOR_PERCENT=1.5';" ^
  "'^SAFE_COPY_MAX_HOLD_MS=.*$'='SAFE_COPY_MAX_HOLD_MS=180000';" ^
  "'^TRAILING_STOP_ENABLED=.*$'='TRAILING_STOP_ENABLED=true';" ^
  "'^TRAILING_STOP_PERCENT=.*$'='TRAILING_STOP_PERCENT=5';" ^
  "'^DRY_RUN=.*$'='DRY_RUN=false';" ^
  "'^FAST_PUMP_ONLY=.*$'='FAST_PUMP_ONLY=true';" ^
  "'^TARGET_TX_FETCH_TIMEOUT_MS=.*$'='TARGET_TX_FETCH_TIMEOUT_MS=350';" ^
  "'^STATE_FILE=.*$'='STATE_FILE=cxkx-copy-v2-state.json';" ^
  "'^BOT_DISPLAY_NAME=.*$'='BOT_DISPLAY_NAME=CXKX COPY V2 FAST TEST'" ^
  "}; foreach($k in $r.Keys){$s=[regex]::Replace($s,$k,$r[$k],[System.Text.RegularExpressions.RegexOptions]::Multiline)};" ^
  "if($s -notmatch '(?m)^TARGET_TX_FETCH_TIMEOUT_MS='){ $s += \"`r`nTARGET_TX_FETCH_TIMEOUT_MS=350`r`n\" };" ^
  "Set-Content -Path $p -Value $s -Encoding UTF8"

if errorlevel 1 (
  echo ERROR: Could not build cxkx-copy-v2.env
  pause
  exit /b 1
)

echo.
echo Starting CXKX COPY V2...
echo.
node --env-file=cxkx-copy-v2.env --import tsx src/cxkx-copy-v2.ts

echo.
pause
