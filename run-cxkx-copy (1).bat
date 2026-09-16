@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo                 CXKX COPY TEST
echo ============================================================
echo Target: CxkxCQYLWVRStkWwdCcsAX6BWcPnMeKGQ3zm2m6jVjV8
echo LIVE MODE - real trades, tiny 0.005 SOL test size.
echo.

if not exist "signal-sniper-v2.env" (
  echo ERROR: signal-sniper-v2.env not found in this folder.
  pause
  exit /b 1
)

if not exist "src\cxkx-copy.ts" (
  echo ERROR: src\cxkx-copy.ts not found.
  pause
  exit /b 1
)

copy /Y "signal-sniper-v2.env" "cxkx-copy.env" >nul

PowerShell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='cxkx-copy.env'; $s=Get-Content $p -Raw;" ^
  "$r=@{" ^
  "'^TARGET_WALLET=.*$'='TARGET_WALLET=CxkxCQYLWVRStkWwdCcsAX6BWcPnMeKGQ3zm2m6jVjV8';" ^
  "'^BUY_SOL=.*$'='BUY_SOL=0.005';" ^
  "'^BUY_USD=.*$'='BUY_USD=0.5';" ^
  "'^MAX_SOL_PER_TRADE=.*$'='MAX_SOL_PER_TRADE=0.005';" ^
  "'^SIGNAL_MIN_TARGET_BUY_SOL=.*$'='SIGNAL_MIN_TARGET_BUY_SOL=0.05';" ^
  "'^SIGNAL_MAX_TARGET_BUY_SOL=.*$'='SIGNAL_MAX_TARGET_BUY_SOL=1.5';" ^
  "'^SIGNAL_LEADER_MIN_BUY_SOL=.*$'='SIGNAL_LEADER_MIN_BUY_SOL=10';" ^
  "'^SIGNAL_CONFIRM_WINDOW_MS=.*$'='SIGNAL_CONFIRM_WINDOW_MS=300000';" ^
  "'^SIGNAL_REQUIRE_LEADER_FOR_SMALL_BUY=.*$'='SIGNAL_REQUIRE_LEADER_FOR_SMALL_BUY=false';" ^
  "'^SIGNAL_MIN_CUMULATIVE_BUY_SOL=.*$'='SIGNAL_MIN_CUMULATIVE_BUY_SOL=10';" ^
  "'^SIGNAL_MIN_REAL_SOL_RESERVE=.*$'='SIGNAL_MIN_REAL_SOL_RESERVE=0.5';" ^
  "'^SIGNAL_MAX_REAL_SOL_RESERVE=.*$'='SIGNAL_MAX_REAL_SOL_RESERVE=100';" ^
  "'^SIGNAL_FULL_EXIT_ON_TARGET_SELL=.*$'='SIGNAL_FULL_EXIT_ON_TARGET_SELL=true';" ^
  "'^SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT=.*$'='SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT=4';" ^
  "'^SAFE_COPY_MAX_OPEN_POSITIONS=.*$'='SAFE_COPY_MAX_OPEN_POSITIONS=1';" ^
  "'^SAFE_COPY_ONE_BUY_PER_MINT=.*$'='SAFE_COPY_ONE_BUY_PER_MINT=true';" ^
  "'^SAFE_COPY_HARD_STOP_PERCENT=.*$'='SAFE_COPY_HARD_STOP_PERCENT=7';" ^
  "'^SAFE_COPY_TAKE_PROFIT_PERCENT=.*$'='SAFE_COPY_TAKE_PROFIT_PERCENT=12';" ^
  "'^SAFE_COPY_TRAILING_ACTIVATE_PERCENT=.*$'='SAFE_COPY_TRAILING_ACTIVATE_PERCENT=7';" ^
  "'^SAFE_COPY_TRAILING_PERCENT=.*$'='SAFE_COPY_TRAILING_PERCENT=3';" ^
  "'^SAFE_COPY_BREAKEVEN_ARM_PERCENT=.*$'='SAFE_COPY_BREAKEVEN_ARM_PERCENT=5';" ^
  "'^SAFE_COPY_BREAKEVEN_FLOOR_PERCENT=.*$'='SAFE_COPY_BREAKEVEN_FLOOR_PERCENT=1.5';" ^
  "'^SAFE_COPY_MAX_HOLD_MS=.*$'='SAFE_COPY_MAX_HOLD_MS=300000';" ^
  "'^TRAILING_STOP_ENABLED=.*$'='TRAILING_STOP_ENABLED=true';" ^
  "'^TRAILING_STOP_PERCENT=.*$'='TRAILING_STOP_PERCENT=5';" ^
  "'^SLIPPAGE=.*$'='SLIPPAGE=4';" ^
  "'^SELL_SLIPPAGE=.*$'='SELL_SLIPPAGE=8';" ^
  "'^DRY_RUN=.*$'='DRY_RUN=false';" ^
  "'^FAST_PUMP_ONLY=.*$'='FAST_PUMP_ONLY=false';" ^
  "'^USE_ENHANCED_TRANSACTION_STREAM=.*$'='USE_ENHANCED_TRANSACTION_STREAM=false';" ^
  "'^STATE_FILE=.*$'='STATE_FILE=cxkx-copy-state.json';" ^
  "'^BOT_DISPLAY_NAME=.*$'='BOT_DISPLAY_NAME=CXKX COPY TEST'" ^
  "};" ^
  "foreach($k in $r.Keys){$s=[regex]::Replace($s,$k,$r[$k],[System.Text.RegularExpressions.RegexOptions]::Multiline)};" ^
  "Set-Content -Path $p -Value $s -Encoding UTF8"

if errorlevel 1 (
  echo ERROR: Could not create cxkx-copy.env
  pause
  exit /b 1
)

echo.
echo Created cxkx-copy.env from your working signal-sniper-v2.env.
echo Your RPC and BOT_SECRET_KEY_JSON were preserved locally.
echo.
echo Starting CXKX copy test...
echo.

node --env-file=cxkx-copy.env --import tsx src/cxkx-copy.ts

echo.
pause
