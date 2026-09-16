@echo off
cd /d "%~dp0"
set PROFILE_TARGET_WALLET=4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh
set PROFILE_RPC_BATCH=5
set PROFILE_BATCH_DELAY_MS=650
set PROFILE_RPC_RETRIES=10
set PROFILE_RPC_BACKOFF_MS=1000
set PROFILE_RPC_MAX_BACKOFF_MS=12000

echo Profiling Mr Frog / TheMisterTurtle in READ-ONLY mode...
echo 429-safe RPC mode: batch=5, delay=650ms, automatic exponential backoff.
node --env-file=signal-sniper-v2.env --import tsx src\bot-profiler-v2.ts
pause
