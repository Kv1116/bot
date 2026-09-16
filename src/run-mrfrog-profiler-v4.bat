@echo off
cd /d "%~dp0"

echo Profiling Mr Frog / TheMisterTurtle with BOT PROFILER V4...
echo PRE-BUY WINDOW FORENSICS - READ ONLY - no trade can be signed or sent.
echo.

set PROFILE_TARGET_WALLET=4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh
set PROFILE_TX_LIMIT=1000
set PROFILE_PREBUY_MINTS=80
set PROFILE_PREBUY_WINDOWS_SEC=10,30,60,180
set PROFILE_PREBUY_MAX_SIGS=1200
set PROFILE_PREBUY_PAGE_SIZE=100

rem V4 fast mode: do NOT repeat V3's multi-hour CREATE scan.
set PROFILE_DEEP_MINTS=0

set PROFILE_RPC_BATCH=5
set PROFILE_BATCH_DELAY_MS=650
set PROFILE_RPC_RETRIES=10
set PROFILE_RPC_BACKOFF_MS=1000
set PROFILE_RPC_MAX_BACKOFF_MS=12000
set PROFILE_OUT_DIR=profiler-output-v4

node --env-file=signal-sniper-v2.env --import tsx src/bot-profiler-v4.ts

echo.
pause
