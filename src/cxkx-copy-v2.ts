import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  Logs,
  Commitment,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";

import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import BN from "bn.js";
import bs58 from "bs58";

import {
  PUMP_SDK,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  OnlinePumpSdk,
} from "@pump-fun/pump-sdk";

import {
  PUMP_AMM_SDK,
  OnlinePumpAmmSdk,
  canonicalPumpPoolPda,
} from "@pump-fun/pump-swap-sdk";

// ============================================================
// CONFIG
// ============================================================

const RPC_URL =
  process.env.RPC_URL ||
  "https://api.mainnet-beta.solana.com";

const RPC_WS =
  process.env.RPC_WS ||
  undefined;

const TARGET_WALLET =
  process.env.TARGET_WALLET ||
  "4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh";

const BUY_USD =
  Number(
    process.env.BUY_USD || "1",
  );

const SLIPPAGE =
  Number(
    process.env.SLIPPAGE || "8",
  );

const DRY_RUN =
  String(
    process.env.DRY_RUN || "true",
  ).toLowerCase() === "true";

const BUY_SOL_OVERRIDE =
  Number(
    process.env.BUY_SOL || "0",
  );

const MAX_SOL_PER_TRADE =
  Number(
    process.env.MAX_SOL_PER_TRADE || "0.02",
  );

const MIN_SOL_BALANCE =
  Number(
    process.env.MIN_SOL_BALANCE || "0.05",
  );

// Priority fee is optional. Keep 0 for no extra priority fee, or set a small
// value in .env when fast inclusion matters (for example 50000-100000).
// Solana's normal base transaction fee always exists.
const PRIORITY_FEE_MICROLAMPORTS =
  Math.max(
    0,
    Number(
      process.env.PRIORITY_FEE_MICROLAMPORTS || "0",
    ) || 0,
  );

// Pump BUY uses the same fire-and-forget multi-region propagation idea as
// TURBO SELL. This removes Sender HTTP acknowledgement time from the hot path
// and gives the signed transaction several independent routes immediately.
const TURBO_BUY_MULTI_REGION =
  String(
    process.env.TURBO_BUY_MULTI_REGION || "true",
  ).toLowerCase() !== "false";

const TURBO_BUY_USE_EVENT_RESERVES =
  String(
    process.env.TURBO_BUY_USE_EVENT_RESERVES || "true",
  ).toLowerCase() !== "false";

// SELL has a different objective from BUY: once the tracked wallet exits,
// getting out quickly matters more than preserving a tight entry-style quote.
// Keep BUY on SLIPPAGE / PRIORITY_FEE_MICROLAMPORTS and tune SELL separately.
const SELL_SLIPPAGE =
  Math.max(
    SLIPPAGE,
    Number(
      process.env.SELL_SLIPPAGE || "8",
    ) || 8,
  );

const SELL_PRIORITY_FEE_MICROLAMPORTS =
  Math.max(
    PRIORITY_FEE_MICROLAMPORTS,
    Number(
      process.env.SELL_PRIORITY_FEE_MICROLAMPORTS || "150000",
    ) || 150000,
  );

const TURBO_SELL_SKIP_PRE_BALANCE =
  String(
    process.env.TURBO_SELL_SKIP_PRE_BALANCE || "true",
  ).toLowerCase() !== "false";

const TURBO_SELL_MULTI_REGION =
  String(
    process.env.TURBO_SELL_MULTI_REGION || "true",
  ).toLowerCase() !== "false";

// ============================================================
// HELIUS SENDER / SWQOS
// ============================================================
// Sender is available on all Helius plans and does not consume API credits.
// SWQOS-only requires a minimum 5,000-lamport SOL tip inside the transaction.
// A non-zero priority fee is strongly recommended and is required by Helius
// Sender docs for the optimized trading path. If priority fee is 0, the bot
// safely falls back to the normal RPC sender instead of building a tipped tx
// that Sender may reject.
const HELIUS_SENDER_ENABLED =
  String(
    process.env.HELIUS_SENDER_ENABLED || "true",
  ).toLowerCase() !== "false";

const HELIUS_SENDER_URL =
  String(
    process.env.HELIUS_SENDER_URL ||
      "http://fra-sender.helius-rpc.com/fast?swqos_only=true",
  ).trim();

const HELIUS_SENDER_TIP_LAMPORTS =
  Math.max(
    5_000,
    Number(
      process.env.HELIUS_SENDER_TIP_LAMPORTS || "5000",
    ) || 5_000,
  );

const BUY_SENDER_TIP_LAMPORTS =
  Math.max(
    HELIUS_SENDER_TIP_LAMPORTS,
    Number(
      process.env.BUY_SENDER_TIP_LAMPORTS || String(HELIUS_SENDER_TIP_LAMPORTS),
    ) || HELIUS_SENDER_TIP_LAMPORTS,
  );

const SELL_SENDER_TIP_LAMPORTS =
  Math.max(
    HELIUS_SENDER_TIP_LAMPORTS,
    Number(
      process.env.SELL_SENDER_TIP_LAMPORTS || "10000",
    ) || 10_000,
  );

// The exact same signed BUY can also be broadcast to several Sender regions.
// This does not create duplicate fills: identical signatures are de-duplicated
// by Solana. The first propagation path to reach a validator wins.
const BUY_SENDER_URLS =
  String(
    process.env.BUY_SENDER_URLS ||
      `${HELIUS_SENDER_URL},http://ams-sender.helius-rpc.com/fast?swqos_only=true,http://lon-sender.helius-rpc.com/fast?swqos_only=true`,
  )
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

// For a time-critical SELL, the exact same signed transaction can be broadcast
// to several Sender regions. Only one copy can execute because every copy has
// the same signature, so the on-chain tip/fee is charged only once if it lands.
const SELL_SENDER_URLS =
  String(
    process.env.SELL_SENDER_URLS ||
      `${HELIUS_SENDER_URL},http://ams-sender.helius-rpc.com/fast?swqos_only=true,http://lon-sender.helius-rpc.com/fast?swqos_only=true`,
  )
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

const HELIUS_SENDER_HTTP_TIMEOUT_MS =
  Math.max(
    200,
    Number(
      process.env.HELIUS_SENDER_HTTP_TIMEOUT_MS || "900",
    ) || 900,
  );

const HELIUS_SENDER_PING_INTERVAL_MS =
  Math.max(
    5_000,
    Number(
      process.env.HELIUS_SENDER_PING_INTERVAL_MS || "5000",
    ) || 5_000,
  );

const HELIUS_SENDER_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
].map(value => new PublicKey(value));

// Skip RPC preflight simulation to minimize client-side latency.
// On-chain failures are still detected from signature status / balance checks.
const SKIP_PREFLIGHT =
  true;

// Event-driven own-transaction settlement.
// We wait for our signature to reach processed over WebSocket, then do only
// a handful of balance reads. This avoids hammering free-tier RPC endpoints
// and prevents 429 rate limits from delaying the target SELL path.
const SIGNATURE_PROCESSED_TIMEOUT_MS =
  1_500;

const SIGNATURE_CONFIRMED_TIMEOUT_MS =
  12_000;

// Keep wallet-balance verification intentionally light. On the free Helius
// tier aggressive polling can cause HTTP 429 and actually make copy trading
// slower. WebSocket signature notifications do the waiting; RPC is used only
// for a few state reads after the transaction has landed.
const BALANCE_READ_RETRIES =
  3;

const BALANCE_READ_DELAY_MS =
  180;

const BLOCKHASH_CACHE_MS =
  8_000;

const PUMP_GLOBAL_CACHE_MS =
  30_000;

// ============================================================
// ULTRA-FAST TARGET STREAM
// ============================================================
// Helius transactionSubscribe can deliver the full parsed transaction at
// processed commitment, eliminating the extra getParsedTransaction() RPC
// round-trip from the normal hot path. If the endpoint/account does not
// support it, the bot automatically falls back to standard onLogs.
const USE_ENHANCED_TRANSACTION_STREAM =
  String(
    process.env.USE_ENHANCED_TRANSACTION_STREAM || "true",
  ).toLowerCase() !== "false";

// Fastest free-tier mode: only direct Pump.fun trades that expose a TradeEvent
// are queued. Unknown/Jupiter/PumpSwap fallback transactions are ignored instead
// of spending ~1s on getParsedTransaction(). This also prevents a slow non-trade
// from blocking a later Pump BUY/SELL in the strict execution queue.
const FAST_PUMP_ONLY =
  String(
    process.env.FAST_PUMP_ONLY || "true",
  ).toLowerCase() !== "false";

// Autonomous exit: after a copied Pump.fun BUY, subscribe directly to the
// bonding-curve account and track the best executable SELL price. If price
// falls by this percentage from the local peak, sell immediately without
// waiting for the target wallet to sell.
const TRAILING_STOP_ENABLED =
  String(
    process.env.TRAILING_STOP_ENABLED || "true",
  ).toLowerCase() !== "false";

const TRAILING_STOP_PERCENT =
  Math.max(
    0.1,
    Number(
      process.env.TRAILING_STOP_PERCENT || "5",
    ) || 5,
  );

// ============================================================
// SAFE COPY MODE
// ============================================================
// This mode is deliberately selective. It cannot guarantee a profit, but it
// refuses copied entries where the target's own BUY has already moved the Pump
// curve too far, limits exposure, and uses profit-aware autonomous exits.
const SAFE_COPY_MODE =
  String(
    process.env.SAFE_COPY_MODE || "true",
  ).toLowerCase() !== "false";

const SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT =
  Math.max(
    0,
    Number(
      process.env.SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT || "4",
    ) || 4,
  );

const SAFE_COPY_MAX_OPEN_POSITIONS =
  Math.max(
    1,
    Number(
      process.env.SAFE_COPY_MAX_OPEN_POSITIONS || "1",
    ) || 1,
  );

const SAFE_COPY_ONE_BUY_PER_MINT =
  String(
    process.env.SAFE_COPY_ONE_BUY_PER_MINT || "true",
  ).toLowerCase() !== "false";

const SAFE_COPY_HARD_STOP_PERCENT =
  Math.max(
    0.5,
    Number(
      process.env.SAFE_COPY_HARD_STOP_PERCENT || "6",
    ) || 6,
  );

const SAFE_COPY_TAKE_PROFIT_PERCENT =
  Math.max(
    0.5,
    Number(
      process.env.SAFE_COPY_TAKE_PROFIT_PERCENT || "10",
    ) || 10,
  );

const SAFE_COPY_TRAILING_ACTIVATE_PERCENT =
  Math.max(
    0.5,
    Number(
      process.env.SAFE_COPY_TRAILING_ACTIVATE_PERCENT || "7",
    ) || 7,
  );

const SAFE_COPY_TRAILING_PERCENT =
  Math.max(
    0.5,
    Number(
      process.env.SAFE_COPY_TRAILING_PERCENT || "3",
    ) || 3,
  );

const SAFE_COPY_BREAKEVEN_ARM_PERCENT =
  Math.max(
    0.5,
    Number(
      process.env.SAFE_COPY_BREAKEVEN_ARM_PERCENT || "5",
    ) || 5,
  );

// Keep a positive cushion rather than aiming for literal 0%, because network,
// priority, Sender and protocol fees make a displayed break-even quote unsafe.
const SAFE_COPY_BREAKEVEN_FLOOR_PERCENT =
  Math.max(
    0,
    Number(
      process.env.SAFE_COPY_BREAKEVEN_FLOOR_PERCENT || "2",
    ) || 2,
  );

// ============================================================
// SIGNAL-SNIPER FILTERS
// ============================================================
// The watched wallet is the signal source. Large first BUYs can move the curve
// too far for us to safely chase. In that case we arm the mint and wait for the
// target wallet to BUY the same mint again. A later add-on BUY acts as
// confirmation and is allowed only when the new post-trade premium is acceptable.
const SIGNAL_MIN_TARGET_BUY_SOL =
  Math.max(
    0,
    Number(
      process.env.SIGNAL_MIN_TARGET_BUY_SOL || "0.8",
    ) || 0.8,
  );

const SIGNAL_MAX_TARGET_BUY_SOL =
  Math.max(
    SIGNAL_MIN_TARGET_BUY_SOL,
    Number(
      process.env.SIGNAL_MAX_TARGET_BUY_SOL || "6",
    ) || 6,
  );

const SIGNAL_LEADER_MIN_BUY_SOL =
  Math.max(
    SIGNAL_MIN_TARGET_BUY_SOL,
    Number(
      process.env.SIGNAL_LEADER_MIN_BUY_SOL || "2",
    ) || 2,
  );

const SIGNAL_CONFIRM_WINDOW_MS =
  Math.max(
    500,
    Number(
      process.env.SIGNAL_CONFIRM_WINDOW_MS || "180000",
    ) || 180000,
  );

const SIGNAL_REQUIRE_LEADER_FOR_SMALL_BUY =
  String(
    process.env.SIGNAL_REQUIRE_LEADER_FOR_SMALL_BUY || "true",
  ).toLowerCase() !== "false";

const SIGNAL_MIN_CUMULATIVE_BUY_SOL =
  Math.max(
    SIGNAL_LEADER_MIN_BUY_SOL,
    Number(
      process.env.SIGNAL_MIN_CUMULATIVE_BUY_SOL || "2.5",
    ) || 2.5,
  );

const SIGNAL_MIN_REAL_SOL_RESERVE =
  Math.max(
    0,
    Number(
      process.env.SIGNAL_MIN_REAL_SOL_RESERVE || "0.5",
    ) || 0.5,
  );

const SIGNAL_MAX_REAL_SOL_RESERVE =
  Math.max(
    SIGNAL_MIN_REAL_SOL_RESERVE,
    Number(
      process.env.SIGNAL_MAX_REAL_SOL_RESERVE || "25",
    ) || 25,
  );

// If the signal wallet starts selling, the safest latency-oriented response is
// to exit our entire tracked position instead of copying a partial percentage.
const SIGNAL_FULL_EXIT_ON_TARGET_SELL =
  String(
    process.env.SIGNAL_FULL_EXIT_ON_TARGET_SELL || "true",
  ).toLowerCase() !== "false";

// Hard time cap for this scalp strategy. 0 disables the timer.
const SAFE_COPY_MAX_HOLD_MS =
  Math.max(
    0,
    Number(
      process.env.SAFE_COPY_MAX_HOLD_MS || "20000",
    ) || 0,
  );

const TRAILING_PRICE_SCALE =
  new BN("1000000000000000000");

const ENHANCED_SUBSCRIBE_TIMEOUT_MS =
  2_000;

const ENHANCED_HEARTBEAT_MS =
  30_000;


// Console branding only. This does not affect trading logic.
const BOT_DISPLAY_NAME =
  String(
    process.env.BOT_DISPLAY_NAME ||
      "SIGNAL SNIPER",
  ).trim() || "SIGNAL SNIPER";

// Optional. If present, the bot uses Jupiter Swap V2 (/order + /execute).
// Without a key it automatically uses the free Jupiter lite Swap V1 API.
const JUPITER_API_KEY =
  String(
    process.env.JUPITER_API_KEY || "",
  ).trim();

const JUPITER_V2_API_BASE =
  String(
    process.env.JUPITER_V2_API_BASE ||
      "https://api.jup.ag/swap/v2",
  ).replace(/\/+$/, "");

const JUPITER_V1_API_BASE =
  String(
    process.env.JUPITER_V1_API_BASE ||
      (JUPITER_API_KEY
        ? "https://api.jup.ag/swap/v1"
        : "https://lite-api.jup.ag/swap/v1"),
  ).replace(/\/+$/, "");

// Jupiter V2 already has RTSE (automatic slippage). Keep it enabled by
// default so all routing engines remain eligible. Set this to true only if
// you explicitly want the .env SLIPPAGE value sent to /order.
const JUPITER_V2_USE_MANUAL_SLIPPAGE =
  String(
    process.env.JUPITER_V2_USE_MANUAL_SLIPPAGE || "false",
  ).toLowerCase() === "true";

// Small retry/timeout guard so a temporary Jupiter HTTP problem does not
// instantly kill a copy attempt.
const JUPITER_HTTP_TIMEOUT_MS = 12_000;
const JUPITER_HTTP_RETRIES = 2;

const STATE_FILE_BASE =
  process.env.STATE_FILE ||
  path.resolve(
    process.cwd(),
    "state.json",
  );

// Keep simulated positions completely separate from live positions.
// This prevents old DRY_RUN token amounts from ever being reused when
// DRY_RUN is later changed to false.
const STATE_FILE =
  DRY_RUN
    ? path.join(
        path.dirname(STATE_FILE_BASE),
        `${path.basename(
          STATE_FILE_BASE,
          path.extname(STATE_FILE_BASE),
        )}.dry-run${path.extname(STATE_FILE_BASE)}`,
      )
    : STATE_FILE_BASE;

const WS_COMMITMENT:
  Commitment = "processed";

// ============================================================
// PROGRAM IDS
// ============================================================

const PUMP_PROGRAM_ID =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const PUMP_AMM_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const JUPITER_V6_PROGRAM_ID =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

// Pump fee-sharing program.
// Transactions using this program are NOT trades by themselves.
const PUMP_FEE_PROGRAM_ID =
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";

// ============================================================
// QUOTE ASSETS
// ============================================================

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Common stablecoins are treated as quote assets. This prevents a Jupiter
// meme -> stablecoin exit from being mistaken for a token -> token rotation
// where the bot would unnecessarily BUY the stablecoin as a new position.
const USDT_MINT =
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const PYUSD_MINT =
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";

const USDG_MINT =
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";

const QUOTE_MINTS =
  new Set<string>([
    WSOL_MINT,
    USDC_MINT,
    USDT_MINT,
    PYUSD_MINT,
    USDG_MINT,
  ]);

// ============================================================
// CONNECTION
// ============================================================

const connection =
  new Connection(
    RPC_URL,
    {
      commitment:
        WS_COMMITMENT,

      wsEndpoint:
        RPC_WS,
    },
  );

const pumpAmm =
  new OnlinePumpAmmSdk(
    connection,
  );

const pumpOnline =
  new OnlinePumpSdk(
    connection,
  );

// ============================================================
// FAST CACHE LAYER
// ============================================================

let cachedLatestBlockhash:
  {
    blockhash: string;
    lastValidBlockHeight: number;
    fetchedAt: number;
  } | null = null;

async function getFastLatestBlockhash(): Promise<{
  blockhash: string;
  lastValidBlockHeight: number;
}> {
  const now =
    Date.now();

  if (
    cachedLatestBlockhash &&
    now - cachedLatestBlockhash.fetchedAt <
      BLOCKHASH_CACHE_MS
  ) {
    return {
      blockhash:
        cachedLatestBlockhash.blockhash,
      lastValidBlockHeight:
        cachedLatestBlockhash.lastValidBlockHeight,
    };
  }

  const latest =
    await connection.getLatestBlockhash(
      "processed",
    );

  cachedLatestBlockhash = {
    ...latest,
    fetchedAt:
      now,
  };

  return latest;
}

let cachedPumpGlobal:
  any | null =
  null;

let cachedPumpGlobalAt =
  0;

async function getPumpGlobalCached(): Promise<any> {
  const now =
    Date.now();

  if (
    cachedPumpGlobal &&
    now - cachedPumpGlobalAt <
      PUMP_GLOBAL_CACHE_MS
  ) {
    return cachedPumpGlobal;
  }

  const global =
    await pumpOnline.fetchGlobal();

  cachedPumpGlobal =
    global;

  cachedPumpGlobalAt =
    now;

  return global;
}

const mintProgramCache =
  new Map<
    string,
    PublicKey
  >();

interface FastPumpSellContext {
  accountInfo: any;
  bondingCurve: any;
  tokenProgram: PublicKey;
  associatedUserAccountInfo?: any | null;
  cachedAtMs: number;
}

// Static Pump curve metadata is learned during BUY. When a later target SELL
// arrives through TradeEvent, its post-trade reserve fields can be overlaid on
// this cached object so the SELL instruction can be built without waiting for
// another getAccountInfo round-trip.
const fastPumpSellContextCache =
  new Map<string, FastPumpSellContext>();

function cacheFastPumpSellContext(
  mintString: string,
  curve: {
    accountInfo: any | null;
    bondingCurve: any | null;
  },
  tokenProgram: PublicKey,
  associatedUserAccountInfo?: any | null,
): void {
  if (
    !curve.accountInfo ||
    !curve.bondingCurve
  ) {
    return;
  }

  fastPumpSellContextCache.set(
    mintString,
    {
      accountInfo:
        curve.accountInfo,
      bondingCurve: {
        ...curve.bondingCurve,
      },
      tokenProgram,
      associatedUserAccountInfo,
      cachedAtMs:
        Date.now(),
    },
  );
}

interface TrailingStopTracker {
  subscriptionId: number | null;
  peakPriceScaled: BN | null;
  peakQuoteLamports: BN | null;
  tokenProgram: PublicKey;
  global: any;
  triggered: boolean;
  trailingArmed: boolean;
  breakEvenArmed: boolean;
}

interface TargetSignalState {
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  buyCount: number;
  cumulativeBuySol: number;
  leaderSeen: boolean;
  leaderBuySol: number;
  lastPremiumBps: number | null;
}

const targetSignalStates =
  new Map<string, TargetSignalState>();

function pruneTargetSignalStates(
  now = Date.now(),
): void {
  const ttl =
    Math.max(
      SIGNAL_CONFIRM_WINDOW_MS * 4,
      60_000,
    );

  for (const [mint, state] of targetSignalStates) {
    if (now - state.lastSeenAtMs > ttl) {
      targetSignalStates.delete(mint);
    }
  }
}

const trailingStopTrackers =
  new Map<string, TrailingStopTracker>();

// Prevent an autonomous trailing SELL and a copied target SELL from racing
// each other for the same mint.
const sellExecutionLocks =
  new Set<string>();

const safeCopyHoldTimers =
  new Map<string, ReturnType<typeof setTimeout>>();

function clearSafeCopyHoldTimer(
  mintString: string,
): void {
  const timer =
    safeCopyHoldTimers.get(
      mintString,
    );

  if (timer) {
    clearTimeout(
      timer,
    );
    safeCopyHoldTimers.delete(
      mintString,
    );
  }
}

function scheduleSafeCopyMaxHold(
  mintString: string,
): void {
  if (
    !SAFE_COPY_MODE ||
    DRY_RUN ||
    SAFE_COPY_MAX_HOLD_MS <= 0
  ) {
    return;
  }

  clearSafeCopyHoldTimer(
    mintString,
  );

  const timer =
    setTimeout(
      () => {
        safeCopyHoldTimers.delete(
          mintString,
        );

        void (async () => {
          const position =
            getPosition(
              mintString,
            );

          const tracker =
            trailingStopTrackers.get(
              mintString,
            );

          if (
            !position ||
            !tracker ||
            tracker.triggered ||
            sellExecutionLocks.has(
              mintString,
            )
          ) {
            return;
          }

          try {
            const mint =
              new PublicKey(
                mintString,
              );

            const curveAddress =
              bondingCurvePda(
                mint,
              );

            const accountInfo =
              await connection.getAccountInfo(
                curveAddress,
                "processed",
              );

            if (!accountInfo) {
              return;
            }

            const bondingCurve =
              PUMP_SDK.decodeBondingCurveNullable(
                accountInfo,
              );

            if (
              !bondingCurve ||
              bondingCurve.complete
            ) {
              return;
            }

            await triggerTrailingStopSell(
              mintString,
              accountInfo,
              bondingCurve,
              -1,
              "MAX_HOLD",
              null,
            );
          } catch (error) {
            console.log(
              `MAX_HOLD exit check failed for ${mintString}:`,
              error,
            );
          }
        })();
      },
      SAFE_COPY_MAX_HOLD_MS,
    );

  safeCopyHoldTimers.set(
    mintString,
    timer,
  );
}

async function stopTrailingStopForMint(
  mintString: string,
): Promise<void> {
  clearSafeCopyHoldTimer(
    mintString,
  );

  const tracker =
    trailingStopTrackers.get(
      mintString,
    );

  if (!tracker) {
    return;
  }

  trailingStopTrackers.delete(
    mintString,
  );

  if (
    tracker.subscriptionId !== null
  ) {
    try {
      await connection.removeAccountChangeListener(
        tracker.subscriptionId,
      );
    } catch {
      // Ignore listener cleanup races during shutdown/close.
    }
  }
}

function trailingPriceScaled(
  expectedSolLamports: BN,
  tokenAmount: BN,
): BN {
  if (tokenAmount.isZero()) {
    return new BN(0);
  }

  return expectedSolLamports
    .mul(
      TRAILING_PRICE_SCALE,
    )
    .div(
      tokenAmount,
    );
}

function safeCopyOpenPositionCount(): number {
  return Object.values(
    persistentState.positions,
  ).filter(
    position =>
      new BN(
        position.botRaw || "0",
      ).gt(
        new BN(0),
      ),
  ).length;
}

function directPumpEntryPremiumBps(
  trade: DetectedTradeLeg,
): number | null {
  if (
    trade.direction !== "BUY" ||
    trade.venue !== "Pump.fun" ||
    !trade.pumpSolAmount ||
    !trade.pumpVirtualSolReserves ||
    !trade.pumpVirtualTokenReserves ||
    trade.pumpSolAmount.isZero() ||
    trade.rawAmount.isZero() ||
    trade.pumpVirtualTokenReserves.isZero()
  ) {
    return null;
  }

  // Compare the curve's post-target marginal price with the target's average
  // execution price. This is the core copy-trading disadvantage: a large
  // target BUY can move the curve before we are even able to react.
  const numerator =
    trade.pumpVirtualSolReserves.mul(
      trade.rawAmount,
    );

  const denominator =
    trade.pumpVirtualTokenReserves.mul(
      trade.pumpSolAmount,
    );

  if (denominator.isZero()) {
    return null;
  }

  const ratioBps =
    numerator
      .muln(10_000)
      .div(denominator)
      .toNumber();

  return Math.max(
    0,
    ratioBps - 10_000,
  );
}

function safeCopyEntryAllowed(
  trade: DetectedTradeLeg,
  tx: any = null,
): { allowed: boolean; reason: string; premiumBps: number | null } {
  if (!SAFE_COPY_MODE) {
    return {
      allowed: true,
      reason: "SAFE_COPY_MODE disabled",
      premiumBps: null,
    };
  }

  if (
    trade.direction !== "BUY" ||
    (trade.venue !== "Pump.fun" && trade.venue !== "PumpSwap")
  ) {
    return {
      allowed: false,
      reason: "CXKX SAFE COPY accepts only direct Pump.fun / PumpSwap BUY trades",
      premiumBps: null,
    };
  }

  const now = Date.now();
  pruneTargetSignalStates(now);

  let targetBuySol = 0;
  let premiumBps: number | null = null;

  if (trade.venue === "Pump.fun") {
    if (!trade.pumpSolAmount) {
      return {
        allowed: false,
        reason: "Pump.fun signal BUY has no SOL amount",
        premiumBps: null,
      };
    }

    targetBuySol =
      Number(trade.pumpSolAmount.toString(10)) / LAMPORTS_PER_SOL;
    premiumBps = directPumpEntryPremiumBps(trade);
  } else {
    // PumpSwap TradeEvent does not expose the same Pump.fun reserve fields.
    // For this dedicated Cxkx copy mode, use the watched wallet's native SOL
    // decrease in the confirmed target transaction as the target entry size.
    // This includes a small amount of fees/tips, which is acceptable for the
    // coarse min/max signal-size filter.
    const spentLamports = getNativeSolSpentByOwner(tx, TARGET_WALLET);
    targetBuySol = Number(spentLamports.toString(10)) / LAMPORTS_PER_SOL;

    if (!(targetBuySol > 0)) {
      return {
        allowed: false,
        reason: "PumpSwap BUY target SOL spend could not be verified",
        premiumBps: null,
      };
    }
  }

  let signalState = targetSignalStates.get(trade.mint);

  if (
    signalState &&
    now - signalState.lastSeenAtMs > SIGNAL_CONFIRM_WINDOW_MS
  ) {
    targetSignalStates.delete(trade.mint);
    signalState = undefined;
  }

  if (!signalState) {
    signalState = {
      firstSeenAtMs: now,
      lastSeenAtMs: now,
      buyCount: 0,
      cumulativeBuySol: 0,
      leaderSeen: false,
      leaderBuySol: 0,
      lastPremiumBps: null,
    };
  }

  signalState.buyCount += 1;
  signalState.cumulativeBuySol += targetBuySol;
  signalState.lastSeenAtMs = now;
  signalState.lastPremiumBps = premiumBps;

  if (targetBuySol >= SIGNAL_LEADER_MIN_BUY_SOL) {
    signalState.leaderSeen = true;
    signalState.leaderBuySol = Math.max(
      signalState.leaderBuySol,
      targetBuySol,
    );
  }

  targetSignalStates.set(trade.mint, signalState);

  if (
    targetBuySol < SIGNAL_MIN_TARGET_BUY_SOL ||
    targetBuySol > SIGNAL_MAX_TARGET_BUY_SOL
  ) {
    return {
      allowed: false,
      reason: `target BUY ${targetBuySol.toFixed(3)} SOL is outside ${SIGNAL_MIN_TARGET_BUY_SOL}-${SIGNAL_MAX_TARGET_BUY_SOL} SOL signal range`,
      premiumBps,
    };
  }

  if (trade.venue === "Pump.fun" && trade.pumpRealSolReserves) {
    const realReserveSol =
      Number(trade.pumpRealSolReserves.toString(10)) / LAMPORTS_PER_SOL;

    if (
      realReserveSol < SIGNAL_MIN_REAL_SOL_RESERVE ||
      realReserveSol > SIGNAL_MAX_REAL_SOL_RESERVE
    ) {
      return {
        allowed: false,
        reason: `post-signal real SOL reserve ${realReserveSol.toFixed(3)} is outside ${SIGNAL_MIN_REAL_SOL_RESERVE}-${SIGNAL_MAX_REAL_SOL_RESERVE} SOL`,
        premiumBps,
      };
    }
  }

  if (SAFE_COPY_ONE_BUY_PER_MINT && getPosition(trade.mint)) {
    return {
      allowed: false,
      reason: "SAFE COPY already has a position in this mint",
      premiumBps,
    };
  }

  if (
    !getPosition(trade.mint) &&
    safeCopyOpenPositionCount() >= SAFE_COPY_MAX_OPEN_POSITIONS
  ) {
    return {
      allowed: false,
      reason: `SAFE COPY max open positions reached (${SAFE_COPY_MAX_OPEN_POSITIONS})`,
      premiumBps,
    };
  }

  // PumpSwap does not provide the direct Pump.fun curve premium inputs.
  // We still require a bounded target trade size, one open position max,
  // and immediate full exit on the target's first SELL.
  if (trade.venue === "PumpSwap") {
    return {
      allowed: true,
      reason: `PumpSwap direct copy: target spent ~${targetBuySol.toFixed(3)} SOL; size filter passed`,
      premiumBps: null,
    };
  }

  if (premiumBps === null) {
    return {
      allowed: false,
      reason: "SAFE COPY could not verify target-vs-post-trade entry premium",
      premiumBps: null,
    };
  }

  const maxBps =
    Math.round(SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT * 100);

  if (
    signalState.buyCount === 1 &&
    signalState.leaderSeen &&
    premiumBps > maxBps
  ) {
    return {
      allowed: false,
      reason: `leader BUY ${targetBuySol.toFixed(3)} SOL armed mint; entry premium ${(premiumBps / 100).toFixed(2)}% is too high, waiting up to ${(SIGNAL_CONFIRM_WINDOW_MS / 1000).toFixed(1)}s for target confirmation`,
      premiumBps,
    };
  }

  if (
    SIGNAL_REQUIRE_LEADER_FOR_SMALL_BUY &&
    targetBuySol < SIGNAL_LEADER_MIN_BUY_SOL &&
    !signalState.leaderSeen
  ) {
    return {
      allowed: false,
      reason: `small target BUY ${targetBuySol.toFixed(3)} SOL seen without a prior >=${SIGNAL_LEADER_MIN_BUY_SOL.toFixed(2)} SOL leader BUY`,
      premiumBps,
    };
  }

  if (
    signalState.leaderSeen &&
    signalState.buyCount >= 2 &&
    signalState.cumulativeBuySol < SIGNAL_MIN_CUMULATIVE_BUY_SOL
  ) {
    return {
      allowed: false,
      reason: `target sequence cumulative BUY ${signalState.cumulativeBuySol.toFixed(3)} SOL is below ${SIGNAL_MIN_CUMULATIVE_BUY_SOL.toFixed(3)} SOL`,
      premiumBps,
    };
  }

  if (premiumBps > maxBps) {
    return {
      allowed: false,
      reason: `entry premium ${(premiumBps / 100).toFixed(2)}% exceeds ${SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT.toFixed(2)}% limit; mint remains armed while confirmation window is active`,
      premiumBps,
    };
  }

  const isConfirmation =
    signalState.leaderSeen &&
    signalState.buyCount >= 2;

  return {
    allowed: true,
    reason: isConfirmation
      ? `CONFIRMED target sequence: buy #${signalState.buyCount}, current BUY ${targetBuySol.toFixed(3)} SOL, cumulative ${signalState.cumulativeBuySol.toFixed(3)} SOL, premium ${(premiumBps / 100).toFixed(2)}%`
      : `direct target BUY ${targetBuySol.toFixed(3)} SOL; entry premium ${(premiumBps / 100).toFixed(2)}% is within limit`,
    premiumBps,
  };
}

async function triggerTrailingStopSell(
  mintString: string,
  accountInfo: any,
  bondingCurve: any,
  drawdownBps: number,
  reason = "TRAILING_STOP",
  pnlBps: number | null = null,
): Promise<void> {
  const tracker =
    trailingStopTrackers.get(
      mintString,
    );

  if (
    !tracker ||
    tracker.triggered ||
    sellExecutionLocks.has(
      mintString,
    )
  ) {
    return;
  }

  const position =
    getPosition(
      mintString,
    );

  if (!position) {
    await stopTrailingStopForMint(
      mintString,
    );
    return;
  }

  const botAmount =
    new BN(
      position.botRaw,
    );

  if (botAmount.isZero()) {
    await stopTrailingStopForMint(
      mintString,
    );
    return;
  }

  tracker.triggered =
    true;

  sellExecutionLocks.add(
    mintString,
  );

  const triggerAtMs =
    Date.now();

  section(
    SAFE_COPY_MODE
      ? "AUTONOMOUS SAFE SELL"
      : "AUTONOMOUS TRAILING SELL",
    ANSI.red,
  );

  kv(
    "Mint",
    mintString,
  );

  kv(
    "Exit reason",
    reason,
  );

  if (pnlBps !== null) {
    kv(
      "Executable P/L vs trade SOL",
      `${(pnlBps / 100).toFixed(2)}%`,
    );
  }

  if (drawdownBps >= 0) {
    kv(
      "Trailing drawdown",
      `${(drawdownBps / 100).toFixed(2)}%`,
    );
  }

  kv(
    "Bot sells",
    botAmount.toString(),
  );

  try {
    const mint =
      new PublicKey(
        mintString,
      );

    // Autonomous exits are not tied to a target-wallet notification. Clear
    // that latency origin so sendInstructions does not print a stale target
    // latency number from a previous copied trade.
    const previousObservedAt =
      currentTradeObservedAtMs;

    currentTradeObservedAtMs =
      null;

    let signature:
      string | null = null;

    try {
      signature =
        await copyPumpBondingCurveSell(
          mint,
          getBotWallet(),
          botAmount,
          {
            exists:
              true,
            complete:
              Boolean(
                bondingCurve.complete,
              ),
            accountInfo,
            bondingCurve,
          },
          tracker.tokenProgram,
        );
    } finally {
      currentTradeObservedAtMs =
        previousObservedAt;
    }

    if (!signature) {
      throw new Error(
        "Trailing SELL did not return a transaction signature.",
      );
    }

    console.log(
      `LATENCY trailing trigger -> SELL broadcast: ${Date.now() - triggerAtMs} ms`,
    );

    await waitForSignatureProcessed(
      signature,
      "TRAILING SELL",
    );

    const currentPosition =
      getPosition(
        mintString,
      );

    if (currentPosition) {
      const closed =
        updateSellPosition(
          mintString,
          new BN(
            currentPosition.targetRaw,
          ),
          new BN(
            currentPosition.botRaw,
          ),
        );

      if (closed) {
        status(
          SAFE_COPY_MODE
            ? `SAFE EXIT executed (${reason}) - position fully closed.`
            : "TRAILING STOP executed - position fully closed.",
          "success",
        );
      }
    }

    await stopTrailingStopForMint(
      mintString,
    );
  } catch (error) {
    tracker.triggered =
      false;

    console.error(
      `TRAILING STOP SELL FAILED for ${mintString}:`,
      error,
    );
  } finally {
    sellExecutionLocks.delete(
      mintString,
    );
  }
}

async function startTrailingStopForMint(
  mintString: string,
): Promise<void> {
  if (
    !TRAILING_STOP_ENABLED ||
    DRY_RUN ||
    trailingStopTrackers.has(
      mintString,
    ) ||
    !getPosition(
      mintString,
    )
  ) {
    return;
  }

  try {
    const mint =
      new PublicKey(
        mintString,
      );

    const tokenProgram =
      mintProgramCache.get(
        mintString,
      ) ||
      await getMintTokenProgram(
        mint,
      );

    const global =
      await getPumpGlobalCached();

    const tracker:
      TrailingStopTracker = {
        subscriptionId:
          null,
        peakPriceScaled:
          null,
        peakQuoteLamports:
          null,
        tokenProgram,
        global,
        triggered:
          false,
        trailingArmed:
          !SAFE_COPY_MODE,
        breakEvenArmed:
          false,
      };

    trailingStopTrackers.set(
      mintString,
      tracker,
    );

    const curveAddress =
      bondingCurvePda(
        mint,
      );

    const evaluate =
      (accountInfo: any): void => {
        const activeTracker =
          trailingStopTrackers.get(
            mintString,
          );

        if (
          !activeTracker ||
          activeTracker.triggered
        ) {
          return;
        }

        const position =
          getPosition(
            mintString,
          );

        if (!position) {
          void stopTrailingStopForMint(
            mintString,
          );
          return;
        }

        let bondingCurve:
          any | null = null;

        try {
          bondingCurve =
            PUMP_SDK.decodeBondingCurveNullable(
              accountInfo,
            );
        } catch {
          return;
        }

        if (
          !bondingCurve ||
          bondingCurve.complete
        ) {
          return;
        }

        const botAmount =
          new BN(
            position.botRaw,
          );

        if (botAmount.isZero()) {
          return;
        }

        let expectedSol:
          BN;

        try {
          expectedSol =
            getSellSolAmountFromTokenAmount({
              global:
                activeTracker.global,
              feeConfig:
                null,
              mintSupply:
                bondingCurve.tokenTotalSupply,
              bondingCurve,
              amount:
                botAmount,
            });
        } catch {
          return;
        }

        if (expectedSol.isZero()) {
          return;
        }

        const priceScaled =
          trailingPriceScaled(
            expectedSol,
            botAmount,
          );

        const entryCost =
          new BN(
            position.totalBotSolSpentLamports ||
              "0",
          );

        let pnlBps =
          0;

        if (!entryCost.isZero()) {
          if (expectedSol.gte(entryCost)) {
            pnlBps =
              expectedSol
                .sub(entryCost)
                .muln(10_000)
                .div(entryCost)
                .toNumber();
          } else {
            pnlBps =
              -entryCost
                .sub(expectedSol)
                .muln(10_000)
                .div(entryCost)
                .toNumber();
          }
        }

        if (SAFE_COPY_MODE) {
          const hardStopBps =
            Math.round(
              SAFE_COPY_HARD_STOP_PERCENT *
                100,
            );

          const takeProfitBps =
            Math.round(
              SAFE_COPY_TAKE_PROFIT_PERCENT *
                100,
            );

          const trailingActivateBps =
            Math.round(
              SAFE_COPY_TRAILING_ACTIVATE_PERCENT *
                100,
            );

          const breakEvenArmBps =
            Math.round(
              SAFE_COPY_BREAKEVEN_ARM_PERCENT *
                100,
            );

          const breakEvenFloorBps =
            Math.round(
              SAFE_COPY_BREAKEVEN_FLOOR_PERCENT *
                100,
            );

          if (pnlBps <= -hardStopBps) {
            void triggerTrailingStopSell(
              mintString,
              accountInfo,
              bondingCurve,
              -1,
              "HARD_STOP",
              pnlBps,
            );
            return;
          }

          if (pnlBps >= takeProfitBps) {
            void triggerTrailingStopSell(
              mintString,
              accountInfo,
              bondingCurve,
              -1,
              "TAKE_PROFIT",
              pnlBps,
            );
            return;
          }

          if (
            !activeTracker.breakEvenArmed &&
            pnlBps >= breakEvenArmBps
          ) {
            activeTracker.breakEvenArmed =
              true;
            status(
              `SAFE COPY break-even lock armed for ${mintString} after +${(pnlBps / 100).toFixed(2)}%.`,
              "success",
            );
          }

          if (
            activeTracker.breakEvenArmed &&
            pnlBps <= breakEvenFloorBps
          ) {
            void triggerTrailingStopSell(
              mintString,
              accountInfo,
              bondingCurve,
              -1,
              "BREAKEVEN_LOCK",
              pnlBps,
            );
            return;
          }

          if (
            !activeTracker.trailingArmed &&
            pnlBps >= trailingActivateBps
          ) {
            activeTracker.trailingArmed =
              true;
            activeTracker.peakPriceScaled =
              priceScaled;
            activeTracker.peakQuoteLamports =
              expectedSol;

            status(
              `SAFE COPY trailing armed for ${mintString} at +${(pnlBps / 100).toFixed(2)}%.`,
              "success",
            );
          }

          if (!activeTracker.trailingArmed) {
            return;
          }
        }

        if (
          !activeTracker.peakPriceScaled ||
          priceScaled.gt(
            activeTracker.peakPriceScaled,
          )
        ) {
          activeTracker.peakPriceScaled =
            priceScaled;

          activeTracker.peakQuoteLamports =
            expectedSol;

          console.log(
            `TRAILING PEAK ${mintString}: ${formatSol(Number(expectedSol.toString(10)))} SOL`,
          );

          return;
        }

        const peak =
          activeTracker.peakPriceScaled;

        if (
          !peak ||
          peak.isZero()
        ) {
          return;
        }

        const drawdownBps =
          peak
            .sub(
              priceScaled,
            )
            .muln(
              10_000,
            )
            .div(
              peak,
            )
            .toNumber();

        const triggerBps =
          Math.round(
            (SAFE_COPY_MODE
              ? SAFE_COPY_TRAILING_PERCENT
              : TRAILING_STOP_PERCENT) *
              100,
          );

        if (
          drawdownBps >=
          triggerBps
        ) {
          void triggerTrailingStopSell(
            mintString,
            accountInfo,
            bondingCurve,
            drawdownBps,
            SAFE_COPY_MODE
              ? "PROFIT_TRAILING"
              : "TRAILING_STOP",
            pnlBps,
          );
        }
      };

    tracker.subscriptionId =
      connection.onAccountChange(
        curveAddress,
        accountInfo => {
          evaluate(
            accountInfo,
          );
        },
        "processed",
      );

    // Seed the local peak from the current post-BUY curve without blocking the
    // trading queue. Subsequent price updates arrive over WebSocket.
    void connection.getAccountInfo(
      curveAddress,
      "processed",
    )
      .then(
        accountInfo => {
          if (accountInfo) {
            evaluate(
              accountInfo,
            );
          }
        },
      )
      .catch(
        () => undefined,
      );

    status(
      SAFE_COPY_MODE
        ? `SAFE COPY exit monitor armed for ${mintString}: hard stop ${SAFE_COPY_HARD_STOP_PERCENT}%, take profit ${SAFE_COPY_TAKE_PROFIT_PERCENT}%, trailing activates at +${SAFE_COPY_TRAILING_ACTIVATE_PERCENT}%.`
        : `Trailing stop armed for ${mintString} at ${TRAILING_STOP_PERCENT}% from local peak.`,
      "success",
    );
  } catch (error) {
    trailingStopTrackers.delete(
      mintString,
    );

    console.log(
      `Could not arm trailing stop for ${mintString}:`,
      error,
    );
  }
}

async function startTrailingStopsForExistingPositions(): Promise<void> {
  if (
    !TRAILING_STOP_ENABLED ||
    DRY_RUN
  ) {
    return;
  }

  for (
    const mintString of
      Object.keys(
        persistentState.positions,
      )
  ) {
    void startTrailingStopForMint(
      mintString,
    );

    scheduleSafeCopyMaxHold(
      mintString,
    );
  }
}

const target =
  new PublicKey(
    TARGET_WALLET,
  );

// ============================================================
// STATE
// ============================================================

let botWallet:
  Keypair | null = null;

let websocketSubscriptionId:
  number | null = null;

let reconnecting =
  false;

let enhancedWebSocket:
  any | null = null;

let enhancedSubscriptionId:
  number | null = null;

let enhancedHeartbeat:
  ReturnType<typeof setInterval> | null = null;

let enhancedClosingIntentionally =
  false;

let enhancedStreamActive =
  false;

interface PositionState {
  targetRaw: string;
  botRaw: string;
  decimals: number;

  totalBotSolSpentLamports: string;
  totalBotBoughtRaw: string;
  totalBotSoldRaw: string;

  lastBuyPriceSol: string;
  averageBuyPriceSol: string;
}

interface PersistentState {
  schemaVersion: number;
  mode: "live" | "dry-run";
  walletAddress: string;
  positions: Record<
    string,
    PositionState
  >;
}

const STATE_SCHEMA_VERSION =
  2;

function createEmptyPersistentState(
  walletAddress = "",
): PersistentState {
  return {
    schemaVersion:
      STATE_SCHEMA_VERSION,

    mode:
      DRY_RUN
        ? "dry-run"
        : "live",

    walletAddress:
      DRY_RUN
        ? ""
        : walletAddress,

    positions: {},
  };
}

let persistentState:
  PersistentState =
    createEmptyPersistentState();

interface PendingBuyState {
  signature: string;
  mint: string;
  targetRaw: string;
  decimals: number;
  beforeTokenBalance: string;
  solSpentLamports: string;
  tokenProgram: string | null;
  createdAt: number;
}

const pendingBuys =
  new Map<string, PendingBuyState>();

const pendingBuySettlementPromises =
  new Map<string, Promise<boolean>>();

// ============================================================
// PROCESSED SIGNATURES
// ============================================================

const processedSignatures =
  new Set<string>();

const MAX_PROCESSED_SIGNATURES =
  10000;

function rememberSignature(
  signature: string,
): boolean {
  if (
    processedSignatures.has(
      signature,
    )
  ) {
    return false;
  }

  processedSignatures.add(
    signature,
  );

  if (
    processedSignatures.size >
    MAX_PROCESSED_SIGNATURES
  ) {
    const first =
      processedSignatures
        .values()
        .next()
        .value;

    if (
      first
    ) {
      processedSignatures.delete(
        first,
      );
    }
  }

  return true;
}

// ============================================================
// TRADE QUEUE
// ============================================================
//
// IMPORTANT:
// Transaction fetching + trade detection are I/O-heavy and can safely run
// in parallel. Actual COPY BUY/SELL execution stays strictly ordered by the
// WebSocket arrival sequence, so a fast SELL analysis can never overtake an
// earlier BUY and corrupt the tracked position.
// ============================================================

const ANALYSIS_CONCURRENCY =
  Math.max(
    1,
    Math.min(
      16,
      Number(
        process.env.ANALYSIS_CONCURRENCY || "4",
      ) || 4,
    ),
  );

interface PendingTradeJob {
  sequence: number;
  signature: string;
  observedAtMs: number;
  // Enhanced transactionSubscribe supplies the full transaction directly.
  // Standard onLogs normally leaves this null and uses the RPC fetch fallback.
  tx?: any | null;
  // Direct Pump TradeEvent decoded from onLogs. When present, the bot can skip
  // getParsedTransaction entirely and start the copy path immediately.
  fastTrade?: DetectedTrade | null;
}

interface AnalyzedTradeJob {
  sequence: number;
  signature: string;
  observedAtMs: number;
  txLoadedAtMs: number;
  tx: any | null;
  trade: Awaited<
    ReturnType<typeof detectTrade>
  >;
  error?: unknown;
}

let nextQueuedSequence =
  0;

let nextExecutionSequence =
  0;

let activeAnalysisWorkers =
  0;

let drainingExecutionQueue =
  false;

// Strict execution is serialized, so one current latency origin is safe.
// sendInstructions() uses this to print the real target-notification -> bot-send time.
let currentTradeObservedAtMs:
  number | null = null;

const pendingTradeJobs:
  PendingTradeJob[] = [];

const analyzedTradeJobs =
  new Map<
    number,
    AnalyzedTradeJob
  >();

function enqueueTrade(
  signature: string,
  tx: any | null = null,
  fastTrade: DetectedTrade | null = null,
): void {
  const job: PendingTradeJob = {
    sequence:
      nextQueuedSequence++,
    signature,
    observedAtMs:
      Date.now(),
    tx,
    fastTrade,
  };

  pendingTradeJobs.push(
    job,
  );

  // Hide hot-path latency behind transaction analysis. These are cache-backed,
  // so repeated target activity does not trigger a fresh request every time.
  void getFastLatestBlockhash()
    .catch(
      () => undefined,
    );

  // Fixed-SOL copy mode does not need a live SOL/USD quote on every target event.
  // Avoid hammering CoinGecko and creating 429 noise in the hot path.
  if (BUY_SOL_OVERRIDE <= 0) {
    void solUsd()
      .catch(
        () => undefined,
      );
  }

  pumpAnalysisWorkers();

  console.log(
    `Queued #${job.sequence}. pending-analysis=${pendingTradeJobs.length} active-analysis=${activeAnalysisWorkers} ready-to-execute=${analyzedTradeJobs.size}`,
  );
}

function pumpAnalysisWorkers(): void {
  while (
    activeAnalysisWorkers <
      ANALYSIS_CONCURRENCY &&
    pendingTradeJobs.length > 0
  ) {
    const job =
      pendingTradeJobs.shift();

    if (!job) {
      return;
    }

    activeAnalysisWorkers++;

    void analyzeQueuedTrade(
      job,
    )
      .then(
        analyzed => {
          analyzedTradeJobs.set(
            job.sequence,
            analyzed,
          );

          void drainExecutionQueue();
        },
      )
      .catch(
        error => {
          console.error(
            `Unexpected analysis error for ${job.signature}:`,
            error,
          );

          analyzedTradeJobs.set(
            job.sequence,
            {
              sequence:
                job.sequence,
              signature:
                job.signature,
              observedAtMs:
                job.observedAtMs,
              txLoadedAtMs:
                Date.now(),
              tx:
                null,
              trade:
                null,
              error,
            },
          );

          void drainExecutionQueue();
        },
      )
      .finally(
        () => {
          activeAnalysisWorkers--;

          pumpAnalysisWorkers();
        },
      );
  }
}

async function analyzeQueuedTrade(
  job: PendingTradeJob,
): Promise<AnalyzedTradeJob> {
  section(
    `Analyzing target transaction #${job.sequence}`,
    ANSI.cyan,
  );

  kv(
    "Signature",
    job.signature,
  );

  kv(
    "Solscan",
    `https://solscan.io/tx/${job.signature}`,
  );

  // FASTEST PATH: a direct Pump TradeEvent can be decoded from the logs that
  // arrive with onLogs. This removes the ~1s getParsedTransaction wait seen on
  // free-tier RPC. Enhanced transactionSubscribe remains the next-fastest path.
  if (job.fastTrade) {
    const txLoadedAtMs =
      Date.now();

    console.log(
      `LATENCY target seen -> Pump TradeEvent decoded: ${txLoadedAtMs - job.observedAtMs} ms`,
    );

    return {
      sequence:
        job.sequence,
      signature:
        job.signature,
      observedAtMs:
        job.observedAtMs,
      txLoadedAtMs,
      tx:
        job.tx || null,
      trade:
        job.fastTrade,
    };
  }

  // ULTRA-FAST PATH: Enhanced transactionSubscribe already delivered the
  // full parsed transaction. Standard onLogs uses the RPC fallback below.
  const tx =
    job.tx ||
    await getTargetTransaction(
      job.signature,
    );

  const txLoadedAtMs =
    Date.now();

  console.log(
    `LATENCY target seen -> tx loaded: ${txLoadedAtMs - job.observedAtMs} ms`,
  );

  if (!tx) {
    console.log(
      `#${job.sequence}: Could not load transaction.`,
    );

    return {
      sequence:
        job.sequence,
      signature:
        job.signature,
      observedAtMs:
        job.observedAtMs,
      txLoadedAtMs:
        Date.now(),
      tx:
        null,
      trade:
        null,
    };
  }

  const trade =
    await detectTrade(
      tx,
      TARGET_WALLET,
    );

  if (!trade) {
    console.log(
      `#${job.sequence}: Not a real target swap. Ignoring.`,
    );
  }

  return {
    sequence:
      job.sequence,
    signature:
      job.signature,
    observedAtMs:
      job.observedAtMs,
    txLoadedAtMs,
    tx,
    trade,
  };
}

async function drainExecutionQueue(): Promise<void> {
  if (
    drainingExecutionQueue
  ) {
    return;
  }

  drainingExecutionQueue =
    true;

  try {
    while (
      analyzedTradeJobs.has(
        nextExecutionSequence,
      )
    ) {
      const analyzed =
        analyzedTradeJobs.get(
          nextExecutionSequence,
        );

      analyzedTradeJobs.delete(
        nextExecutionSequence,
      );

      nextExecutionSequence++;

      if (!analyzed) {
        continue;
      }

      if (
        analyzed.error
      ) {
        continue;
      }

      try {
        await executeAnalyzedTrade(
          analyzed,
        );
      } catch (error) {
        console.error(
          `Unexpected execution error for ${analyzed.signature}:`,
          error,
        );
      }
    }
  } finally {
    drainingExecutionQueue =
      false;

    // A worker may have completed while the execution loop was finishing.
    // Re-check once so a ready next sequence cannot remain stuck.
    if (
      analyzedTradeJobs.has(
        nextExecutionSequence,
      )
    ) {
      void drainExecutionQueue();
    }
  }
}

// ============================================================
// HELPERS
// ============================================================

function sleep(
  ms: number,
): Promise<void> {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms,
      ),
  );
}

function formatSol(
  lamports: number,
): string {
  return (
    lamports /
    LAMPORTS_PER_SOL
  ).toFixed(9);
}

// Format an integer token amount without ever converting the BN to a JS
// integer. This avoids the 53-bit Number limit for large SPL raw amounts.
function formatTokenAmount(
  rawAmount: BN,
  decimals: number,
): string {
  const negative =
    rawAmount.isNeg();

  const digits =
    rawAmount.abs().toString(10);

  if (decimals <= 0) {
    return `${negative ? "-" : ""}${digits}`;
  }

  const padded =
    digits.padStart(
      decimals + 1,
      "0",
    );

  const integerPart =
    padded.slice(
      0,
      -decimals,
    );

  const fractionalPart =
    padded
      .slice(-decimals)
      .replace(/0+$/, "");

  const value =
    fractionalPart
      ? `${integerPart}.${fractionalPart}`
      : integerPart;

  return `${negative ? "-" : ""}${value}`;
}

// Exact decimal division using bigint. Used only for saved/displayed price
// metadata; trading and sizing continue to use BN raw integers.
function divideBnToDecimalString(
  numerator: BN,
  denominator: BN,
  fractionalDigits = 18,
): string {
  if (denominator.isZero()) {
    return "0";
  }

  let n = BigInt(
    numerator.toString(10),
  );

  let d = BigInt(
    denominator.toString(10),
  );

  const negative =
    (n < 0n) !== (d < 0n);

  if (n < 0n) n = -n;
  if (d < 0n) d = -d;

  const integerPart =
    n / d;

  let remainder =
    n % d;

  let fraction = "";

  for (
    let i = 0;
    i < fractionalDigits &&
      remainder !== 0n;
    i++
  ) {
    remainder *= 10n;

    fraction +=
      (remainder / d).toString();

    remainder %= d;
  }

  fraction =
    fraction.replace(/0+$/, "");

  const body =
    fraction
      ? `${integerPart.toString()}.${fraction}`
      : integerPart.toString();

  return `${negative ? "-" : ""}${body}`;
}

function solPerTokenPriceString(
  solSpentLamports: BN,
  tokenAmountRaw: BN,
  tokenDecimals: number,
): string {
  if (tokenAmountRaw.isZero()) {
    return "0";
  }

  const numerator =
    solSpentLamports.mul(
      new BN(10).pow(
        new BN(
          Math.max(
            0,
            tokenDecimals,
          ),
        ),
      ),
    );

  const denominator =
    tokenAmountRaw.mul(
      new BN(
        LAMPORTS_PER_SOL,
      ),
    );

  return divideBnToDecimalString(
    numerator,
    denominator,
    24,
  );
}

function safeEndpointLabel(
  endpoint: string | undefined,
): string {
  if (!endpoint) {
    return "default";
  }

  try {
    const parsed =
      new URL(endpoint);

    const base =
      `${parsed.protocol}//${parsed.host}${parsed.pathname}`;

    return parsed.search ||
      parsed.username ||
      parsed.password
      ? `${base} [credentials hidden]`
      : base;
  } catch {
    return "configured [credentials hidden]";
  }
}


// ============================================================
// POWERSHELL / TERMINAL UI
// ============================================================
// ANSI colors work in modern Windows Terminal / PowerShell.
// If output is redirected to a file, colors are automatically disabled.

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

function paint(
  value: string,
  ...codes: string[]
): string {
  if (!process.stdout.isTTY) {
    return value;
  }

  return `${codes.join("")}${value}${ANSI.reset}`;
}

function terminalWidth(): number {
  return Math.max(
    74,
    Math.min(
      process.stdout.columns || 96,
      116,
    ),
  );
}

function line(
  char = "═",
): string {
  return char.repeat(
    terminalWidth(),
  );
}

function section(
  title: string,
  color = ANSI.cyan,
): void {
  const width =
    terminalWidth();

  const label =
    ` ${title.toUpperCase()} `;

  const left =
    Math.max(
      2,
      Math.floor(
        (width - label.length) / 2,
      ),
    );

  const right =
    Math.max(
      2,
      width - label.length - left,
    );

  console.log("");
  console.log(
    paint(
      `${"─".repeat(left)}${label}${"─".repeat(right)}`,
      ANSI.bold,
      color,
    ),
  );
}

function kv(
  key: string,
  value: string | number | boolean,
): void {
  const label =
    `${key}`.padEnd(32, ".");

  console.log(
    `  ${paint(label, ANSI.bold)} ${value}`,
  );
}

function status(
  message: string,
  type:
    | "info"
    | "success"
    | "warning"
    | "error" = "info",
): void {
  const color =
    type === "success"
      ? ANSI.green
      : type === "warning"
        ? ANSI.yellow
        : type === "error"
          ? ANSI.red
          : ANSI.cyan;

  const icon =
    type === "success"
      ? "[OK]"
      : type === "warning"
        ? "[!]"
        : type === "error"
          ? "[X]"
          : "[>]";

  console.log(
    paint(
      `${icon} ${message}`,
      ANSI.bold,
      color,
    ),
  );
}

function printMoneyBanner(): void {
  if (process.stdout.isTTY) {
    process.stdout.write(
      `\x1b]0;${BOT_DISPLAY_NAME}\x07`,
    );
  }

  // Terminal-only euro-symbol field. No PNG/image is used.
  // Kept compact so the startup screen still fits comfortably in PowerShell.
  const art = [
    "     €      €      €     €     €     €     €      €",
    "        €      €      €     €     €     €     €",
    "     €      €      €     €     €     €     €      €",
    "        €      €      €     €     €     €     €",
    "     €      €      €     €     €     €     €      €",
    "        €      €      €     €     €     €     €",
    "     €      €      €     €     €     €     €      €",
    "        €      €      €     €     €     €     €",
  ];

  const center = (value: string): string => {
    if (!value) {
      return "";
    }

    const padding =
      Math.max(
        0,
        Math.floor(
          (terminalWidth() - value.length) / 2,
        ),
      );

    return `${" ".repeat(padding)}${value}`;
  };

  console.log("");
  console.log(
    paint(
      line("═"),
      ANSI.bold,
      ANSI.green,
    ),
  );

  for (const row of art) {
    console.log(
      paint(
        center(row),
        ANSI.bold,
        ANSI.green,
      ),
    );
  }

  console.log("");
  console.log(
    paint(
      center(BOT_DISPLAY_NAME),
      ANSI.bold,
      ANSI.cyan,
    ),
  );

  console.log(
    paint(
      center("FAST SOLANA COPY TRADING"),
      ANSI.bold,
      ANSI.gray,
    ),
  );

  console.log(
    paint(
      center("CXKX COPY V2 • FAST PROFIT TEST"),
      ANSI.bold,
      ANSI.yellow,
    ),
  );

  console.log(
    paint(
      line("═"),
      ANSI.bold,
      ANSI.green,
    ),
  );
}

// ============================================================
// PERSISTENT STATE
// ============================================================

function normalizePosition(
  position: any,
): PositionState {
  return {
    targetRaw:
      String(
        position?.targetRaw ||
        "0",
      ),

    botRaw:
      String(
        position?.botRaw ||
        "0",
      ),

    decimals:
      Number(
        position?.decimals ||
        0,
      ),

    totalBotSolSpentLamports:
      String(
        position?.totalBotSolSpentLamports ||
        "0",
      ),

    totalBotBoughtRaw:
      String(
        position?.totalBotBoughtRaw ||
        position?.botRaw ||
        "0",
      ),

    totalBotSoldRaw:
      String(
        position?.totalBotSoldRaw ||
        "0",
      ),

    lastBuyPriceSol:
      String(
        position?.lastBuyPriceSol ||
        "0",
      ),

    averageBuyPriceSol:
      String(
        position?.averageBuyPriceSol ||
        "0",
      ),
  };
}

function loadPersistentState(
  expectedWalletAddress: string,
): void {
  try {
    if (
      !fs.existsSync(
        STATE_FILE,
      )
    ) {
      console.log(
        "No state file found. Starting empty.",
      );

      persistentState =
        createEmptyPersistentState(
          expectedWalletAddress,
        );

      savePersistentState();

      return;
    }

    const raw =
      fs.readFileSync(
        STATE_FILE,
        "utf8",
      );

    const parsed =
      JSON.parse(
        raw,
      );

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.positions ||
      typeof parsed.positions !== "object"
    ) {
      throw new Error(
        "Invalid state.json structure.",
      );
    }

    // ========================================================
    // LIVE STATE OWNERSHIP / LEGACY PROTECTION
    // ========================================================
    // Old versions of the bot stored dry-run and live positions in
    // compatible-looking files. Never trust such legacy positions in
    // LIVE mode: they could make the bot treat a manually-held token as
    // one of its own positions and copy a SELL.
    //
    // New live state is explicitly bound to:
    //   1) schema version
    //   2) mode=live
    //   3) the exact bot wallet public address
    // ========================================================

    if (
      !DRY_RUN
    ) {
      const stateSchemaVersion =
        Number(
          parsed.schemaVersion || 0,
        );

      const stateMode =
        String(
          parsed.mode || "",
        );

      const stateWalletAddress =
        String(
          parsed.walletAddress || "",
        );

      const compatible =
        stateSchemaVersion ===
          STATE_SCHEMA_VERSION &&
        stateMode ===
          "live" &&
        stateWalletAddress ===
          expectedWalletAddress;

      if (
        !compatible
      ) {
        const backupFile =
          `${STATE_FILE}.legacy-${Date.now()}.bak`;

        try {
          fs.copyFileSync(
            STATE_FILE,
            backupFile,
          );

          status(
            `Old/incompatible live state was backed up to ${path.basename(
              backupFile,
            )}.`,
            "warning",
          );
        } catch (backupError) {
          console.error(
            "Could not create legacy state backup:",
            backupError,
          );
        }

        status(
          "Ignoring old/incompatible tracked positions and starting LIVE state empty.",
          "warning",
        );

        persistentState =
          createEmptyPersistentState(
            expectedWalletAddress,
          );

        savePersistentState();

        console.log(
          "Loaded 0 position(s).",
        );

        return;
      }
    }

    const normalized:
      Record<
        string,
        PositionState
      > = {};

    for (
      const [mint, position] of
        Object.entries(
          parsed.positions,
        )
    ) {
      normalized[mint] =
        normalizePosition(
          position,
        );
    }

    persistentState = {
      schemaVersion:
        STATE_SCHEMA_VERSION,

      mode:
        DRY_RUN
          ? "dry-run"
          : "live",

      walletAddress:
        DRY_RUN
          ? ""
          : expectedWalletAddress,

      positions:
        normalized,
    };

    console.log(
      `Loaded ${Object.keys(
        normalized,
      ).length} position(s).`,
    );

    // Upgrade metadata to the latest schema on every successful load.
    savePersistentState();
  } catch (error) {
    console.error(
      "Could not load state.json:",
      error,
    );

    persistentState =
      createEmptyPersistentState(
        expectedWalletAddress,
      );

    savePersistentState();
  }
}

function savePersistentState(): void {
  try {
    const directory =
      path.dirname(
        STATE_FILE,
      );

    fs.mkdirSync(
      directory,
      {
        recursive: true,
      },
    );

    const temporaryFile =
      `${STATE_FILE}.tmp`;

    const walletAddress =
      !DRY_RUN &&
      botWallet
        ? botWallet.publicKey.toBase58()
        : persistentState.walletAddress || "";

    persistentState.schemaVersion =
      STATE_SCHEMA_VERSION;

    persistentState.mode =
      DRY_RUN
        ? "dry-run"
        : "live";

    persistentState.walletAddress =
      DRY_RUN
        ? ""
        : walletAddress;

    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(
        persistentState,
        null,
        2,
      ),
      "utf8",
    );

    fs.renameSync(
      temporaryFile,
      STATE_FILE,
    );
  } catch (error) {
    console.error(
      "Could not save state.json:",
      error,
    );
  }
}

function getPosition(
  mint: string,
): PositionState | null {
  return (
    persistentState.positions[
      mint
    ] || null
  );
}

function removePositionIfEmpty(
  mint: string,
): boolean {
  const position =
    getPosition(
      mint,
    );

  if (!position) {
    return false;
  }

  const targetAmount =
    new BN(
      position.targetRaw,
    );

  const botAmount =
    new BN(
      position.botRaw,
    );

  if (
    targetAmount.isZero() &&
    botAmount.isZero()
  ) {
    delete persistentState.positions[
      mint
    ];

    return true;
  }

  return false;
}

function addBuyToPosition(
  mint: string,
  targetAmount: BN,
  botAmount: BN,
  decimals: number,
  solSpentLamports: BN,
): void {
  const current =
    getPosition(
      mint,
    );

  if (!current) {
    const averagePrice =
      solPerTokenPriceString(
        solSpentLamports,
        botAmount,
        decimals,
      );

    persistentState.positions[
      mint
    ] = {
      targetRaw:
        targetAmount.toString(),

      botRaw:
        botAmount.toString(),

      decimals,

      totalBotSolSpentLamports:
        solSpentLamports.toString(),

      totalBotBoughtRaw:
        botAmount.toString(),

      totalBotSoldRaw:
        "0",

      lastBuyPriceSol:
        averagePrice,

      averageBuyPriceSol:
        averagePrice,
    };
  } else {
    const currentTarget =
      new BN(
        current.targetRaw,
      );

    const currentBot =
      new BN(
        current.botRaw,
      );

    const currentSpent =
      new BN(
        current.totalBotSolSpentLamports ||
        "0",
      );

    const currentBought =
      new BN(
        current.totalBotBoughtRaw ||
        "0",
      );

    const newTarget =
      currentTarget.add(
        targetAmount,
      );

    const newBot =
      currentBot.add(
        botAmount,
      );

    const newSpent =
      currentSpent.add(
        solSpentLamports,
      );

    const newBought =
      currentBought.add(
        botAmount,
      );

    const newAverage =
      solPerTokenPriceString(
        newSpent,
        newBought,
        decimals,
      );

    const lastPrice =
      botAmount.isZero()
        ? current.lastBuyPriceSol
        : solPerTokenPriceString(
            solSpentLamports,
            botAmount,
            decimals,
          );

    current.targetRaw =
      newTarget.toString();

    current.botRaw =
      newBot.toString();

    current.decimals =
      decimals;

    current.totalBotSolSpentLamports =
      newSpent.toString();

    current.totalBotBoughtRaw =
      newBought.toString();

    current.lastBuyPriceSol =
      lastPrice;

    current.averageBuyPriceSol =
      newAverage;
  }

  savePersistentState();
}

function updateSellPosition(
  mint: string,
  targetSold: BN,
  botSold: BN,
): boolean {
  const current =
    getPosition(
      mint,
    );

  if (!current) {
    return false;
  }

  const currentTarget =
    new BN(
      current.targetRaw,
    );

  const currentBot =
    new BN(
      current.botRaw,
    );

  const currentSold =
    new BN(
      current.totalBotSoldRaw ||
      "0",
    );

  // Never subtract more than the tracked position.
  const actualTargetSold =
    BN.min(
      targetSold,
      currentTarget,
    );

  const actualBotSold =
    BN.min(
      botSold,
      currentBot,
    );

  const newTarget =
    currentTarget.sub(
      actualTargetSold,
    );

  const newBot =
    currentBot.sub(
      actualBotSold,
    );

  current.targetRaw =
    newTarget.toString();

  current.botRaw =
    newBot.toString();

  current.totalBotSoldRaw =
    currentSold
      .add(actualBotSold)
      .toString();

  const closed =
    removePositionIfEmpty(
      mint,
    );

  savePersistentState();

  return closed;
}

function printPosition(
  mint: string,
): void {
  const position =
    getPosition(
      mint,
    );

  if (!position) {
    console.log(
      `No open tracked position for ${mint}`,
    );

    return;
  }

  console.log(
    `Position target=${position.targetRaw} bot=${position.botRaw}`,
  );

  console.log(
    `Average BUY price=${position.averageBuyPriceSol} SOL/token`,
  );

  console.log(
    `Last BUY price=${position.lastBuyPriceSol} SOL/token`,
  );
}


// ============================================================
// LIVE STATE RECONCILIATION
// ============================================================
// A transaction may be confirmed on-chain before an RPC token-account query
// reflects the new balance. If a previous run submitted a SELL but exited
// before state.json was updated, the saved botRaw can be larger than the
// wallet's real balance. On startup, reduce ONLY tracked positions whose real
// balance is lower. Extra wallet tokens are never added to tracked state.
// ============================================================

async function reconcileLivePositionsWithWallet(
  wallet: PublicKey,
): Promise<void> {
  if (
    DRY_RUN
  ) {
    return;
  }

  const entries =
    Object.entries(
      persistentState.positions,
    );

  if (
    entries.length === 0
  ) {
    return;
  }

  section(
    "LIVE STATE RECONCILIATION",
    ANSI.yellow,
  );

  let changed =
    false;

  for (
    const [mintString, position] of
      entries
  ) {
    try {
      const mint =
        new PublicKey(
          mintString,
        );

      const actualBalance =
        await getWalletTokenBalance(
          wallet,
          mint,
          "confirmed",
        );

      const trackedBot =
        new BN(
          position.botRaw || "0",
        );

      const trackedTarget =
        new BN(
          position.targetRaw || "0",
        );

      if (
        trackedBot.isZero()
      ) {
        continue;
      }

      if (
        actualBalance.isZero()
      ) {
        delete persistentState.positions[
          mintString
        ];

        changed =
          true;

        status(
          `Removed stale tracked position ${mintString}: real wallet balance is zero.`,
          "warning",
        );

        continue;
      }

      if (
        actualBalance.lt(
          trackedBot,
        )
      ) {
        const soldDifference =
          trackedBot.sub(
            actualBalance,
          );

        let adjustedTarget =
          trackedTarget
            .mul(
              actualBalance,
            )
            .div(
              trackedBot,
            );

        if (
          adjustedTarget.isZero() &&
          !trackedTarget.isZero()
        ) {
          adjustedTarget =
            new BN(1);
        }

        const previouslyRecordedSold =
          new BN(
            position.totalBotSoldRaw || "0",
          );

        position.botRaw =
          actualBalance.toString();

        position.targetRaw =
          adjustedTarget.toString();

        position.totalBotSoldRaw =
          previouslyRecordedSold
            .add(
              soldDifference,
            )
            .toString();

        changed =
          true;

        status(
          `Reconciled ${mintString}: tracked bot balance ${trackedBot.toString()} -> real ${actualBalance.toString()}.`,
          "warning",
        );

        continue;
      }

      if (
        actualBalance.gt(
          trackedBot,
        )
      ) {
        status(
          `Wallet has extra untracked tokens for ${mintString}; keeping tracked amount unchanged.`,
          "info",
        );
      }
    } catch (error) {
      console.error(
        `Could not reconcile tracked position ${mintString}:`,
        error,
      );
    }
  }

  if (
    changed
  ) {
    savePersistentState();

    status(
      "Live tracked positions reconciled with confirmed wallet balances.",
      "success",
    );
  } else {
    status(
      "Live tracked positions already match wallet balances.",
      "success",
    );
  }
}

// ============================================================
// SOL/USD
// ============================================================

let cachedSolUsd:
  number | null =
  null;

let cachedSolUsdAt =
  0;

const SOL_PRICE_CACHE_MS =
  30_000;

// CoinGecko can rate-limit public requests. A failed lookup is never allowed
// to spam the event hot path; keep using the last cached/fallback price and
// wait before trying again.
const SOL_PRICE_FAILURE_BACKOFF_MS =
  120_000;

let solPriceRetryAfterMs =
  0;

async function solUsd(): Promise<number> {
  const now =
    Date.now();

  if (
    cachedSolUsd !== null &&
    now - cachedSolUsdAt <
      SOL_PRICE_CACHE_MS
  ) {
    return cachedSolUsd;
  }

  if (now < solPriceRetryAfterMs) {
    return cachedSolUsd || 102;
  }

  try {
    const response =
      await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      );

    if (!response.ok) {
      throw new Error(
        `CoinGecko HTTP ${response.status}`,
      );
    }

    const data =
      await response.json() as {
        solana?: {
          usd?: number;
        };
      };

    const price =
      data.solana?.usd;

    if (
      !price ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      throw new Error(
        "Invalid SOL/USD price.",
      );
    }

    cachedSolUsd =
      price;

    cachedSolUsdAt =
      now;

    return price;
  } catch (error) {
    solPriceRetryAfterMs =
      Date.now() + SOL_PRICE_FAILURE_BACKOFF_MS;

    console.log(
      "SOL/USD lookup temporarily unavailable; using cached/fallback price for 120s.",
    );

    if (
      cachedSolUsd !== null
    ) {
      return cachedSolUsd;
    }

    return 102;
  }
}

// ============================================================
// HOT-PATH WALLET CACHE
// ============================================================

let cachedBotSolBalanceLamports:
  number | null = null;

let cachedBotSolBalanceAt =
  0;

async function refreshBotSolBalance(): Promise<void> {
  if (
    DRY_RUN ||
    !botWallet
  ) {
    return;
  }

  try {
    cachedBotSolBalanceLamports =
      await connection.getBalance(
        botWallet.publicKey,
        "processed",
      );

    cachedBotSolBalanceAt =
      Date.now();
  } catch {
    // Keep the last known balance. A transient RPC failure must not create
    // extra latency in the transaction hot path.
  }
}

function startHotCacheWarmers(): void {
  // Keep blockhash, SOL/USD and wallet SOL balance hot so a target BUY does
  // not wait on unrelated network requests before it can be signed/sent.
  setInterval(
    () => {
      void getFastLatestBlockhash()
        .catch(() => undefined);
    },
    2_500,
  );

  if (BUY_SOL_OVERRIDE <= 0) {
    setInterval(
      () => {
        void solUsd()
          .catch(() => undefined);
      },
      20_000,
    );
  }

  setInterval(
    () => {
      void refreshBotSolBalance();
    },
    2_000,
  );

  if (
    HELIUS_SENDER_ENABLED
  ) {
    setInterval(
      () => {
        void warmHeliusSenderConnection();
      },
      HELIUS_SENDER_PING_INTERVAL_MS,
    );
  }
}

// ============================================================
// COPY SIZE
// ============================================================

async function getCopySolAmount(): Promise<number> {
  if (
    BUY_SOL_OVERRIDE > 0
  ) {
    return Math.min(
      BUY_SOL_OVERRIDE,
      MAX_SOL_PER_TRADE,
    );
  }

  // Never put CoinGecko/HTTP on the trade hot path. Startup + background
  // warmers keep cachedSolUsd fresh; if it is briefly unavailable use the
  // existing conservative fallback and refresh asynchronously.
  const price =
    cachedSolUsd || 102;

  void solUsd()
    .catch(
      () => undefined,
    );

  let solAmount =
    BUY_USD /
    price;

  if (
    MAX_SOL_PER_TRADE > 0 &&
    solAmount >
      MAX_SOL_PER_TRADE
  ) {
    solAmount =
      MAX_SOL_PER_TRADE;
  }

  return solAmount;
}

// ============================================================
// ACCOUNT NORMALIZATION
// ============================================================

function normalizePublicKey(
  value: any,
): string {
  if (
    typeof value === "string"
  ) {
    return value;
  }

  if (
    value?.pubkey?.toBase58
  ) {
    return value.pubkey.toBase58();
  }

  if (
    value?.pubkey
  ) {
    return String(
      value.pubkey,
    );
  }

  if (
    value?.toBase58
  ) {
    return value.toBase58();
  }

  return String(
    value || "",
  );
}

// ============================================================
// TRANSACTION ACCOUNT KEYS
// ============================================================

function getTransactionAccountKeys(
  tx: any,
): string[] {
  const message =
    tx.transaction?.message;

  if (!message) {
    return [];
  }

  const accountKeys:
    string[] = [];

  for (
    const key of
      message.accountKeys || []
  ) {
    const normalized =
      normalizePublicKey(
        key,
      );

    if (
      normalized
    ) {
      accountKeys.push(
        normalized,
      );
    }
  }

  const loadedAddresses =
    tx.meta?.loadedAddresses;

  if (
    loadedAddresses
  ) {
    for (
      const key of
        loadedAddresses.writable || []
    ) {
      accountKeys.push(
        normalizePublicKey(
          key,
        ),
      );
    }

    for (
      const key of
        loadedAddresses.readonly || []
    ) {
      accountKeys.push(
        normalizePublicKey(
          key,
        ),
      );
    }
  }

  return accountKeys;
}

// ============================================================
// TARGET SIGNER
// ============================================================

function transactionHasSigner(
  tx: any,
  owner: string,
): boolean {
  const message =
    tx.transaction?.message;

  if (!message) {
    return false;
  }

  const accountKeys =
    message.accountKeys || [];

  const required =
    Number(
      message.header
        ?.numRequiredSignatures ||
      0,
    );

  const signerCount =
    Math.min(
      required,
      accountKeys.length,
    );

  for (
    let i = 0;
    i < signerCount;
    i++
  ) {
    const pubkey =
      normalizePublicKey(
        accountKeys[i],
      );

    if (
      pubkey === owner
    ) {
      return true;
    }
  }

  for (
    const key of accountKeys
  ) {
    const pubkey =
      normalizePublicKey(
        key,
      );

    if (
      pubkey === owner &&
      key?.signer === true
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// PROGRAM RESOLUTION
// ============================================================

function resolveProgramId(
  instruction: any,
  accountKeys: string[],
): string {
  if (
    instruction?.programId?.toBase58
  ) {
    return instruction.programId.toBase58();
  }

  if (
    typeof instruction?.programId ===
    "string"
  ) {
    return instruction.programId;
  }

  const index =
    instruction?.programIdIndex;

  if (
    typeof index === "number" &&
    accountKeys[index]
  ) {
    return accountKeys[index];
  }

  return "";
}

function transactionUsesProgram(
  tx: any,
  programId: string,
): boolean {
  try {
    const accountKeys =
      getTransactionAccountKeys(
        tx,
      );

    const instructions =
      tx.transaction?.message
        ?.instructions || [];

    for (
      const instruction of
        instructions
    ) {
      if (
        resolveProgramId(
          instruction,
          accountKeys,
        ) === programId
      ) {
        return true;
      }
    }

    const innerInstructions =
      tx.meta?.innerInstructions || [];

    for (
      const group of
        innerInstructions
    ) {
      for (
        const instruction of
          group.instructions || []
      ) {
        if (
          resolveProgramId(
            instruction,
            accountKeys,
          ) === programId
        ) {
          return true;
        }
      }
    }

    const logs =
      tx.meta?.logMessages || [];

    for (
      const log of
        logs
    ) {
      if (
        typeof log !== "string"
      ) {
        continue;
      }

      if (
        log.includes(
          `Program ${programId} invoke`,
        )
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

// ============================================================
// TOP-LEVEL PROGRAM CHECK
// IMPORTANT:
// Used to prevent ordinary transfers from being detected
// merely because Pump appears inside an unrelated transaction.
// ============================================================

function transactionHasTopLevelProgramInstruction(
  tx: any,
  programId: string,
): boolean {
  try {
    const accountKeys =
      getTransactionAccountKeys(
        tx,
      );

    const instructions =
      tx.transaction?.message
        ?.instructions || [];

    for (
      const instruction of
        instructions
    ) {
      if (
        resolveProgramId(
          instruction,
          accountKeys,
        ) === programId
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

// ============================================================
// LOG VENUE DETECTION
// ============================================================

function detectSwapVenueFromLogs(
  logs: string[],
): {
  pump: boolean;
  pumpAmm: boolean;
  jupiter: boolean;
} {
  let pump =
    false;

  let pumpAmm =
    false;

  let jupiter =
    false;

  for (
    const rawLog of
      logs
  ) {
    if (
      typeof rawLog !== "string"
    ) {
      continue;
    }

    if (
      rawLog.includes(
        `Program ${PUMP_PROGRAM_ID} invoke`,
      )
    ) {
      pump = true;
    }

    if (
      rawLog.includes(
        `Program ${PUMP_AMM_PROGRAM_ID} invoke`,
      )
    ) {
      pumpAmm = true;
    }

    if (
      rawLog.includes(
        `Program ${JUPITER_V6_PROGRAM_ID} invoke`,
      )
    ) {
      jupiter = true;
    }
  }

  return {
    pump,
    pumpAmm,
    jupiter,
  };
}

// ============================================================
// PUMP BUY/SELL LOG DETECTION
// ============================================================

function detectPumpDirectionFromLogs(
  logs: string[],
): {
  buy: boolean;
  sell: boolean;
} {
  const stack:
    Array<
      string | null
    > = [];

  let buy =
    false;

  let sell =
    false;

  for (
    const rawLog of
      logs
  ) {
    if (
      typeof rawLog !== "string"
    ) {
      continue;
    }

    const invokeMatch =
      rawLog.match(
        /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]/,
      );

    if (
      invokeMatch
    ) {
      const program =
        invokeMatch[1];

      const depth =
        Number(
          invokeMatch[2],
        );

      stack[depth] =
        program;

      stack.length =
        depth + 1;

      continue;
    }

    const instructionMatch =
      rawLog.match(
        /Instruction:\s*(Buy|Sell)\b/i,
      );

    if (
      instructionMatch
    ) {
      let currentProgram:
        string | null =
        null;

      for (
        let i =
          stack.length - 1;
        i >= 0;
        i--
      ) {
        if (
          stack[i]
        ) {
          currentProgram =
            stack[i]!;
          break;
        }
      }

      if (
        currentProgram !==
          PUMP_PROGRAM_ID &&
        currentProgram !==
          PUMP_AMM_PROGRAM_ID
      ) {
        continue;
      }

      const instruction =
        instructionMatch[1]
          .trim()
          .toLowerCase();

      if (
        instruction ===
        "buy"
      ) {
        buy = true;
      }

      if (
        instruction ===
        "sell"
      ) {
        sell = true;
      }

      continue;
    }

    const endMatch =
      rawLog.match(
        /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed:)/,
      );

    if (
      endMatch
    ) {
      const program =
        endMatch[1];

      for (
        let i =
          stack.length - 1;
        i >= 0;
        i--
      ) {
        if (
          stack[i] ===
          program
        ) {
          stack[i] =
            null;

          break;
        }
      }
    }
  }

  return {
    buy,
    sell,
  };
}

// ============================================================
// PUMP NON-TRADE / FEE INSTRUCTION DETECTION
// ============================================================
//
// Pump fee collection/distribution transactions can invoke the same
// Pump/PumpSwap programs and can also change token balances. Without
// this guard they can look like BUY/SELL when we fall back to NET deltas.
//
// We intentionally reject known maintenance/fee instructions here.
// A real Buy/Sell instruction is NOT included in this list.
// ============================================================

function detectPumpNonTradeInstructionFromLogs(
  logs: string[],
): string | null {
  const blockedInstructionNames = [
    "distributecreatorfees",
    "distributefeetoholders",
    "distributefeeholders",
    "distributefees",
    "collectcreatorfee",
    "collectcreatorfeev2",
    "collectcoincreatorfee",
    "transfercreatorfeestopump",
    "createfeesharingconfig",
    "updatefeeshares",
    "transferfeesharingauthority",
    "resetfeesharingconfig",
    "revokefeesharingauthority",
    "claimcashback",
    "syncuservolumeaccumulator",
    "closeuservolumeaccumulator",
  ];

  for (const rawLog of logs) {
    if (typeof rawLog !== "string") {
      continue;
    }

    // Normalize Anchor/Rust naming styles:
    // "DistributeCreatorFees", "distribute_creator_fees",
    // "distribute_fee_to_holders", etc.
    const normalized = rawLog
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

    for (const blocked of blockedInstructionNames) {
      if (normalized.includes(blocked)) {
        return blocked;
      }
    }
  }

  return null;
}

// ============================================================
// FAST TRADE FILTER
// ============================================================

function detectTradeFromLogs(
  logs: string[],
): {
  possibleSwap: boolean;
  buy: boolean;
  sell: boolean;
  jupiter: boolean;
  pump: boolean;
  pumpAmm: boolean;
} {
  const venue =
    detectSwapVenueFromLogs(
      logs,
    );

  const pumpDirection =
    detectPumpDirectionFromLogs(
      logs,
    );

  return {
    possibleSwap:
      venue.jupiter ||
      venue.pump ||
      venue.pumpAmm,

    buy:
      pumpDirection.buy,

    sell:
      pumpDirection.sell,

    jupiter:
      venue.jupiter,

    pump:
      venue.pump,

    pumpAmm:
      venue.pumpAmm,
  };
}

// ============================================================
// TOKEN BALANCE OWNER RESOLUTION
// ============================================================

async function resolveTokenBalanceOwner(
  tx: any,
  balance: any,
): Promise<string> {
  if (
    balance?.owner
  ) {
    return normalizePublicKey(
      balance.owner,
    );
  }

  const accountIndex =
    balance?.accountIndex;

  if (
    typeof accountIndex !== "number"
  ) {
    return "";
  }

  const accountKeys =
    getTransactionAccountKeys(
      tx,
    );

  const tokenAccount =
    accountKeys[
      accountIndex
    ];

  if (
    !tokenAccount
  ) {
    return "";
  }

  try {
    const parsed =
      await connection.getParsedAccountInfo(
        new PublicKey(
          tokenAccount,
        ),
        "processed",
      );

    const info =
      (parsed.value?.data as any)
        ?.parsed?.info;

    if (
      info?.owner
    ) {
      return normalizePublicKey(
        info.owner,
      );
    }
  } catch {
    // ignore
  }

  return "";
}

// ============================================================
// TOKEN DELTAS
// ============================================================

async function tokenDeltasForOwner(
  tx: any,
  owner: string,
): Promise<
  Array<{
    mint: string;
    rawDelta: BN;
    rawAmount: BN;
    decimals: number;
    uiAmount: string;
  }>
> {
  const pre =
    tx.meta?.preTokenBalances || [];

  const post =
    tx.meta?.postTokenBalances || [];

  const map =
    new Map<
      string,
      {
        delta: BN;
        decimals: number;
      }
    >();

  const ownerCache =
    new Map<
      string,
      string
    >();

  async function getBalanceOwner(
    balance: any,
  ): Promise<string> {
    if (
      balance?.owner
    ) {
      return normalizePublicKey(
        balance.owner,
      );
    }

    const accountIndex =
      balance?.accountIndex;

    if (
      typeof accountIndex !== "number"
    ) {
      return "";
    }

    const accountKeys =
      getTransactionAccountKeys(
        tx,
      );

    const tokenAccount =
      accountKeys[
        accountIndex
      ];

    if (
      !tokenAccount
    ) {
      return "";
    }

    if (
      ownerCache.has(
        tokenAccount,
      )
    ) {
      return (
        ownerCache.get(
          tokenAccount,
        ) || ""
      );
    }

    const resolved =
      await resolveTokenBalanceOwner(
        tx,
        balance,
      );

    ownerCache.set(
      tokenAccount,
      resolved,
    );

    return resolved;
  }

  for (
    const balance of
      pre
  ) {
    const balanceOwner =
      await getBalanceOwner(
        balance,
      );

    if (
      balanceOwner !== owner
    ) {
      continue;
    }

    const mint =
      balance.mint;

    if (
      !mint
    ) {
      continue;
    }

    const amount =
      new BN(
        balance.uiTokenAmount
          ?.amount || "0",
      );

    const decimals =
      Number(
        balance.uiTokenAmount
          ?.decimals || 0,
      );

    const current =
      map.get(
        mint,
      );

    if (current) {
      current.delta =
        current.delta.sub(
          amount,
        );
    } else {
      map.set(
        mint,
        {
          delta:
            amount.neg(),

          decimals,
        },
      );
    }
  }

  for (
    const balance of
      post
  ) {
    const balanceOwner =
      await getBalanceOwner(
        balance,
      );

    if (
      balanceOwner !== owner
    ) {
      continue;
    }

    const mint =
      balance.mint;

    if (
      !mint
    ) {
      continue;
    }

    const amount =
      new BN(
        balance.uiTokenAmount
          ?.amount || "0",
      );

    const decimals =
      Number(
        balance.uiTokenAmount
          ?.decimals || 0,
      );

    const current =
      map.get(
        mint,
      );

    if (current) {
      current.delta =
        current.delta.add(
          amount,
        );
    } else {
      map.set(
        mint,
        {
          delta:
            amount,

          decimals,
        },
      );
    }
  }

  const results: Array<{
    mint: string;
    rawDelta: BN;
    rawAmount: BN;
    decimals: number;
    uiAmount: string;
  }> = [];

  for (
    const [mint, data] of
      map
  ) {
    if (
      data.delta.isZero()
    ) {
      continue;
    }

    const rawAmount =
      data.delta.abs();

    const uiAmount =
      formatTokenAmount(
        rawAmount,
        data.decimals,
      );

    results.push({
      mint,

      rawDelta:
        data.delta,

      rawAmount,

      decimals:
        data.decimals,

      uiAmount,
    });
  }

  return results;
}

// ============================================================
// TRADE DETECTION
// ============================================================

type TradeVenue =
  | "Pump.fun"
  | "PumpSwap"
  | "Jupiter v6";

interface DetectedTradeLeg {
  mint: string;
  rawAmount: BN;
  decimals: number;
  uiAmount: string;
  direction: "BUY" | "SELL";
  venue: TradeVenue;

  // Present on the direct Pump TradeEvent fast path. These values are the
  // reserves AFTER the target trade and let the copy SELL build from the
  // newest curve state without an RPC fetch.
  pumpSolAmount?: BN;
  pumpVirtualSolReserves?: BN;
  pumpVirtualTokenReserves?: BN;
  pumpRealSolReserves?: BN;
  pumpRealTokenReserves?: BN;
}

interface DetectedJupiterTokenSwap {
  direction: "SWAP";
  venue: "Jupiter v6";
  sell: DetectedTradeLeg;
  buy: DetectedTradeLeg;
}

type DetectedTrade =
  | DetectedTradeLeg
  | DetectedJupiterTokenSwap;

function buildFastPumpCurveFromTradeEvent(
  mintString: string,
  trade: DetectedTradeLeg | null | undefined,
): {
  curve: {
    exists: boolean;
    complete: boolean;
    accountInfo: any | null;
    bondingCurve: any | null;
  };
  tokenProgram: PublicKey;
  associatedUserAccountInfo?: any | null;
} | null {
  if (
    !trade ||
    trade.venue !== "Pump.fun" ||
    trade.mint !== mintString ||
    !trade.pumpVirtualSolReserves ||
    !trade.pumpVirtualTokenReserves ||
    !trade.pumpRealSolReserves ||
    !trade.pumpRealTokenReserves
  ) {
    return null;
  }

  const cached =
    fastPumpSellContextCache.get(
      mintString,
    );

  if (!cached) {
    return null;
  }

  const bondingCurve = {
    ...cached.bondingCurve,

    // Current SDKs use *SolReserves for SOL curves. Newer V2 structs use
    // *QuoteReserves. Set both names so either representation receives the
    // target trade's post-trade state.
    virtualSolReserves:
      trade.pumpVirtualSolReserves,
    virtualQuoteReserves:
      trade.pumpVirtualSolReserves,
    virtualTokenReserves:
      trade.pumpVirtualTokenReserves,
    realSolReserves:
      trade.pumpRealSolReserves,
    realQuoteReserves:
      trade.pumpRealSolReserves,
    realTokenReserves:
      trade.pumpRealTokenReserves,
  };

  return {
    curve: {
      exists:
        true,
      complete:
        Boolean(
          bondingCurve.complete,
        ),
      accountInfo:
        cached.accountInfo,
      bondingCurve,
    },
    tokenProgram:
      cached.tokenProgram,
    associatedUserAccountInfo:
      cached.associatedUserAccountInfo,
  };
}

async function detectTrade(
  tx: any,
  owner: string,
): Promise<DetectedTrade | null> {
  if (
    tx.meta?.err
  ) {
    return null;
  }

  const targetIsSigner =
    transactionHasSigner(
      tx,
      owner,
    );

  if (
    !targetIsSigner
  ) {
    console.log(
      "Target is not a transaction signer. Continuing with owner token-delta verification.",
    );
  }

  const logs =
    tx.meta?.logMessages || [];

  const logDetection =
    detectTradeFromLogs(
      logs,
    );

  const blockedPumpInstruction =
    detectPumpNonTradeInstructionFromLogs(
      logs,
    );

  const usesPump =
    transactionUsesProgram(
      tx,
      PUMP_PROGRAM_ID,
    );

  const usesPumpAmm =
    transactionUsesProgram(
      tx,
      PUMP_AMM_PROGRAM_ID,
    );

  const usesJupiter =
    transactionUsesProgram(
      tx,
      JUPITER_V6_PROGRAM_ID,
    );

  const usesPumpFee =
    transactionUsesProgram(
      tx,
      PUMP_FEE_PROGRAM_ID,
    );

  console.log(
    `Verified programs -> Jupiter=${usesJupiter} Pump=${usesPump} PumpSwap=${usesPumpAmm} PumpFees=${usesPumpFee}`,
  );

  // IMPORTANT:
  // The Pump fee-sharing program may appear inside a REAL trade.
  // Its presence alone is therefore NOT enough to reject the transaction.
  // Known fee/maintenance instructions are handled after the Jupiter branch,
  // so a Jupiter swap cannot be killed by an unrelated Pump fee CPI/log.
  if (
    usesPumpFee &&
    !logDetection.buy &&
    !logDetection.sell
  ) {
    console.log(
      "Pump fee program is present; continuing with exact trade verification.",
    );
  }

  // ==========================================================
  // JUPITER
  // ==========================================================

  if (
    usesJupiter
  ) {
    const tokenDeltas =
      await tokenDeltasForOwner(
        tx,
        owner,
      );

    const tradable =
      tokenDeltas.filter(
        x =>
          !QUOTE_MINTS.has(
            x.mint,
          ),
      );

    console.log(
      `Jupiter token deltas: ${
        tradable.length > 0
          ? tradable
              .map(
                x =>
                  `${x.mint}:${x.rawDelta.toString()}`,
              )
              .join(", ")
          : "none"
      }`,
    );

    if (
      tradable.length === 0
    ) {
      console.log(
        "Jupiter transaction has no non-quote token delta. Ignoring.",
      );

      return null;
    }

    const positive =
      tradable.filter(
        x =>
          x.rawDelta.gt(
            new BN(0),
          ),
      );

    const negative =
      tradable.filter(
        x =>
          x.rawDelta.lt(
            new BN(0),
          ),
      );

    if (
      positive.length === 1 &&
      negative.length === 0
    ) {
      const token =
        positive[0];

      section(
        "REAL BUY DETECTED",
        ANSI.green,
      );

      kv(
        "Venue",
        "Jupiter v6 (route)",
      );

      kv(
        "Mint",
        token.mint,
      );

      kv(
        "Target received",
        token.uiAmount,
      );

      return {
        mint:
          token.mint,

        rawAmount:
          token.rawAmount,

        decimals:
          token.decimals,

        uiAmount:
          token.uiAmount,

        direction:
          "BUY",

        venue:
          "Jupiter v6",
      };
    }

    if (
      negative.length === 1 &&
      positive.length === 0
    ) {
      const token =
        negative[0];

      section(
        "REAL SELL DETECTED",
        ANSI.red,
      );

      kv(
        "Venue",
        "Jupiter v6 (route)",
      );

      kv(
        "Mint",
        token.mint,
      );

      kv(
        "Target sold",
        token.uiAmount,
      );

      return {
        mint:
          token.mint,

        rawAmount:
          token.rawAmount,

        decimals:
          token.decimals,

        uiAmount:
          token.uiAmount,

        direction:
          "SELL",

        venue:
          "Jupiter v6",
      };
    }

    // Token -> token Jupiter swap.
    // Example: meme A decreases while meme B increases in the SAME atomic swap.
    // Copy strategy:
    //   1) proportionally SELL the tracked position in meme A;
    //   2) BUY meme B using the bot's normal fixed BUY_USD sizing.
    // The SELL remains protected by STRICT tracked-position rules.
    if (
      positive.length === 1 &&
      negative.length === 1
    ) {
      const bought =
        positive[0];

      const sold =
        negative[0];

      section(
        "REAL JUPITER TOKEN SWAP DETECTED",
        ANSI.magenta,
      );

      kv(
        "Venue",
        "Jupiter v6 (token -> token)",
      );

      kv(
        "Sold mint",
        sold.mint,
      );

      kv(
        "Target sold",
        sold.uiAmount,
      );

      kv(
        "Bought mint",
        bought.mint,
      );

      kv(
        "Target received",
        bought.uiAmount,
      );

      console.log(
        "Copy strategy: proportional tracked SELL first, then fixed-size BUY of received token.",
      );

      return {
        direction: "SWAP",
        venue: "Jupiter v6",

        sell: {
          mint: sold.mint,
          rawAmount: sold.rawAmount,
          decimals: sold.decimals,
          uiAmount: sold.uiAmount,
          direction: "SELL",
          venue: "Jupiter v6",
        },

        buy: {
          mint: bought.mint,
          rawAmount: bought.rawAmount,
          decimals: bought.decimals,
          uiAmount: bought.uiAmount,
          direction: "BUY",
          venue: "Jupiter v6",
        },
      };
    }

    console.log(
      `Jupiter trade ambiguous: ${positive.length} positive non-quote delta(s), ${negative.length} negative non-quote delta(s). Ignoring.`,
    );

    return null;
  }

  // ==========================================================
  // PUMP FEE / MAINTENANCE GUARD
  // ==========================================================
  //
  // This check intentionally runs AFTER Jupiter verification.
  // A transaction may contain claim-cashback / fee-sharing CPI activity
  // while still being a genuine Jupiter swap.
  //
  // For direct Pump/PumpSwap, a known maintenance instruction with no
  // explicit Buy/Sell is rejected before NET token-delta fallback. This
  // prevents distribute_fee_to_holders and similar transactions from
  // being mistaken for a BUY merely because the target received tokens.
  if (
    blockedPumpInstruction &&
    !logDetection.buy &&
    !logDetection.sell
  ) {
    console.log(
      `Known Pump non-trade/fee instruction detected (${blockedPumpInstruction}) without an explicit BUY/SELL. Ignoring.`,
    );

    return null;
  }

  if (
    blockedPumpInstruction
  ) {
    console.log(
      `Pump maintenance instruction (${blockedPumpInstruction}) is also present, but an explicit BUY/SELL exists. Continuing.`,
    );
  }

  // ==========================================================
  // DIRECT PUMP / PUMPSWAP
  // ==========================================================

  const directPump =
    usesPump ||
    usesPumpAmm;

  if (
    !directPump
  ) {
    console.log(
      "No recognized Pump/PumpSwap/Jupiter trade. Ignoring.",
    );

    return null;
  }

  // IMPORTANT:
  //
  // Pump/PumpSwap may be invoked through another program and therefore
  // appear only in inner instructions/logs. Do not reject such trades
  // only because Pump is not a top-level instruction.
  //
  // Safety is provided by tokenDeltasForOwner(): the target wallet must
  // have exactly one clear non-quote token delta before a BUY/SELL is
  // accepted. This keeps ordinary SOL/token transfers from being treated
  // as swaps merely because a Pump program appears somewhere in the tx.
  const explicitPumpDirection =
    logDetection.buy !==
    logDetection.sell;

  if (
    !explicitPumpDirection
  ) {
    const directTopLevelPump =
      (
        usesPump &&
        transactionHasTopLevelProgramInstruction(
          tx,
          PUMP_PROGRAM_ID,
        )
      ) ||
      (
        usesPumpAmm &&
        transactionHasTopLevelProgramInstruction(
          tx,
          PUMP_AMM_PROGRAM_ID,
        )
      );

    console.log(
      directTopLevelPump
        ? "No explicit Pump BUY/SELL log. Top-level Pump/PumpSwap found; verifying NET target token delta."
        : "No explicit Pump BUY/SELL log. Pump/PumpSwap is inner/routed; verifying NET target token delta.",
    );
  }

  const tokenDeltas =
    await tokenDeltasForOwner(
      tx,
      owner,
    );

  const tradable =
    tokenDeltas.filter(
      x =>
        !QUOTE_MINTS.has(
          x.mint,
        ),
    );

  console.log(
    `Pump/PumpSwap token deltas: ${
      tradable.length > 0
        ? tradable
            .map(
              x =>
                `${x.mint}:${x.rawDelta.toString()}`,
            )
            .join(", ")
        : "none"
    }`,
  );

  if (
    tradable.length === 0
  ) {
    console.log(
      "Pump/PumpSwap has no non-quote token delta. Ignoring.",
    );

    return null;
  }

  const positive =
    tradable.filter(
      x =>
        x.rawDelta.gt(
          new BN(0),
        ),
    );

  const negative =
    tradable.filter(
      x =>
        x.rawDelta.lt(
          new BN(0),
        ),
    );

  let direction:
    "BUY" |
    "SELL" |
    null = null;

  if (
    logDetection.buy &&
    !logDetection.sell
  ) {
    direction =
      "BUY";

    console.log(
      "Pump/PumpSwap direction: BUY from explicit log.",
    );
  } else if (
    logDetection.sell &&
    !logDetection.buy
  ) {
    direction =
      "SELL";

    console.log(
      "Pump/PumpSwap direction: SELL from explicit log.",
    );
  } else if (
    logDetection.buy &&
    logDetection.sell
  ) {
    console.log(
      "Both BUY and SELL appeared in direct Pump logs. Using NET token delta.",
    );
  } else {
    console.log(
      "Using NET token delta fallback.",
    );
  }

  if (
    direction === null ||
    (
      logDetection.buy &&
      logDetection.sell
    )
  ) {
    if (
      positive.length === 1 &&
      negative.length === 0
    ) {
      direction =
        "BUY";
    } else if (
      negative.length === 1 &&
      positive.length === 0
    ) {
      direction =
        "SELL";
    } else {
      console.log(
        `Pump/PumpSwap direction ambiguous: ${positive.length} positive and ${negative.length} negative non-quote token delta(s). Ignoring.`,
      );

      return null;
    }

    console.log(
      `Pump/PumpSwap direction inferred from NET token delta: ${direction}`,
    );
  }

  if (
    direction === "BUY"
  ) {
    if (
      positive.length !== 1 ||
      negative.length !== 0
    ) {
      console.log(
        `Pump BUY rejected: expected exactly 1 positive and 0 negative non-quote token deltas. Got positive=${positive.length}, negative=${negative.length}.`,
      );

      return null;
    }
  }

  if (
    direction === "SELL"
  ) {
    if (
      negative.length !== 1 ||
      positive.length !== 0
    ) {
      console.log(
        `Pump SELL rejected: expected exactly 1 negative and 0 positive non-quote token deltas. Got positive=${positive.length}, negative=${negative.length}.`,
      );

      return null;
    }
  }

  const token =
    direction === "BUY"
      ? positive[0]
      : negative[0];

  if (
    !token
  ) {
    console.log(
      "No valid token delta found. Ignoring.",
    );

    return null;
  }

  const venue:
    | "Pump.fun"
    | "PumpSwap" =
    usesPumpAmm
      ? "PumpSwap"
      : "Pump.fun";

  if (
    direction === "BUY"
  ) {
    section(
      "REAL BUY DETECTED",
      ANSI.green,
    );

    kv(
      "Venue",
      venue,
    );

    kv(
      "Type",
      logDetection.buy &&
      !logDetection.sell
        ? "Direct BUY instruction"
        : "NET token balance delta fallback",
    );

    kv(
      "Mint",
      token.mint,
    );

    kv(
      "Target received",
      token.uiAmount,
    );

    return {
      mint:
        token.mint,

      rawAmount:
        token.rawAmount,

      decimals:
        token.decimals,

      uiAmount:
        token.uiAmount,

      direction:
        "BUY",

      venue,
    };
  }

  section(
    "REAL SELL DETECTED",
    ANSI.red,
  );

  kv(
    "Venue",
    venue,
  );

  kv(
    "Type",
    logDetection.sell &&
    !logDetection.buy
      ? "Direct SELL instruction"
      : "NET token balance fallback",
  );

  kv(
    "Mint",
    token.mint,
  );

  kv(
    "Target sold",
    token.uiAmount,
  );

  return {
    mint:
      token.mint,

    rawAmount:
      token.rawAmount,

    decimals:
      token.decimals,

    uiAmount:
      token.uiAmount,

    direction:
      "SELL",

    venue,
  };
}

// ============================================================
// TRANSACTION FETCH
// ============================================================

const TARGET_TX_FETCH_TIMEOUT_MS =
  Math.max(
    150,
    Number(
      process.env.TARGET_TX_FETCH_TIMEOUT_MS || "350",
    ) || 350,
  );

async function getParsedTransactionBounded(
  signature: string,
  commitment: "processed" | "confirmed",
  timeoutMs: number,
): Promise<any | null> {
  let timer: NodeJS.Timeout | null = null;

  try {
    const timeoutPromise =
      new Promise<null>(resolve => {
        timer = setTimeout(
          () => resolve(null),
          timeoutMs,
        );
      });

    const rpcPromise =
      connection.getParsedTransaction(
        signature,
        {
          commitment,
          maxSupportedTransactionVersion: 0,
        },
      ).catch(() => null);

    return await Promise.race([
      rpcPromise,
      timeoutPromise,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function getTargetTransaction(
  signature: string,
): Promise<any | null> {
  // Fallback transactions (PumpSwap/Jupiter/unknown) must never block the
  // strict direct-Pump execution queue for tens of seconds. The old SDK call
  // could hang during RPC congestion; each attempt is now hard-bounded.
  const attempts = [
    { delayMs: 0, timeoutMs: TARGET_TX_FETCH_TIMEOUT_MS },
    { delayMs: 60, timeoutMs: TARGET_TX_FETCH_TIMEOUT_MS },
    { delayMs: 140, timeoutMs: TARGET_TX_FETCH_TIMEOUT_MS },
  ];

  for (const attempt of attempts) {
    if (attempt.delayMs > 0) {
      await sleep(attempt.delayMs);
    }

    const tx =
      await getParsedTransactionBounded(
        signature,
        "processed",
        attempt.timeoutMs,
      );

    if (tx) {
      return tx;
    }
  }

  console.log(
    `Fallback tx fetch timed out quickly for ${signature}; skipping so fast Pump trades are not delayed.`,
  );

  return null;
}

// ============================================================
// WALLET
// ============================================================

function createDryRunWallet(): Keypair {
  return Keypair.generate();
}

function loadRealWallet(): Keypair {
  const raw =
    process.env.BOT_SECRET_KEY_JSON?.trim();

  if (!raw) {
    throw new Error(
      "Missing BOT_SECRET_KEY_JSON in .env",
    );
  }

  // ==========================================================
  // FORMAT 1: JSON BYTE ARRAY
  // Example: [12,34,56,...]
  // ==========================================================

  if (
    raw.startsWith("[")
  ) {
    let parsed: unknown;

    try {
      parsed =
        JSON.parse(
          raw,
        );
    } catch {
      throw new Error(
        "BOT_SECRET_KEY_JSON starts with '[' but is not valid JSON.",
      );
    }

    if (
      !Array.isArray(parsed)
    ) {
      throw new Error(
        "BOT_SECRET_KEY_JSON must be a 64-byte JSON array or a Phantom/Base58 private key.",
      );
    }

    if (
      !parsed.every(
        value =>
          Number.isInteger(value) &&
          Number(value) >= 0 &&
          Number(value) <= 255,
      )
    ) {
      throw new Error(
        "BOT_SECRET_KEY_JSON byte array contains an invalid value. Every item must be an integer from 0 to 255.",
      );
    }

    const secret =
      Uint8Array.from(
        parsed as number[],
      );

    if (
      secret.length === 64
    ) {
      return Keypair.fromSecretKey(
        secret,
      );
    }

    throw new Error(
      `BOT_SECRET_KEY_JSON JSON key has ${secret.length} bytes; expected exactly 64.`,
    );
  }

  // ==========================================================
  // FORMAT 2: PHANTOM / BASE58 PRIVATE KEY
  // Also accepts a JSON-quoted Base58 string.
  // ==========================================================

  let base58Key =
    raw;

  if (
    raw.startsWith('"') &&
    raw.endsWith('"')
  ) {
    try {
      const parsed =
        JSON.parse(
          raw,
        );

      if (
        typeof parsed === "string"
      ) {
        base58Key =
          parsed.trim();
      }
    } catch {
      throw new Error(
        "BOT_SECRET_KEY_JSON contains an invalid quoted private key.",
      );
    }
  }

  try {
    const decoded =
      bs58.decode(
        base58Key,
      );

    if (
      decoded.length === 64
    ) {
      return Keypair.fromSecretKey(
        decoded,
      );
    }

    // Do NOT accept 32-byte Base58 here. A normal Solana public wallet
    // address also decodes to 32 bytes, and treating it as a private seed
    // would silently create a completely different wallet. Phantom's
    // exported private key for a Solana account should decode to 64 bytes.
    throw new Error(
      `decoded key has ${decoded.length} bytes; expected exactly 64. If this is 32 bytes, you probably pasted the public wallet address instead of the exported private key.`,
    );
  } catch (error) {
    throw new Error(
      `BOT_SECRET_KEY_JSON is not a valid JSON byte array or Phantom/Base58 private key: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`,
    );
  }
}

function getBotWallet(): Keypair {
  if (
    botWallet
  ) {
    return botWallet;
  }

  if (
    DRY_RUN
  ) {
    botWallet =
      createDryRunWallet();

    console.log(
      `Dry-run wallet: ${botWallet.publicKey.toBase58()}`,
    );
  } else {
    botWallet =
      loadRealWallet();

    console.log(
      `Live bot wallet: ${botWallet.publicKey.toBase58()}`,
    );
  }

  return botWallet;
}

// ============================================================
// HELIUS SENDER HELPERS
// ============================================================

function shouldUseHeliusSender(
  priorityFeeMicrolamports = PRIORITY_FEE_MICROLAMPORTS,
): boolean {
  return (
    HELIUS_SENDER_ENABLED &&
    priorityFeeMicrolamports > 0 &&
    HELIUS_SENDER_URL.length > 0
  );
}

function pickHeliusSenderTipAccount(): PublicKey {
  return HELIUS_SENDER_TIP_ACCOUNTS[
    Math.floor(
      Math.random() * HELIUS_SENDER_TIP_ACCOUNTS.length,
    )
  ];
}

function getHeliusSenderPingUrl(): string {
  try {
    const parsed = new URL(
      HELIUS_SENDER_URL,
    );

    parsed.pathname = "/ping";
    parsed.search = "";

    return parsed.toString();
  } catch {
    return "";
  }
}

async function warmHeliusSenderConnection(): Promise<void> {
  if (
    !HELIUS_SENDER_ENABLED
  ) {
    return;
  }

  const pingUrl =
    getHeliusSenderPingUrl();

  if (
    !pingUrl
  ) {
    return;
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      Math.min(
        800,
        HELIUS_SENDER_HTTP_TIMEOUT_MS,
      ),
    );

  try {
    const response =
      await fetch(
        pingUrl,
        {
          method: "GET",
          signal:
            controller.signal,
        },
      );

    // Drain the tiny ping response so the underlying HTTP connection can be
    // reused efficiently by Node's fetch/undici connection pool.
    await response.text()
      .catch(() => "");
  } catch {
    // Warming is best-effort. Never block trading because a ping failed.
  } finally {
    clearTimeout(
      timeout,
    );
  }
}

async function sendSerializedTransactionViaHeliusSender(
  serialized: Uint8Array,
  expectedSignature: string,
  endpoint: string = HELIUS_SENDER_URL,
): Promise<string> {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      HELIUS_SENDER_HTTP_TIMEOUT_MS,
    );

  try {
    const response =
      await fetch(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body:
            JSON.stringify({
              jsonrpc:
                "2.0",
              id:
                Date.now().toString(),
              method:
                "sendTransaction",
              params: [
                Buffer.from(
                  serialized,
                ).toString(
                  "base64",
                ),
                {
                  encoding:
                    "base64",
                  skipPreflight:
                    true,
                  maxRetries:
                    0,
                },
              ],
            }),
          signal:
            controller.signal,
        },
      );

    const text =
      await response.text();

    if (
      !response.ok
    ) {
      throw new Error(
        `Helius Sender HTTP ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    let payload:
      any;

    try {
      payload =
        JSON.parse(
          text,
        );
    } catch {
      throw new Error(
        `Helius Sender returned non-JSON response: ${text.slice(0, 500)}`,
      );
    }

    if (
      payload?.error
    ) {
      throw new Error(
        `Helius Sender error: ${JSON.stringify(payload.error)}`,
      );
    }

    const senderSignature =
      String(
        payload?.result ||
        expectedSignature ||
        "",
      );

    if (
      !senderSignature
    ) {
      throw new Error(
        "Helius Sender returned no transaction signature.",
      );
    }

    return senderSignature;
  } finally {
    clearTimeout(
      timeout,
    );
  }
}

// ============================================================
// SEND TRANSACTION
// ============================================================

async function confirmSubmittedTransactionInBackground(
  signature: string,
  latestBlockhash: {
    blockhash: string;
    lastValidBlockHeight: number;
  },
  label: string,
): Promise<void> {
  try {
    const confirmation =
      await connection.confirmTransaction(
        {
          signature,
          blockhash:
            latestBlockhash.blockhash,
          lastValidBlockHeight:
            latestBlockhash.lastValidBlockHeight,
        },
        "confirmed",
      );

    if (
      confirmation.value.err
    ) {
      console.error(
        `${label} failed on-chain:`,
        confirmation.value.err,
      );

      return;
    }

    console.log(
      `${label} confirmed: ${signature}`,
    );
  } catch (error) {
    console.log(
      `${label} background confirmation error:`,
      error,
    );
  }
}

function logProcessedLatencyInBackground(
  signature: string,
  label: string,
  networkWriteStartedAtMs: number,
  targetObservedAtMs: number | null,
): void {
  void waitForSignatureProcessed(
    signature,
    `${label} LATENCY`,
  )
    .then(() => {
      const now = Date.now();
      console.log(
        `LANDING ${label}: network write -> processed ${now - networkWriteStartedAtMs} ms`,
      );

      if (targetObservedAtMs !== null) {
        console.log(
          `LANDING ${label}: target seen -> processed ${now - targetObservedAtMs} ms`,
        );
      }
    })
    .catch(() => undefined);
}

interface SendInstructionsOptions {
  priorityFeeMicrolamports?: number;
  senderTipLamports?: number;
  turboDualBroadcast?: boolean;
  senderUrls?: string[];
}

async function sendInstructions(
  wallet: Keypair,
  instructions: any[],
  label: string,
  options: SendInstructionsOptions = {},
): Promise<string> {
  if (
    instructions.length === 0
  ) {
    throw new Error(
      `${label}: no instructions generated.`,
    );
  }

  const priorityFeeMicrolamports =
    Math.max(
      0,
      options.priorityFeeMicrolamports ??
        PRIORITY_FEE_MICROLAMPORTS,
    );

  const senderTipLamports =
    Math.max(
      5_000,
      options.senderTipLamports ??
        HELIUS_SENDER_TIP_LAMPORTS,
    );

  const turboDualBroadcast =
    Boolean(
      options.turboDualBroadcast,
    );

  const useSender =
    shouldUseHeliusSender(
      priorityFeeMicrolamports,
    );

  const finalInstructions:
    any[] = [];

  if (
    priorityFeeMicrolamports > 0
  ) {
    finalInstructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports:
          priorityFeeMicrolamports,
      }),
    );
  }

  finalInstructions.push(
    ...instructions,
  );

  if (
    useSender
  ) {
    finalInstructions.push(
      SystemProgram.transfer({
        fromPubkey:
          wallet.publicKey,
        toPubkey:
          pickHeliusSenderTipAccount(),
        lamports:
          senderTipLamports,
      }),
    );
  }

  const latestBlockhash =
    await getFastLatestBlockhash();

  const message =
    new TransactionMessage({
      payerKey:
        wallet.publicKey,
      recentBlockhash:
        latestBlockhash.blockhash,
      instructions:
        finalInstructions,
    }).compileToV0Message();

  const transaction =
    new VersionedTransaction(
      message,
    );

  transaction.sign([
    wallet,
  ]);

  const serialized =
    transaction.serialize();

  const localSignature =
    bs58.encode(
      transaction.signatures[0],
    );

  let signature:
    string =
      localSignature;

  let sentViaSender =
    false;

  const targetObservedAtMs =
    currentTradeObservedAtMs;

  const networkWriteStartedAtMs =
    Date.now();

  // TURBO TX: start every useful propagation path immediately and do not
  // wait for an HTTP acknowledgement before returning the locally-known
  // signature. The same signed transaction is used everywhere, so duplicate
  // submissions cannot execute twice.
  if (
    turboDualBroadcast &&
    useSender
  ) {
    const urls =
      Array.from(
        new Set(
          (options.senderUrls && options.senderUrls.length > 0
            ? options.senderUrls
            : SELL_SENDER_URLS
          ).filter(Boolean),
        ),
      );

    console.log(
      `${label}: TURBO broadcast -> ${urls.length} Helius Sender region(s) + RPC (priority ${priorityFeeMicrolamports} µ-lamports/CU, tip ${senderTipLamports} lamports)...`,
    );

    for (const endpoint of urls) {
      void sendSerializedTransactionViaHeliusSender(
        serialized,
        localSignature,
        endpoint,
      )
        .then(
          () => {
            console.log(
              `${label}: Sender accepted via ${safeEndpointLabel(endpoint)}`,
            );
          },
        )
        .catch(
          error => {
            console.log(
              `${label}: Sender region warning (${safeEndpointLabel(endpoint)}):`,
              error,
            );
          },
        );
    }

    // Independent standard RPC propagation. On Free Helius this may be rate
    // limited, but it runs in the background and can only help; Sender remains
    // the primary path.
    void connection.sendRawTransaction(
      serialized,
      {
        skipPreflight:
          true,
        maxRetries:
          0,
        preflightCommitment:
          "processed",
      },
    )
      .catch(
        error => {
          console.log(
            `${label}: background RPC broadcast warning:`,
            error,
          );
        },
      );

    sentViaSender =
      true;
  } else if (
    useSender
  ) {
    console.log(
      `${label}: sending FAST via Helius Sender SWQOS (priority ${priorityFeeMicrolamports} µ-lamports/CU, tip ${senderTipLamports} lamports)...`,
    );

    try {
      signature =
        await sendSerializedTransactionViaHeliusSender(
          serialized,
          localSignature,
        );

      sentViaSender =
        true;
    } catch (error) {
      status(
        `${label}: Helius Sender failed/timed out; broadcasting the same signed transaction through RPC fallback.`,
        "warning",
      );

      console.log(
        `${label} Sender detail:`,
        error,
      );

      signature =
        await connection.sendRawTransaction(
          serialized,
          {
            skipPreflight:
              true,
            maxRetries:
              0,
            preflightCommitment:
              "processed",
          },
        );
    }
  } else {
    if (
      HELIUS_SENDER_ENABLED &&
      priorityFeeMicrolamports <= 0
    ) {
      console.log(
        `${label}: Sender not used because priority fee is 0. Using normal RPC sender.`,
      );
    } else {
      console.log(
        priorityFeeMicrolamports > 0
          ? `${label}: sending FAST (priority ${priorityFeeMicrolamports} µ-lamports/CU)...`
          : `${label}: sending FAST (no priority fee)...`,
      );
    }

    signature =
      await connection.sendRawTransaction(
        serialized,
        {
          skipPreflight:
            true,
          maxRetries:
            0,
          preflightCommitment:
            "processed",
        },
      );
  }

  console.log(
    turboDualBroadcast && sentViaSender
      ? `${label} TURBO BROADCAST STARTED: ${signature}`
      : sentViaSender
        ? `${label} SENT via HELIUS SENDER: ${signature}`
        : `${label} SENT: ${signature}`,
  );

  if (
    currentTradeObservedAtMs !== null
  ) {
    console.log(
      `LATENCY target seen -> ${label} broadcast: ${Date.now() - currentTradeObservedAtMs} ms`,
    );
  }

  console.log(
    `https://solscan.io/tx/${signature}`,
  );

  logProcessedLatencyInBackground(
    signature,
    label,
    networkWriteStartedAtMs,
    targetObservedAtMs,
  );

  void confirmSubmittedTransactionInBackground(
    signature,
    latestBlockhash,
    label,
  );

  return signature;
}

// ============================================================
// TOKEN BALANCE
// ============================================================

async function getWalletTokenBalance(
  wallet: PublicKey,
  mint: PublicKey,
  commitment: Commitment = "processed",
): Promise<BN> {
  const accounts =
    await connection.getParsedTokenAccountsByOwner(
      wallet,
      {
        mint,
      },
      commitment,
    );

  let total =
    new BN(0);

  for (
    const account of
      accounts.value
  ) {
    const amount =
      account.account.data.parsed
        ?.info?.tokenAmount?.amount;

    if (
      typeof amount === "string"
    ) {
      total =
        total.add(
          new BN(amount),
        );
    }
  }

  return total;
}

async function getWalletTokenBalanceFast(
  wallet: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey | null,
  commitment: Commitment = "processed",
): Promise<BN> {
  if (
    !tokenProgram
  ) {
    return getWalletTokenBalance(
      wallet,
      mint,
      commitment,
    );
  }

  try {
    const ata =
      getAssociatedTokenAddressSync(
        mint,
        wallet,
        false,
        tokenProgram,
      );

    const balance =
      await connection.getTokenAccountBalance(
        ata,
        commitment,
      );

    return new BN(
      balance.value.amount,
    );
  } catch {
    // The ATA does not exist yet for a first BUY. That is a valid zero
    // balance and avoids the much heavier parsed-token-accounts scan.
    return new BN(0);
  }
}

async function throwIfSignatureFailed(
  signature: string | null,
  label: string,
): Promise<void> {
  if (!signature) {
    return;
  }

  try {
    const statuses =
      await connection.getSignatureStatuses(
        [signature],
        {
          searchTransactionHistory:
            false,
        },
      );

    const status =
      statuses.value[0];

    if (
      status?.err
    ) {
      throw new Error(
        `${label} failed on-chain: ${JSON.stringify(
          status.err,
        )}`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(
        "failed on-chain",
      )
    ) {
      throw error;
    }

    // A transient status lookup error should not block the fast balance path.
  }
}

async function waitForSignatureCommitment(
  signature: string | null,
  label: string,
  commitment: "processed" | "confirmed",
  timeoutMs: number,
): Promise<void> {
  if (!signature) {
    return;
  }

  await new Promise<void>(
    (resolve, reject) => {
      let finished = false;
      let subscriptionId: number | null = null;

      const finish = (
        error?: Error,
      ) => {
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timer);

        if (
          subscriptionId !== null
        ) {
          void connection
            .removeSignatureListener(
              subscriptionId,
            )
            .catch(
              () => undefined,
            );
        }

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const timer = setTimeout(
        () => {
          // Exactly one HTTP status read on timeout. Do not poll here.
          void connection
            .getSignatureStatuses(
              [signature],
              {
                searchTransactionHistory:
                  false,
              },
            )
            .then(
              statuses => {
                const status =
                  statuses.value[0];

                if (
                  status?.err
                ) {
                  finish(
                    new Error(
                      `${label} failed on-chain: ${JSON.stringify(
                        status.err,
                      )}`,
                    ),
                  );

                  return;
                }

                const confirmationStatus =
                  status?.confirmationStatus;

                const reached =
                  commitment === "processed"
                    ? confirmationStatus === "processed" ||
                      confirmationStatus === "confirmed" ||
                      confirmationStatus === "finalized"
                    : confirmationStatus === "confirmed" ||
                      confirmationStatus === "finalized";

                if (reached) {
                  finish();
                  return;
                }

                finish(
                  new Error(
                    `${label} was sent but did not reach ${commitment} before timeout.`,
                  ),
                );
              },
            )
            .catch(
              () => {
                finish(
                  new Error(
                    `${label} ${commitment} confirmation timed out.`,
                  ),
                );
              },
            );
        },
        timeoutMs,
      );

      try {
        subscriptionId =
          connection.onSignature(
            signature,
            result => {
              if (
                result.err
              ) {
                finish(
                  new Error(
                    `${label} failed on-chain: ${JSON.stringify(
                      result.err,
                    )}`,
                  ),
                );

                return;
              }

              finish();
            },
            commitment,
          );
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error(
                String(error),
              ),
        );
      }
    },
  );
}

async function waitForSignatureProcessed(
  signature: string | null,
  label: string,
): Promise<void> {
  return waitForSignatureCommitment(
    signature,
    label,
    "processed",
    SIGNATURE_PROCESSED_TIMEOUT_MS,
  );
}

async function waitForSignatureConfirmed(
  signature: string | null,
  label: string,
): Promise<void> {
  return waitForSignatureCommitment(
    signature,
    label,
    "confirmed",
    SIGNATURE_CONFIRMED_TIMEOUT_MS,
  );
}

async function readChangedTokenBalance(
  wallet: PublicKey,
  mint: PublicKey,
  previousBalance: BN,
  direction: "BUY" | "SELL",
  commitment: Commitment,
  attempts: number,
  tokenProgram: PublicKey | null = null,
): Promise<BN | null> {
  for (
    let attempt = 0;
    attempt < attempts;
    attempt++
  ) {
    try {
      const current =
        await getWalletTokenBalanceFast(
          wallet,
          mint,
          tokenProgram,
          commitment,
        );

      const changed =
        direction === "BUY"
          ? current.gt(
              previousBalance,
            )
          : current.lt(
              previousBalance,
            );

      if (changed) {
        return current;
      }
    } catch (error) {
      // Do not spin on 429 or stale RPC state. A WebSocket confirmation and
      // the confirmed fallback below are cheaper and usually faster.
      if (
        attempt === attempts - 1
      ) {
        console.log(
          `${direction} ${commitment} balance read warning:`,
          error,
        );
      }
    }

    if (
      attempt < attempts - 1
    ) {
      await sleep(
        BALANCE_READ_DELAY_MS,
      );
    }
  }

  return null;
}

async function waitForTokenBalance(
  wallet: PublicKey,
  mint: PublicKey,
  previousBalance: BN,
  signature: string | null = null,
  tokenProgram: PublicKey | null = null,
): Promise<BN> {
  await waitForSignatureProcessed(
    signature,
    "BUY",
  );

  const processedBalance =
    await readChangedTokenBalance(
      wallet,
      mint,
      previousBalance,
      "BUY",
      "processed",
      BALANCE_READ_RETRIES,
      tokenProgram,
    );

  if (processedBalance) {
    return processedBalance;
  }

  // If processed account state is briefly stale, wait on WebSocket for the
  // same signature to become confirmed, then perform one confirmed read.
  // This avoids the old high-frequency polling / HTTP 429 failure mode.
  await waitForSignatureConfirmed(
    signature,
    "BUY",
  );

  const confirmedBalance =
    await readChangedTokenBalance(
      wallet,
      mint,
      previousBalance,
      "BUY",
      "confirmed",
      1,
      tokenProgram,
    );

  return confirmedBalance ||
    getWalletTokenBalanceFast(
      wallet,
      mint,
      tokenProgram,
      "confirmed",
    );
}

async function waitForTokenBalanceDecrease(
  wallet: PublicKey,
  mint: PublicKey,
  previousBalance: BN,
  signature: string | null = null,
  tokenProgram: PublicKey | null = null,
): Promise<BN> {
  await waitForSignatureProcessed(
    signature,
    "SELL",
  );

  const processedBalance =
    await readChangedTokenBalance(
      wallet,
      mint,
      previousBalance,
      "SELL",
      "processed",
      BALANCE_READ_RETRIES,
      tokenProgram,
    );

  if (processedBalance) {
    return processedBalance;
  }

  await waitForSignatureConfirmed(
    signature,
    "SELL",
  );

  const confirmedBalance =
    await readChangedTokenBalance(
      wallet,
      mint,
      previousBalance,
      "SELL",
      "confirmed",
      1,
      tokenProgram,
    );

  return confirmedBalance ||
    getWalletTokenBalanceFast(
      wallet,
      mint,
      tokenProgram,
      "confirmed",
    );
}

// ============================================================
// TOKEN PROGRAM
// ============================================================

function seedMintProgramCacheFromTransaction(
  tx: any,
  mintString: string,
): void {
  if (
    mintProgramCache.has(
      mintString,
    )
  ) {
    return;
  }

  const balances = [
    ...(tx?.meta?.preTokenBalances || []),
    ...(tx?.meta?.postTokenBalances || []),
  ];

  for (
    const balance of balances
  ) {
    if (
      balance?.mint !==
      mintString
    ) {
      continue;
    }

    const programId =
      balance?.programId
        ? normalizePublicKey(
            balance.programId,
          )
        : "";

    if (
      programId ===
      TOKEN_2022_PROGRAM_ID.toBase58()
    ) {
      mintProgramCache.set(
        mintString,
        TOKEN_2022_PROGRAM_ID,
      );
      return;
    }

    if (
      programId ===
      TOKEN_PROGRAM_ID.toBase58()
    ) {
      mintProgramCache.set(
        mintString,
        TOKEN_PROGRAM_ID,
      );
      return;
    }
  }
}

async function getMintTokenProgram(
  mint: PublicKey,
): Promise<PublicKey> {
  const mintString =
    mint.toBase58();

  const cached =
    mintProgramCache.get(
      mintString,
    );

  if (cached) {
    return cached;
  }

  let tokenProgram =
    TOKEN_PROGRAM_ID;

  try {
    const accountInfo =
      await connection.getAccountInfo(
        mint,
        "processed",
      );

    if (
      accountInfo?.owner?.equals(
        TOKEN_2022_PROGRAM_ID,
      )
    ) {
      tokenProgram =
        TOKEN_2022_PROGRAM_ID;
    }
  } catch (error) {
    console.log(
      `Could not resolve token program for ${mintString}; using classic SPL Token Program.`,
      error,
    );
  }

  mintProgramCache.set(
    mintString,
    tokenProgram,
  );

  return tokenProgram;
}

// ============================================================
// BONDING CURVE
// ============================================================

async function getBondingCurveState(
  mint: PublicKey,
): Promise<{
  exists: boolean;
  complete: boolean;
  accountInfo: any | null;
  bondingCurve: any | null;
}> {
  const address =
    bondingCurvePda(
      mint,
    );

  const accountInfo =
    await connection.getAccountInfo(
      address,
      "processed",
    );

  if (!accountInfo) {
    return {
      exists:
        false,

      complete:
        true,

      accountInfo:
        null,

      bondingCurve:
        null,
    };
  }

  // Some old/migrated Pump PDAs can still resolve to an account whose
  // data is empty or no longer decodes as an active BondingCurve.
  // Treat that as "no active bonding curve" instead of throwing and
  // crashing the copy path.
  if (
    !accountInfo.data ||
    accountInfo.data.length === 0
  ) {
    return {
      exists:
        false,

      complete:
        true,

      accountInfo,

      bondingCurve:
        null,
    };
  }

  let bondingCurve:
    any | null =
    null;

  try {
    bondingCurve =
      PUMP_SDK.decodeBondingCurveNullable(
        accountInfo,
      );
  } catch {
    console.log(
      `Bonding curve decode unavailable for ${mint.toBase58()}; checking PumpSwap instead.`,
    );

    return {
      exists:
        false,

      complete:
        true,

      accountInfo,

      bondingCurve:
        null,
    };
  }

  if (!bondingCurve) {
    return {
      exists:
        false,

      complete:
        true,

      accountInfo,

      bondingCurve:
        null,
    };
  }

  return {
    exists:
      true,

    complete:
      Boolean(
        bondingCurve.complete,
      ),

    accountInfo,

    bondingCurve,
  };
}

// ============================================================
// PUMPSWAP POOL CHECK
// ============================================================

async function pumpSwapPoolExists(
  mint: PublicKey,
): Promise<boolean> {
  try {
    const pool =
      canonicalPumpPoolPda(
        mint,
      );

    const accountInfo =
      await connection.getAccountInfo(
        pool,
        "processed",
      );

    return Boolean(
      accountInfo,
    );
  } catch {
    return false;
  }
}

// ============================================================
// DRY-RUN BUY ESTIMATION HELPERS
// ============================================================

function getNativeSolSpentByOwner(
  tx: any,
  owner: string,
): BN {
  const accountKeys =
    getTransactionAccountKeys(
      tx,
    );

  const ownerIndex =
    accountKeys.indexOf(
      owner,
    );

  if (
    ownerIndex < 0
  ) {
    return new BN(0);
  }

  const preBalance =
    tx.meta?.preBalances?.[
      ownerIndex
    ];

  const postBalance =
    tx.meta?.postBalances?.[
      ownerIndex
    ];

  if (
    typeof preBalance !== "number" ||
    typeof postBalance !== "number" ||
    preBalance <= postBalance
  ) {
    return new BN(0);
  }

  return new BN(
    Math.floor(
      preBalance -
      postBalance,
    ),
  );
}

async function estimateDryRunPumpSwapBuyAmount(
  tx: any,
  targetTokenAmount: BN,
  botSolAmount: BN,
): Promise<BN | null> {
  try {
    const tokenDeltas =
      await tokenDeltasForOwner(
        tx,
        TARGET_WALLET,
      );

    const wsolSpent =
      tokenDeltas.find(
        delta =>
          delta.mint ===
            WSOL_MINT &&
          delta.rawDelta.isNeg(),
      );

    if (
      wsolSpent &&
      !wsolSpent.rawAmount.isZero()
    ) {
      const estimated =
        targetTokenAmount
          .mul(
            botSolAmount,
          )
          .div(
            wsolSpent.rawAmount,
          );

      if (
        !estimated.isZero()
      ) {
        console.log(
          "DRY RUN sizing: estimated from target WSOL spend.",
        );

        return estimated;
      }
    }

    const nativeSolSpent =
      getNativeSolSpentByOwner(
        tx,
        TARGET_WALLET,
      );

    if (
      !nativeSolSpent.isZero()
    ) {
      const estimated =
        targetTokenAmount
          .mul(
            botSolAmount,
          )
          .div(
            nativeSolSpent,
          );

      if (
        !estimated.isZero()
      ) {
        console.log(
          "DRY RUN sizing: estimated from target native SOL spend.",
        );

        return estimated;
      }
    }

    const usdcSpent =
      tokenDeltas.find(
        delta =>
          delta.mint ===
            USDC_MINT &&
          delta.rawDelta.isNeg(),
      );

    if (
      usdcSpent &&
      !usdcSpent.rawAmount.isZero()
    ) {
      const botUsdRaw =
        new BN(
          Math.max(
            1,
            Math.floor(
              BUY_USD *
              1_000_000,
            ),
          ),
        );

      const estimated =
        targetTokenAmount
          .mul(
            botUsdRaw,
          )
          .div(
            usdcSpent.rawAmount,
          );

      if (
        !estimated.isZero()
      ) {
        console.log(
          "DRY RUN sizing: estimated from target USDC spend.",
        );

        return estimated;
      }
    }
  } catch (error) {
    console.log(
      "DRY RUN sizing estimate failed:",
      error,
    );
  }

  return null;
}

// ============================================================
// JUPITER SWAP EXECUTION
// ============================================================
//
// Execution rules:
//   - With JUPITER_API_KEY: current Jupiter Swap V2 /order + /execute.
//   - Without an API key: Jupiter lite Swap V1 quote + swap transaction.
//
// BUY:  native SOL/WSOL -> target mint.
// SELL: target mint -> native SOL/WSOL.
//
// SLIPPAGE in .env is expressed as percent (for example 8 = 8%).
// Jupiter expects basis points, so 8% becomes 800 bps.
// ============================================================

type JupiterSwapResult = {
  signature: string | null;
  outAmount: BN;
};

function jupiterSlippageBps(): number {
  return Math.max(
    1,
    Math.min(
      10_000,
      Math.round(
        SLIPPAGE * 100,
      ),
    ),
  );
}

function jupiterHeaders(
  includeJson = false,
): Record<string, string> {
  const headers:
    Record<string, string> = {};

  if (
    includeJson
  ) {
    headers["Content-Type"] =
      "application/json";
  }

  if (
    JUPITER_API_KEY
  ) {
    headers["x-api-key"] =
      JUPITER_API_KEY;
  }

  return headers;
}

async function readJsonResponse(
  response: Response,
  label: string,
): Promise<any> {
  const raw =
    await response.text();

  let data:
    any = null;

  try {
    data =
      raw
        ? JSON.parse(raw)
        : null;
  } catch {
    data = null;
  }

  if (
    !response.ok
  ) {
    throw new Error(
      `${label} HTTP ${response.status}: ${raw.slice(0, 500)}`,
    );
  }

  if (
    !data
  ) {
    throw new Error(
      `${label}: empty/invalid JSON response.`,
    );
  }

  return data;
}

async function fetchJupiterJson(
  url: string,
  init: RequestInit | undefined,
  label: string,
): Promise<any> {
  let lastError:
    unknown = null;

  for (
    let attempt = 0;
    attempt <= JUPITER_HTTP_RETRIES;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () => controller.abort(),
        JUPITER_HTTP_TIMEOUT_MS,
      );

    try {
      const response =
        await fetch(
          url,
          {
            ...(init || {}),
            signal:
              controller.signal,
          },
        );

      const retryableStatus =
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;

      if (
        retryableStatus &&
        attempt < JUPITER_HTTP_RETRIES
      ) {
        const body =
          await response.text();

        console.log(
          `${label}: HTTP ${response.status}; retrying (${attempt + 1}/${JUPITER_HTTP_RETRIES})... ${body.slice(0, 180)}`,
        );

        await sleep(
          250 * (attempt + 1),
        );

        continue;
      }

      return await readJsonResponse(
        response,
        label,
      );
    } catch (error) {
      lastError = error;

      if (
        attempt >= JUPITER_HTTP_RETRIES
      ) {
        throw error;
      }

      console.log(
        `${label}: request failed; retrying (${attempt + 1}/${JUPITER_HTTP_RETRIES})...`,
        error,
      );

      await sleep(
        250 * (attempt + 1),
      );
    } finally {
      clearTimeout(
        timer,
      );
    }
  }

  throw (
    lastError instanceof Error
      ? lastError
      : new Error(
          `${label}: Jupiter request failed.`,
        )
  );
}

async function executeJupiterSwapV1(
  wallet: Keypair,
  inputMint: string,
  outputMint: string,
  amount: BN,
  label: string,
): Promise<JupiterSwapResult> {
  if (
    amount.isZero() ||
    amount.isNeg()
  ) {
    throw new Error(
      `${label}: Jupiter input amount must be positive.`,
    );
  }

  // Keep the Lite/free-tier quote intentionally minimal. Jupiter already
  // defaults restrictIntermediateTokens=true and onlyDirectRoutes=false.
  // Omitting optional route flags avoids free-tier NOT_SUPPORTED errors.
  const params =
    new URLSearchParams({
      inputMint,
      outputMint,
      amount:
        amount.toString(),
      slippageBps:
        String(
          jupiterSlippageBps(),
        ),
      swapMode:
        "ExactIn",

      // Keep Jupiter-built versioned transactions below Solana's packet-size
      // limit. 48 still leaves enough room for common AMMs while avoiding the
      // oversized-message RangeError seen on large multi-account routes.
      maxAccounts:
        "48",
    });

  const quoteUrl =
    `${JUPITER_V1_API_BASE}/quote?${params.toString()}`;

  console.log(
    `${label}: requesting Jupiter quote...`,
  );

  const quote =
    await fetchJupiterJson(
      quoteUrl,
      {
        headers:
          jupiterHeaders(false),
      },
      `${label} quote`,
    );

  if (
    quote.error
  ) {
    throw new Error(
      `${label} quote failed: ${String(quote.error)}`,
    );
  }

  const outAmount =
    new BN(
      String(
        quote.outAmount ||
        "0",
      ),
    );

  if (
    outAmount.isZero()
  ) {
    throw new Error(
      `${label}: Jupiter returned zero output amount.`,
    );
  }

  console.log(
    `${label}: Jupiter quoted output raw=${outAmount.toString()}`,
  );

  if (
    DRY_RUN
  ) {
    console.log(
      `DRY RUN: ${label} NOT sent.`,
    );

    return {
      signature:
        null,
      outAmount,
    };
  }

  const swap =
    await fetchJupiterJson(
      `${JUPITER_V1_API_BASE}/swap`,
      {
        method:
          "POST",
        headers:
          jupiterHeaders(true),
        body:
          JSON.stringify({
            quoteResponse:
              quote,
            userPublicKey:
              wallet.publicKey.toBase58(),
            wrapAndUnwrapSol:
              true,
            dynamicComputeUnitLimit:
              true,
          }),
      },
      `${label} build`,
    );

  if (
    !swap.swapTransaction
  ) {
    throw new Error(
      `${label}: Jupiter did not return swapTransaction.`,
    );
  }

  const transaction =
    VersionedTransaction.deserialize(
      Buffer.from(
        swap.swapTransaction,
        "base64",
      ),
    );

  try {
    transaction.sign([
      wallet,
    ]);
  } catch (error) {
    if (
      error instanceof RangeError &&
      String(error.message).includes(
        "encoding overruns Uint8Array",
      )
    ) {
      throw new Error(
        `${label}: Jupiter built an oversized transaction. The quote is now capped with maxAccounts=48; if this still occurs, the route needs a lower-account requote.`,
      );
    }

    throw error;
  }

  console.log(
    `${label}: sending Jupiter transaction...`,
  );

  const signature =
    await connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight:
          true,
        maxRetries:
          1,
      },
    );

  console.log(
    `${label} SENT: ${signature}`,
  );

  console.log(
    `https://solscan.io/tx/${signature}`,
  );

  void connection
    .confirmTransaction(
      signature,
      "confirmed",
    )
    .then(
      result => {
        if (
          result.value.err
        ) {
          console.error(
            `${label} failed:`,
            result.value.err,
          );
        } else {
          console.log(
            `${label} confirmed: ${signature}`,
          );
        }
      },
    )
    .catch(
      error => {
        console.log(
          `${label} confirmation error:`,
          error,
        );
      },
    );

  return {
    signature,
    outAmount,
  };
}

async function executeJupiterSwapV2(
  wallet: Keypair,
  inputMint: string,
  outputMint: string,
  amount: BN,
  label: string,
): Promise<JupiterSwapResult> {
  if (
    amount.isZero() ||
    amount.isNeg()
  ) {
    throw new Error(
      `${label}: Jupiter input amount must be positive.`,
    );
  }

  const params =
    new URLSearchParams({
      inputMint,
      outputMint,
      amount:
        amount.toString(),
      taker:
        wallet.publicKey.toBase58(),
    });

  if (
    JUPITER_V2_USE_MANUAL_SLIPPAGE
  ) {
    params.set(
      "slippageBps",
      String(
        jupiterSlippageBps(),
      ),
    );
  }

  console.log(
    `${label}: requesting Jupiter Swap V2 order...`,
  );

  const order =
    await fetchJupiterJson(
      `${JUPITER_V2_API_BASE}/order?${params.toString()}`,
      {
        headers:
          jupiterHeaders(false),
      },
      `${label} order`,
    );

  if (
    order.error ||
    order.errorMessage
  ) {
    throw new Error(
      `${label} order failed: ${String(order.errorMessage || order.error)}`,
    );
  }

  const outAmount =
    new BN(
      String(
        order.outAmount ||
        order.outputAmount ||
        "0",
      ),
    );

  if (
    outAmount.isZero()
  ) {
    throw new Error(
      `${label}: Jupiter V2 returned zero output amount.`,
    );
  }

  console.log(
    `${label}: Jupiter V2 quoted output raw=${outAmount.toString()} router=${String(order.router || "unknown")}`,
  );

  if (
    DRY_RUN
  ) {
    console.log(
      `DRY RUN: ${label} NOT sent.`,
    );

    return {
      signature:
        null,
      outAmount,
    };
  }

  if (
    !order.transaction ||
    !order.requestId
  ) {
    throw new Error(
      `${label}: Jupiter V2 order did not return transaction/requestId.`,
    );
  }

  const transaction =
    VersionedTransaction.deserialize(
      Buffer.from(
        order.transaction,
        "base64",
      ),
    );

  transaction.sign([
    wallet,
  ]);

  const signedTransaction =
    Buffer.from(
      transaction.serialize(),
    ).toString(
      "base64",
    );

  console.log(
    `${label}: executing through Jupiter...`,
  );

  const result =
    await fetchJupiterJson(
      `${JUPITER_V2_API_BASE}/execute`,
      {
        method:
          "POST",
        headers:
          jupiterHeaders(true),
        body:
          JSON.stringify({
            signedTransaction,
            requestId:
              order.requestId,
            ...(order.lastValidBlockHeight
              ? {
                  lastValidBlockHeight:
                    String(
                      order.lastValidBlockHeight,
                    ),
                }
              : {}),
          }),
      },
      `${label} execute`,
    );

  if (
    result.status !== "Success"
  ) {
    throw new Error(
      `${label} Jupiter execute failed: ${String(result.error || result.code || result.status)}`,
    );
  }

  const signature =
    String(
      result.signature ||
      "",
    );

  if (
    !signature
  ) {
    throw new Error(
      `${label}: Jupiter execute succeeded without a signature.`,
    );
  }

  const actualOut =
    new BN(
      String(
        // totalOutputAmount is the amount that actually reaches the wallet
        // after any Jupiter fee charged in the output mint.
        result.totalOutputAmount ||
        result.outputAmountResult ||
        outAmount.toString(),
      ),
    );

  console.log(
    `${label} SENT: ${signature}`,
  );

  console.log(
    `https://solscan.io/tx/${signature}`,
  );

  return {
    signature,
    outAmount:
      actualOut,
  };
}

async function executeJupiterSwap(
  wallet: Keypair,
  inputMint: string,
  outputMint: string,
  amount: BN,
  label: string,
): Promise<JupiterSwapResult> {
  if (
    JUPITER_API_KEY
  ) {
    return executeJupiterSwapV2(
      wallet,
      inputMint,
      outputMint,
      amount,
      label,
    );
  }

  return executeJupiterSwapV1(
    wallet,
    inputMint,
    outputMint,
    amount,
    label,
  );
}

async function copyJupiterBuy(
  mint: PublicKey,
  wallet: Keypair,
  solAmountBN: BN,
): Promise<JupiterSwapResult> {
  console.log(
    "Building Jupiter BUY...",
  );

  return executeJupiterSwap(
    wallet,
    WSOL_MINT,
    mint.toBase58(),
    solAmountBN,
    "JUPITER BUY",
  );
}

async function copyJupiterSell(
  mint: PublicKey,
  wallet: Keypair,
  tokenAmount: BN,
): Promise<JupiterSwapResult> {
  console.log(
    "Building Jupiter SELL...",
  );

  return executeJupiterSwap(
    wallet,
    mint.toBase58(),
    WSOL_MINT,
    tokenAmount,
    "JUPITER SELL",
  );
}

// ============================================================
// PUMPSWAP BUY
// ============================================================

async function copyPumpSwapBuy(
  mint: PublicKey,
  wallet: Keypair,
  solAmountBN: BN,
): Promise<string | null> {
  console.log(
    "Building PumpSwap BUY...",
  );

  const pool =
    canonicalPumpPoolPda(
      mint,
    );

  const swapSolanaState =
    await pumpAmm.swapSolanaState(
      pool,
      wallet.publicKey,
    );

  const instructions =
    await PUMP_AMM_SDK.buyQuoteInput(
      swapSolanaState,
      solAmountBN,
      SLIPPAGE,
    );
 if (
    DRY_RUN
  ) {
    console.log(
      "DRY RUN: PumpSwap BUY NOT sent.",
    );

    return null;
  }

  return sendInstructions(
    wallet,
    instructions,
    "PUMPSWAP BUY",
  );
}

// ============================================================
// PUMPSWAP SELL
// ============================================================

async function copyPumpSwapSell(
  mint: PublicKey,
  wallet: Keypair,
  tokenAmount: BN,
): Promise<string | null> {
  console.log(
    "Building PumpSwap SELL...",
  );

  const pool =
    canonicalPumpPoolPda(
      mint,
    );

  const swapSolanaState =
    await pumpAmm.swapSolanaState(
      pool,
      wallet.publicKey,
    );

  const instructions =
    await PUMP_AMM_SDK.sellBaseInput(
      swapSolanaState,
      tokenAmount,
      SELL_SLIPPAGE,
    );

  if (
    DRY_RUN
  ) {
    console.log(
      "DRY RUN: PumpSwap SELL NOT sent.",
    );

    return null;
  }

  return sendInstructions(
    wallet,
    instructions,
    "PUMPSWAP SELL",
    {
      priorityFeeMicrolamports:
        SELL_PRIORITY_FEE_MICROLAMPORTS,
      senderTipLamports:
        SELL_SENDER_TIP_LAMPORTS,
      turboDualBroadcast:
        TURBO_SELL_MULTI_REGION,
      senderUrls:
        SELL_SENDER_URLS,
    },
  );
}

// ============================================================
// PUMP BONDING CURVE BUY
// ============================================================

async function copyPumpBondingCurveBuy(
  mint: PublicKey,
  wallet: Keypair,
  solAmountBN: BN,
  prefetchedCurve?: {
    exists: boolean;
    complete: boolean;
    accountInfo: any | null;
    bondingCurve: any | null;
  },
  prefetchedTokenProgram?: PublicKey,
  prefetchedAssociatedUserAccountInfo?: any | null,
): Promise<string | null> {
  console.log(
    "Building Pump.fun BUY...",
  );

  const global =
    await getPumpGlobalCached();

  const curve =
    prefetchedCurve ||
    await getBondingCurveState(
      mint,
    );

  if (
    !curve.bondingCurve ||
    !curve.accountInfo ||
    curve.complete
  ) {
    throw new Error(
      "Bonding curve is not active.",
    );
  }

  const tokenProgram =
    prefetchedTokenProgram ||
    await getMintTokenProgram(
      mint,
    );

  const associatedTokenAddress =
    getAssociatedTokenAddressSync(
      mint,
      wallet.publicKey,
      false,
      tokenProgram,
    );

  const associatedUserAccountInfo =
    prefetchedAssociatedUserAccountInfo !== undefined
      ? prefetchedAssociatedUserAccountInfo
      : await connection.getAccountInfo(
          associatedTokenAddress,
          "processed",
        );

  const tokenAmount =
    getBuyTokenAmountFromSolAmount({
      global,

      feeConfig:
        null,

      mintSupply:
        curve.bondingCurve.tokenTotalSupply,

      bondingCurve:
        curve.bondingCurve,

      amount:
        solAmountBN,

      quoteMint:
        curve.bondingCurve.quoteMint,
    });

  const instructions =
    await PUMP_SDK.buyInstructions({
      global,

      bondingCurveAccountInfo:
        curve.accountInfo,

      bondingCurve:
        curve.bondingCurve,

      associatedUserAccountInfo,

      mint,

      user:
        wallet.publicKey,

      amount:
        tokenAmount,

      solAmount:
        solAmountBN,

      slippage:
        SLIPPAGE,

      tokenProgram,
    });

  if (
    DRY_RUN
  ) {
    console.log(
      "DRY RUN: Pump.fun BUY NOT sent.",
    );

    return null;
  }

  return sendInstructions(
    wallet,
    instructions,
    "PUMP BUY",
    {
      priorityFeeMicrolamports:
        PRIORITY_FEE_MICROLAMPORTS,
      senderTipLamports:
        BUY_SENDER_TIP_LAMPORTS,
      turboDualBroadcast:
        TURBO_BUY_MULTI_REGION,
      senderUrls:
        BUY_SENDER_URLS,
    },
  );
}

// ============================================================
// PUMP BONDING CURVE SELL
// ============================================================

async function copyPumpBondingCurveSell(
  mint: PublicKey,
  wallet: Keypair,
  tokenAmount: BN,
  prefetchedCurve?: {
    exists: boolean;
    complete: boolean;
    accountInfo: any | null;
    bondingCurve: any | null;
  },
  prefetchedTokenProgram?: PublicKey,
): Promise<string | null> {
  console.log(
    "Building Pump.fun SELL...",
  );

  const global =
    await getPumpGlobalCached();

  const curve =
    prefetchedCurve ||
    await getBondingCurveState(
      mint,
    );

  if (
    !curve.bondingCurve ||
    !curve.accountInfo ||
    curve.complete
  ) {
    throw new Error(
      "Bonding curve is not active.",
    );
  }

  const tokenProgram =
    prefetchedTokenProgram ||
    await getMintTokenProgram(
      mint,
    );

  const expectedSol =
    getSellSolAmountFromTokenAmount({
      global,

      feeConfig:
        null,

      mintSupply:
        curve.bondingCurve.tokenTotalSupply,

      bondingCurve:
        curve.bondingCurve,

      amount:
        tokenAmount,
    });

  console.log(
    `Expected SOL: ${formatSol(
      Number(
        expectedSol.toString(10),
      ),
    )}`,
  );

  const instructions =
    await PUMP_SDK.sellInstructions({
      global,

      bondingCurveAccountInfo:
        curve.accountInfo,

      bondingCurve:
        curve.bondingCurve,

      mint,

      user:
        wallet.publicKey,

      amount:
        tokenAmount,

      solAmount:
        expectedSol,

      slippage:
        SELL_SLIPPAGE,

      tokenProgram,

      mayhemMode:
        false,
    });

  if (
    DRY_RUN
  ) {
    console.log(
      "DRY RUN: Pump.fun SELL NOT sent.",
    );

    return null;
  }

  return sendInstructions(
    wallet,
    instructions,
    "PUMP SELL",
    {
      priorityFeeMicrolamports:
        SELL_PRIORITY_FEE_MICROLAMPORTS,
      senderTipLamports:
        SELL_SENDER_TIP_LAMPORTS,
      turboDualBroadcast:
        TURBO_SELL_MULTI_REGION,
      senderUrls:
        SELL_SENDER_URLS,
    },
  );
}

// ============================================================
// COPY BUY
// ============================================================

async function copyBuy(
  mintString: string,
  simulatedTargetAmount: BN,
  targetDecimals: number,
  tx: any,
  venue:
    | "Pump.fun"
    | "PumpSwap"
    | "Jupiter v6",
  tradeLeg: DetectedTradeLeg | null = null,
): Promise<{
  received: BN;
  solSpent: BN;
  pending?: boolean;
}> {
  const mint =
    new PublicKey(
      mintString,
    );

  const solAmount =
    await getCopySolAmount();

  const solAmountBN =
    new BN(
      Math.floor(
        solAmount *
          LAMPORTS_PER_SOL,
      ),
    );

  section(
    "COPY BUY",
    ANSI.green,
  );

  kv(
    "Source venue",
    venue,
  );

  kv(
    "Mint",
    mintString,
  );

  kv(
    "BUY_USD",
    `$${BUY_USD}`,
  );

  kv(
    "SOL amount",
    solAmount,
  );

  kv(
    "DRY_RUN",
    DRY_RUN,
  );

  const wallet =
    getBotWallet();

  // Axiom/Jupiter can route a Pump.fun token through the Jupiter program.
  // Copying that route through Jupiter adds quote/build HTTP latency and can
  // produce an oversized versioned transaction. If the target transaction
  // actually invokes Pump.fun/PumpSwap, execute directly against that venue.
  // This is both faster and avoids the Jupiter packet-size failure.
  let executionVenue:
    | "Pump.fun"
    | "PumpSwap"
    | "Jupiter v6" =
      venue;

  if (
    venue === "Jupiter v6"
  ) {
    if (
      transactionUsesProgram(
        tx,
        PUMP_PROGRAM_ID,
      )
    ) {
      executionVenue =
        "Pump.fun";
    } else if (
      transactionUsesProgram(
        tx,
        PUMP_AMM_PROGRAM_ID,
      )
    ) {
      executionVenue =
        "PumpSwap";
    }

    if (
      executionVenue !== venue
    ) {
      console.log(
        `FAST ROUTE: target used Jupiter, executing directly via ${executionVenue}.`,
      );
    }
  }

  let fastBalanceTokenProgram:
    PublicKey | null =
      mintProgramCache.get(
        mintString,
      ) || null;

  // On repeated Pump buys for the same mint, the first attempt has already
  // cached the static curve metadata/token program. Overlay the newest
  // TradeEvent post-trade reserves and skip the curve + mint RPC round-trips.
  const fastPumpBuyState =
    executionVenue === "Pump.fun" &&
    TURBO_BUY_USE_EVENT_RESERVES
      ? buildFastPumpCurveFromTradeEvent(
          mintString,
          tradeLeg,
        )
      : null;

  if (fastPumpBuyState) {
    console.log(
      "TURBO BUY: using target TradeEvent post-trade reserves; curve/token-program RPC fetch skipped.",
    );
  }

  // Start every independent Pump.fun RPC read immediately and let them run
  // while the wallet safety/balance reads are in flight. This removes several
  // sequential network round-trips from the pre-send path.
  const pumpCurvePromise =
    executionVenue === "Pump.fun" &&
    !fastPumpBuyState
      ? getBondingCurveState(
          mint,
        )
      : null;

  const pumpTokenProgramPromise =
    executionVenue === "Pump.fun" &&
    !fastPumpBuyState
      ? getMintTokenProgram(
          mint,
        )
      : null;

  const pumpAssociatedInfoPromise =
    pumpTokenProgramPromise
      ? pumpTokenProgramPromise.then(
          tokenProgram => {
            const ata =
              getAssociatedTokenAddressSync(
                mint,
                wallet.publicKey,
                false,
                tokenProgram,
              );

            return connection.getAccountInfo(
              ata,
              "processed",
            );
          },
        ).catch(
          () => null,
        )
      : null;

  let beforeTokenBalance =
    new BN(0);

  if (
    !DRY_RUN
  ) {
    // Run independent wallet checks in parallel to remove one RPC round-trip
    // from every live BUY.
    const tokenBalance =
      await getWalletTokenBalanceFast(
        wallet.publicKey,
        mint,
        fastBalanceTokenProgram,
        "processed",
      );

    // SOL balance is warmed continuously in the background. Do not spend an
    // extra HTTP round-trip here unless startup warming somehow failed.
    const balance =
      cachedBotSolBalanceLamports ??
      await connection.getBalance(
        wallet.publicKey,
        "processed",
      );

    const required =
      Number(
        solAmountBN.toString(10),
      ) +
      Math.floor(
        MIN_SOL_BALANCE *
          LAMPORTS_PER_SOL,
      );

    if (
      balance <
      required
    ) {
      throw new Error(
        `Insufficient SOL. Balance=${formatSol(
          balance,
        )}, required=${formatSol(
          required,
        )}`,
      );
    }

    beforeTokenBalance =
      tokenBalance;
  }

  let dryRunReceived:
    BN | null =
    null;

  let submittedSignature:
    string | null =
    null;

  // ==========================================================
  // JUPITER SOURCE TRADE -> EXECUTE THROUGH JUPITER
  // ==========================================================

  if (
    executionVenue ===
    "Jupiter v6"
  ) {
    try {
      const result =
        await copyJupiterBuy(
          mint,
          wallet,
          solAmountBN,
        );

      dryRunReceived =
        result.outAmount;

      submittedSignature =
        result.signature;
    } catch (error) {
      if (
        !DRY_RUN
      ) {
        throw error;
      }

      console.log(
        "DRY RUN: Jupiter quote unavailable; preserving the simulated BUY with target token amount fallback.",
        error,
      );

      dryRunReceived =
        simulatedTargetAmount.clone();
    }
  } else if (
    executionVenue ===
    "PumpSwap"
  ) {
    // Target used PumpSwap, so skip bonding-curve and pool-existence probes.
    // This removes two RPC reads from the successful PumpSwap hot path.
    if (
      DRY_RUN
    ) {
      dryRunReceived =
        await estimateDryRunPumpSwapBuyAmount(
          tx,
          simulatedTargetAmount,
          solAmountBN,
        );
    }

    submittedSignature =
      await copyPumpSwapBuy(
        mint,
        wallet,
        solAmountBN,
      );
  } else {
    // ========================================================
    // PUMP.FUN SOURCE TRADE -> BONDING CURVE FIRST
    // ========================================================

    const curve =
      fastPumpBuyState?.curve ||
      (pumpCurvePromise
        ? await pumpCurvePromise
        : await getBondingCurveState(
            mint,
          ));

    if (
      curve.exists &&
      !curve.complete
    ) {
      if (
        DRY_RUN &&
        curve.bondingCurve
      ) {
        try {
          const global =
            await getPumpGlobalCached();

          dryRunReceived =
            getBuyTokenAmountFromSolAmount({
              global,

              feeConfig:
                null,

              mintSupply:
                curve.bondingCurve.tokenTotalSupply,

              bondingCurve:
                curve.bondingCurve,

              amount:
                solAmountBN,

              quoteMint:
                curve.bondingCurve.quoteMint,
            });

          console.log(
            `DRY RUN quoted Pump.fun tokens: ${dryRunReceived.toString()}`,
          );
        } catch (error) {
          console.log(
            "DRY RUN Pump.fun quote failed; using transaction-based estimate.",
            error,
          );
        }
      }

      const [
        prefetchedTokenProgram,
        prefetchedAssociatedInfo,
      ] = fastPumpBuyState
        ? [
            fastPumpBuyState.tokenProgram,
            fastPumpBuyState.associatedUserAccountInfo,
          ]
        : await Promise.all([
            pumpTokenProgramPromise ||
              getMintTokenProgram(
                mint,
              ),
            pumpAssociatedInfoPromise ||
              Promise.resolve(
                undefined,
              ),
          ]);

      fastBalanceTokenProgram =
        prefetchedTokenProgram;

      cacheFastPumpSellContext(
        mintString,
        curve,
        prefetchedTokenProgram,
        prefetchedAssociatedInfo,
      );

      submittedSignature =
        await copyPumpBondingCurveBuy(
          mint,
          wallet,
          solAmountBN,
          curve,
          prefetchedTokenProgram,
          prefetchedAssociatedInfo,
        );
    } else {
      // A completed/missing Pump.fun curve normally means the token migrated.
      // Try PumpSwap directly instead of spending an extra RPC call probing the
      // pool first. If PumpSwap is unavailable, fall back to Jupiter.
      try {
        if (
          DRY_RUN
        ) {
          dryRunReceived =
            await estimateDryRunPumpSwapBuyAmount(
              tx,
              simulatedTargetAmount,
              solAmountBN,
            );
        }

        submittedSignature =
          await copyPumpSwapBuy(
            mint,
            wallet,
            solAmountBN,
          );
      } catch (pumpSwapError) {
        console.log(
          "Direct PumpSwap BUY unavailable. Falling back to Jupiter BUY.",
        );

        const result =
          await copyJupiterBuy(
            mint,
            wallet,
            solAmountBN,
          );

        dryRunReceived =
          result.outAmount;

        submittedSignature =
          result.signature;
      }
    }
  }

  if (
    DRY_RUN
  ) {
    if (
      !dryRunReceived ||
      dryRunReceived.isZero()
    ) {
      dryRunReceived =
        simulatedTargetAmount.clone();

      console.log(
        "DRY RUN WARNING: exact/estimated bot token amount unavailable; using target token amount only as a fallback.",
      );
    }

    console.log(
      `DRY RUN simulated bot tokens received: ${dryRunReceived.toString()}`,
    );

    return {
      received:
        dryRunReceived,

      solSpent:
        solAmountBN,
    };
  }

  // Pessimistically reserve the intended spend in the hot SOL cache and
  // refresh the exact wallet balance in the background.
  if (
    cachedBotSolBalanceLamports !== null
  ) {
    cachedBotSolBalanceLamports =
      Math.max(
        0,
        cachedBotSolBalanceLamports -
          Number(
            solAmountBN.toString(10),
          ),
      );
  }

  void refreshBotSolBalance();

  if (
    submittedSignature
  ) {
    pendingBuys.set(
      mintString,
      {
        signature:
          submittedSignature,
        mint:
          mintString,
        targetRaw:
          simulatedTargetAmount.toString(),
        decimals:
          targetDecimals,
        beforeTokenBalance:
          beforeTokenBalance.toString(),
        solSpentLamports:
          solAmountBN.toString(),
        tokenProgram:
          fastBalanceTokenProgram
            ? fastBalanceTokenProgram.toBase58()
            : null,
        createdAt:
          Date.now(),
      },
    );
  }

  try {
    const afterTokenBalance =
      await waitForTokenBalance(
        wallet.publicKey,
        mint,
        beforeTokenBalance,
        submittedSignature,
        fastBalanceTokenProgram,
      );

    const received =
      afterTokenBalance.sub(
        beforeTokenBalance,
      );

    if (
      received.isZero() ||
      received.isNeg()
    ) {
      throw new Error(
        "BUY sent but bot token balance did not increase.",
      );
    }

    pendingBuys.delete(
      mintString,
    );

    console.log(
      `Actual bot tokens received: ${received.toString()}`,
    );

    return {
      received,
      solSpent:
        solAmountBN,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    if (
      submittedSignature &&
      (message.includes("did not reach processed") ||
        message.includes("processed confirmation timed out"))
    ) {
      status(
        "BUY was broadcast but is still pending. Position will be reconciled in background; a target SELL will wait for this BUY instead of being skipped.",
        "warning",
      );

      void settlePendingBuy(
        mintString,
      );

      return {
        received:
          new BN(0),
        solSpent:
          solAmountBN,
        pending:
          true,
      };
    }

    pendingBuys.delete(
      mintString,
    );

    throw error;
  }
}

async function settlePendingBuy(
  mintString: string,
): Promise<boolean> {
  const existingPromise =
    pendingBuySettlementPromises.get(
      mintString,
    );

  if (
    existingPromise
  ) {
    return existingPromise;
  }

  const pending =
    pendingBuys.get(
      mintString,
    );

  if (
    !pending
  ) {
    return Boolean(
      getPosition(
        mintString,
      ),
    );
  }

  const promise =
    (async (): Promise<boolean> => {
      try {
        const mint =
          new PublicKey(
            mintString,
          );

        const tokenProgram =
          pending.tokenProgram
            ? new PublicKey(
                pending.tokenProgram,
              )
            : null;

        try {
          await waitForSignatureConfirmed(
            pending.signature,
            "PENDING BUY",
          );
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : String(error);

          if (
            message.includes(
              "failed on-chain",
            )
          ) {
            pendingBuys.delete(
              mintString,
            );
            throw error;
          }
        }

        const before =
          new BN(
            pending.beforeTokenBalance,
          );

        const current =
          await getWalletTokenBalanceFast(
            getBotWallet().publicKey,
            mint,
            tokenProgram,
            "confirmed",
          );

        if (
          current.lte(
            before,
          )
        ) {
          return false;
        }

        const received =
          current.sub(
            before,
          );

        if (
          !getPosition(
            mintString,
          )
        ) {
          addBuyToPosition(
            mintString,
            new BN(
              pending.targetRaw,
            ),
            received,
            pending.decimals,
            new BN(
              pending.solSpentLamports,
            ),
          );

          status(
            `Late BUY settled and position recovered: ${received.toString()} raw tokens.`,
            "success",
          );

          void startTrailingStopForMint(
            mintString,
          );

          scheduleSafeCopyMaxHold(
            mintString,
          );
        }

        pendingBuys.delete(
          mintString,
        );

        return true;
      } catch (error) {
        console.error(
          `Pending BUY settlement failed for ${mintString}:`,
          error,
        );

        return false;
      } finally {
        pendingBuySettlementPromises.delete(
          mintString,
        );
      }
    })();

  pendingBuySettlementPromises.set(
    mintString,
    promise,
  );

  return promise;
}

// ============================================================
// COPY SELL
// ============================================================

async function copySell(
  mintString: string,
  targetSellAmount: BN,
  venue:
    | "Pump.fun"
    | "PumpSwap"
    | "Jupiter v6",
  tx: any,
  tradeLeg: DetectedTradeLeg | null = null,
): Promise<BN> {
  const mint =
    new PublicKey(
      mintString,
    );

  const wallet =
    getBotWallet();

  let executionVenue:
    | "Pump.fun"
    | "PumpSwap"
    | "Jupiter v6" =
      venue;

  if (
    venue === "Jupiter v6"
  ) {
    if (
      transactionUsesProgram(
        tx,
        PUMP_PROGRAM_ID,
      )
    ) {
      executionVenue =
        "Pump.fun";
    } else if (
      transactionUsesProgram(
        tx,
        PUMP_AMM_PROGRAM_ID,
      )
    ) {
      executionVenue =
        "PumpSwap";
    }

    if (
      executionVenue !== venue
    ) {
      console.log(
        `FAST ROUTE: target used Jupiter, executing SELL directly via ${executionVenue}.`,
      );
    }
  }

  let position =
    getPosition(
      mintString,
    );

  let waitedForPendingBuy =
    false;

  if (
    !position &&
    pendingBuys.has(
      mintString,
    )
  ) {
    status(
      "Target SELL arrived while our BUY is still pending; waiting for the BUY to settle before deciding the SELL.",
      "warning",
    );

    waitedForPendingBuy =
      true;

    await settlePendingBuy(
      mintString,
    );

    position =
      getPosition(
        mintString,
      );
  }

  // ==========================================================
  // STRICT TRACKED-POSITION SELL ONLY
  // ==========================================================
  // The bot NEVER sells a token merely because that token exists
  // in the real wallet. A SELL is copied only when this bot has a
  // saved position created by one of its own copied BUY operations.
  //
  // This protects manually-held tokens and tokens bought while the
  // copy bot was offline.
  // ==========================================================

  if (!position) {
    status(
      "SELL skipped - no tracked BUY position exists for this token.",
      "warning",
    );

    console.log(
      `Untracked mint: ${mintString}`,
    );

    return new BN(0);
  }

  const targetPosition =
    new BN(
      position.targetRaw,
    );

  const botPosition =
    new BN(
      position.botRaw,
    );

  if (
    targetPosition.isZero() ||
    botPosition.isZero()
  ) {
    status(
      "SELL skipped - tracked position is empty.",
      "warning",
    );

    return new BN(0);
  }

  let botSellAmount:
    BN;

  // In SIGNAL_SNIPER mode the watched wallet's first SELL is itself an exit
  // signal. Default to closing our whole position instead of waiting through a
  // sequence of partial target sells. This can be disabled in the env.
  if (
    SAFE_COPY_MODE &&
    SIGNAL_FULL_EXIT_ON_TARGET_SELL
  ) {
    botSellAmount =
      botPosition.clone();
  } else if (
    targetSellAmount.gte(
      targetPosition,
    )
  ) {
    botSellAmount =
      botPosition.clone();
  } else {
    botSellAmount =
      botPosition
        .mul(
          targetSellAmount,
        )
        .div(
          targetPosition,
        );
  }

  console.log(
    "SELL sizing: STRICT tracked position.",
  );

  console.log(
    `Tracked target position: ${targetPosition.toString()}`,
  );

  console.log(
    `Tracked bot position: ${botPosition.toString()}`,
  );

  console.log(
    `Target SELL amount: ${targetSellAmount.toString()}`,
  );

  console.log(
    SAFE_COPY_MODE && SIGNAL_FULL_EXIT_ON_TARGET_SELL
      ? `Signal-wallet SELL -> FULL bot exit: ${botSellAmount.toString()}`
      : `Calculated proportional bot SELL: ${botSellAmount.toString()}`,
  );

  if (
    botSellAmount.isZero()
  ) {
    console.log(
      "Calculated bot SELL amount is zero. SELL skipped.",
    );

    return new BN(0);
  }

  // TURBO Pump SELL path. If the direct target TradeEvent carries post-trade
  // reserves and we cached static curve metadata during BUY, build the SELL
  // from that event immediately and avoid a getAccountInfo round-trip.
  const fastPumpState =
    executionVenue === "Pump.fun" &&
    !waitedForPendingBuy
      ? buildFastPumpCurveFromTradeEvent(
          mintString,
          tradeLeg,
        )
      : null;

  if (fastPumpState) {
    console.log(
      "TURBO SELL: using target TradeEvent post-trade reserves; curve RPC fetch skipped.",
    );
  }

  const pumpCurvePromise =
    executionVenue === "Pump.fun" &&
    !fastPumpState
      ? getBondingCurveState(
          mint,
        )
      : null;

  const pumpTokenProgramPromise =
    executionVenue === "Pump.fun" &&
    !fastPumpState
      ? getMintTokenProgram(
          mint,
        )
      : null;

  let walletBalanceBefore:
    BN | null =
      null;

  let fastBalanceTokenProgram:
    PublicKey | null =
      fastPumpState?.tokenProgram ||
      mintProgramCache.get(
        mintString,
      ) ||
      null;

  // The tracked bot amount is already bounded by this bot's own BUY state.
  // In turbo mode we do NOT spend an RPC round-trip re-reading the wallet
  // before broadcast. A successful processed signature proves that the exact
  // token amount in the SELL instruction executed. Startup reconciliation still
  // protects against stale state after restarts/manual wallet changes.
  if (
    !DRY_RUN &&
    !TURBO_SELL_SKIP_PRE_BALANCE
  ) {
    walletBalanceBefore =
      await getWalletTokenBalanceFast(
        wallet.publicKey,
        mint,
        fastBalanceTokenProgram,
        "processed",
      );

    if (
      walletBalanceBefore.isZero()
    ) {
      status(
        "SELL skipped - tracked position exists, but bot wallet has zero token balance.",
        "warning",
      );

      return new BN(0);
    }

    botSellAmount =
      BN.min(
        botSellAmount,
        walletBalanceBefore,
      );
  } else if (
    !DRY_RUN &&
    TURBO_SELL_SKIP_PRE_BALANCE
  ) {
    console.log(
      "TURBO SELL: pre-sell wallet balance RPC skipped; using STRICT tracked bot position.",
    );
  }

  if (
    botSellAmount.isZero()
  ) {
    console.log(
      "Final bot SELL amount is zero. SELL skipped.",
    );

    return new BN(0);
  }

  section(
    "COPY SELL",
    ANSI.red,
  );

  kv(
    "Source venue",
    venue,
  );

  kv(
    "Mint",
    mintString,
  );

  kv(
    "Target sold",
    targetSellAmount.toString(),
  );

  kv(
    "Bot sells",
    botSellAmount.toString(),
  );

  let submittedSignature:
    string | null =
    null;

  if (
    executionVenue ===
    "Jupiter v6"
  ) {
    try {
      const result =
        await copyJupiterSell(
          mint,
          wallet,
          botSellAmount,
        );

      submittedSignature =
        result.signature;
    } catch (error) {
      if (
        !DRY_RUN
      ) {
        throw error;
      }

      console.log(
        "DRY RUN: Jupiter SELL quote unavailable; simulated proportional SELL will still update dry-run state.",
        error,
      );
    }
  } else if (
    executionVenue ===
    "PumpSwap"
  ) {
    // Target used PumpSwap: execute directly without probing Pump.fun first.
    submittedSignature =
      await copyPumpSwapSell(
        mint,
        wallet,
        botSellAmount,
      );
  } else {
    const curve =
      fastPumpState?.curve ||
      (pumpCurvePromise
        ? await pumpCurvePromise
        : await getBondingCurveState(
            mint,
          ));

    if (
      curve.exists &&
      !curve.complete
    ) {
      const prefetchedTokenProgram =
        fastPumpState?.tokenProgram ||
        (pumpTokenProgramPromise
          ? await pumpTokenProgramPromise
          : await getMintTokenProgram(
              mint,
            ));

      fastBalanceTokenProgram =
        prefetchedTokenProgram;

      cacheFastPumpSellContext(
        mintString,
        curve,
        prefetchedTokenProgram,
      );

      submittedSignature =
        await copyPumpBondingCurveSell(
          mint,
          wallet,
          botSellAmount,
          curve,
          prefetchedTokenProgram,
        );
    } else {
      // Skip the pool-existence probe. A migrated Pump token should be tried on
      // PumpSwap immediately; Jupiter remains the fallback if that fails.
      try {
        submittedSignature =
          await copyPumpSwapSell(
            mint,
            wallet,
            botSellAmount,
          );
      } catch (pumpSwapError) {
        console.log(
          "Direct PumpSwap SELL unavailable. Falling back to Jupiter SELL.",
        );

        try {
          const result =
            await copyJupiterSell(
              mint,
              wallet,
              botSellAmount,
            );

          submittedSignature =
            result.signature;
        } catch (error) {
          if (
            !DRY_RUN
          ) {
            throw error;
          }

          console.log(
            "DRY RUN: Jupiter fallback SELL quote unavailable; simulated proportional SELL will still update dry-run state.",
            error,
          );
        }
      }
    }
  }

  if (
    DRY_RUN
  ) {
    return botSellAmount;
  }

  if (
    TURBO_SELL_SKIP_PRE_BALANCE
  ) {
    console.log(
      "TURBO SELL broadcast. Waiting only for processed signature result...",
    );

    await waitForSignatureProcessed(
      submittedSignature,
      "SELL",
    );

    console.log(
      `TURBO SELL processed: ${botSellAmount.toString()} raw tokens executed.`,
    );

    // Re-read wallet state asynchronously for diagnostics/reconciliation. This
    // never delays the target trade queue or the actual SELL broadcast.
    void getWalletTokenBalanceFast(
      wallet.publicKey,
      mint,
      fastBalanceTokenProgram,
      "processed",
    ).catch(
      () => undefined,
    );

    return botSellAmount;
  }

  if (
    !walletBalanceBefore
  ) {
    throw new Error(
      "SELL sent without a recorded pre-sell wallet balance.",
    );
  }

  console.log(
    "SELL sent. Waiting for FAST processed token balance update...",
  );

  const walletBalanceAfter =
    await waitForTokenBalanceDecrease(
      wallet.publicKey,
      mint,
      walletBalanceBefore,
      submittedSignature,
      fastBalanceTokenProgram,
    );

  if (
    !walletBalanceAfter.lt(
      walletBalanceBefore,
    )
  ) {
    throw new Error(
      "SELL was submitted but bot token balance did not decrease; state was NOT changed.",
    );
  }

  const actualSold =
    walletBalanceBefore.sub(
      walletBalanceAfter,
    );

  console.log(
    `Actual bot tokens sold: ${actualSold.toString()}`,
  );

  return actualSold;
}

// ============================================================
// EXECUTE ANALYZED TRADE
// ============================================================

async function executeAnalyzedTrade(
  analyzed: AnalyzedTradeJob,
): Promise<void> {
  const {
    sequence,
    signature,
    tx,
    trade,
  } = analyzed;

  currentTradeObservedAtMs =
    analyzed.observedAtMs;

  console.log(
    `LATENCY target seen -> execution start: ${Date.now() - analyzed.observedAtMs} ms`,
  );

  if (
    !trade
  ) {
    return;
  }

  // Direct log-decoded Pump trades intentionally have no parsed transaction.
  // The execution path can resolve the mint program/curve itself.
  if (tx) {
    if (
      trade.direction === "SWAP"
    ) {
      seedMintProgramCacheFromTransaction(
        tx,
        trade.sell.mint,
      );

      seedMintProgramCacheFromTransaction(
        tx,
        trade.buy.mint,
      );
    } else {
      seedMintProgramCacheFromTransaction(
        tx,
        trade.mint,
      );
    }
  }

  // ==========================================================
  // JUPITER TOKEN -> TOKEN SWAP
  // ==========================================================
  // A token->token route has TWO meaningful non-quote deltas:
  // one negative (the token the target sold) and one positive
  // (the token the target received). We execute SELL first so
  // tracked exposure is reduced before opening the new BUY.
  //
  // IMPORTANT: copySell() still enforces STRICT tracked-position
  // protection. If the old token was never bought by this bot,
  // that SELL is skipped, but the incoming token BUY is still
  // copied because it is a genuine new acquisition by the target.
  if (
    trade.direction ===
    "SWAP"
  ) {
    section(
      `Executing trade #${sequence} - JUPITER TOKEN SWAP`,
      ANSI.magenta,
    );

    kv(
      "Signature",
      signature,
    );

    kv(
      "Venue",
      trade.venue,
    );

    kv(
      "SELL mint",
      trade.sell.mint,
    );

    kv(
      "Target sold",
      trade.sell.uiAmount,
    );

    kv(
      "BUY mint",
      trade.buy.mint,
    );

    kv(
      "Target received",
      trade.buy.uiAmount,
    );

    // --------------------------------------------------------
    // LEG 1: proportional SELL of the outgoing token
    // --------------------------------------------------------
    const hadTrackedSellPosition =
      getPosition(
        trade.sell.mint,
      ) !== null;

    try {
      const botSold =
        await copySell(
          trade.sell.mint,
          trade.sell.rawAmount,
          trade.sell.venue,
          tx,
          trade.sell,
        );

      if (
        !botSold.isZero()
      ) {
        const position =
          getPosition(
            trade.sell.mint,
          );

        if (
          !position
        ) {
          console.error(
            "Jupiter SWAP SELL state inconsistency: tracked position disappeared before state update.",
          );
        } else {
          const closed =
            updateSellPosition(
              trade.sell.mint,
              trade.sell.rawAmount,
              botSold,
            );

          if (
            closed
          ) {
            console.log(
              "Jupiter SWAP SELL leg: position fully closed.",
            );
          } else {
            console.log(
              "Jupiter SWAP SELL leg: position updated.",
            );

            printPosition(
              trade.sell.mint,
            );
          }
        }
      } else if (
        hadTrackedSellPosition
      ) {
        status(
          "Jupiter SWAP BUY leg blocked because a tracked SELL could not be executed.",
          "error",
        );

        return;
      } else {
        status(
          "Jupiter SWAP SELL leg skipped because no tracked source position exists; copying incoming-token BUY only.",
          "warning",
        );
      }
    } catch (error) {
      console.error(
        "JUPITER SWAP SELL LEG FAILED:",
        error,
      );

      // Do not open a new position after an attempted tracked SELL
      // failed in live mode. This avoids accidentally increasing
      // exposure when the intended rotation could not be completed.
      if (
        hadTrackedSellPosition
      ) {
        status(
          "Jupiter SWAP BUY leg blocked because the tracked SELL leg failed.",
          "error",
        );

        return;
      }
    }

    // --------------------------------------------------------
    // LEG 2: fixed-size BUY of the incoming token
    // --------------------------------------------------------
    try {
      const result =
        await copyBuy(
          trade.buy.mint,
          trade.buy.rawAmount,
          trade.buy.decimals,
          tx,
          trade.buy.venue,
          trade.buy,
        );

      if (
        !result.pending
      ) {
        addBuyToPosition(
          trade.buy.mint,
          trade.buy.rawAmount,
          result.received,
          trade.buy.decimals,
          result.solSpent,
        );

        console.log(
          "Jupiter SWAP BUY leg: position saved.",
        );
      } else {
        console.log(
          "Jupiter SWAP BUY leg: broadcast; settlement pending.",
        );
      }

      printPosition(
        trade.buy.mint,
      );
    } catch (error) {
      console.error(
        "JUPITER SWAP BUY LEG FAILED:",
        error,
      );
    }

    return;
  }

  // ==========================================================
  // NORMAL SINGLE-LEG BUY / SELL
  // ==========================================================

  section(
    `Executing trade #${sequence} - ${trade.direction}`,
    trade.direction === "BUY"
      ? ANSI.green
      : ANSI.red,
  );

  kv(
    "Signature",
    signature,
  );

  kv(
    "Trade",
    trade.direction,
  );

  kv(
    "Venue",
    trade.venue,
  );

  kv(
    "Mint",
    trade.mint,
  );

  kv(
    "Target amount",
    trade.uiAmount,
  );

  if (
    trade.direction ===
    "BUY"
  ) {
    if (SAFE_COPY_MODE) {
      const guard =
        safeCopyEntryAllowed(
          trade,
          tx,
        );

      if (!guard.allowed) {
        status(
          `SAFE COPY BUY skipped: ${guard.reason}.`,
          "warning",
        );
        return;
      }

      status(
        `SAFE COPY entry approved: ${guard.reason}.`,
        "success",
      );
    }

    try {
      const result =
        await copyBuy(
          trade.mint,
          trade.rawAmount,
          trade.decimals,
          tx,
          trade.venue,
          trade,
        );

      if (
        !result.pending
      ) {
        addBuyToPosition(
          trade.mint,
          trade.rawAmount,
          result.received,
          trade.decimals,
          result.solSpent,
        );

        console.log(
          "BUY position saved.",
        );

        printPosition(
          trade.mint,
        );

        void startTrailingStopForMint(
          trade.mint,
        );

        scheduleSafeCopyMaxHold(
          trade.mint,
        );
      } else {
        console.log(
          "BUY broadcast; settlement is pending and will not block the target trade queue.",
        );
      }
    } catch (error) {
      console.error(
        "COPY BUY FAILED:",
        error,
      );
    }

    return;
  }

  // ==========================================================
  // SELL
  // ==========================================================

  // A target SELL ends the current entry-signal sequence even when we never
  // opened a position. A later re-entry in the same mint starts fresh.
  targetSignalStates.delete(
    trade.mint,
  );

  if (
    sellExecutionLocks.has(
      trade.mint,
    )
  ) {
    status(
      "Target SELL skipped because an autonomous/other SELL is already in flight for this mint.",
      "warning",
    );
    return;
  }

  sellExecutionLocks.add(
    trade.mint,
  );

  try {
    const botSold =
      await copySell(
        trade.mint,
        trade.rawAmount,
        trade.venue,
        tx,
        trade,
      );

    if (
      botSold.isZero()
    ) {
      return;
    }

    const position =
      getPosition(
        trade.mint,
      );

    if (
      !position
    ) {
      console.error(
        "SELL state inconsistency: tracked position disappeared before state update.",
      );

      return;
    }

    const stateTargetSold =
      SAFE_COPY_MODE && SIGNAL_FULL_EXIT_ON_TARGET_SELL
        ? new BN(
            position.targetRaw,
          )
        : trade.rawAmount;

    const closed =
      updateSellPosition(
        trade.mint,
        stateTargetSold,
        botSold,
      );

    if (
      closed
    ) {
      console.log(
        "Position fully closed.",
      );

      void stopTrailingStopForMint(
        trade.mint,
      );
    } else {
      console.log(
        "SELL position updated.",
      );

      printPosition(
        trade.mint,
      );
    }
  } catch (error) {
    console.error(
      "COPY SELL FAILED:",
      error,
    );
  } finally {
    sellExecutionLocks.delete(
      trade.mint,
    );
  }
}

// ============================================================
// WEBSOCKET
// ============================================================

function getEnhancedWebSocketEndpoint(): string | null {
  if (
    RPC_WS
  ) {
    return RPC_WS;
  }

  try {
    const endpoint =
      new URL(
        RPC_URL,
      );

    endpoint.protocol =
      endpoint.protocol === "https:"
        ? "wss:"
        : "ws:";

    return endpoint.toString();
  } catch {
    return null;
  }
}

function stopEnhancedHeartbeat(): void {
  if (
    enhancedHeartbeat
  ) {
    clearInterval(
      enhancedHeartbeat,
    );

    enhancedHeartbeat =
      null;
  }
}

async function closeStandardSubscription(): Promise<void> {
  if (
    websocketSubscriptionId ===
    null
  ) {
    return;
  }

  try {
    await connection.removeOnLogsListener(
      websocketSubscriptionId,
    );
  } catch {
    // ignore
  }

  websocketSubscriptionId =
    null;
}

function closeEnhancedSubscription(): void {
  stopEnhancedHeartbeat();

  if (
    enhancedWebSocket
  ) {
    enhancedClosingIntentionally =
      true;

    try {
      enhancedWebSocket.close();
    } catch {
      // ignore
    }
  }

  enhancedWebSocket =
    null;

  enhancedSubscriptionId =
    null;

  enhancedStreamActive =
    false;
}

function handleFastTargetTransaction(
  signature: string,
  slot: number,
  tx: any,
  source: "Enhanced transactionSubscribe" | "Standard onLogs",
  fastTrade: DetectedTrade | null = null,
): void {
  if (
    !signature ||
    !rememberSignature(
      signature,
    )
  ) {
    return;
  }

  // Queue FIRST. Terminal output is intentionally after enqueue so console I/O
  // cannot sit in front of the latency-sensitive analysis path.
  enqueueTrade(
    signature,
    tx,
    fastTrade,
  );

  section(
    "TARGET TRANSACTION DETECTED",
    ANSI.yellow,
  );

  kv(
    "Signature",
    signature,
  );

  kv(
    "Slot",
    slot,
  );

  kv(
    "Stream",
    source,
  );

  if (fastTrade) {
    status(
      "Pump TradeEvent decoded directly from WebSocket logs - RPC fetch skipped.",
      "success",
    );
  } else if (
    tx
  ) {
    status(
      "Full parsed transaction received directly - RPC fetch skipped.",
      "success",
    );
  } else {
    status(
      "Fetching transaction for exact trade verification...",
      "info",
    );
  }
}

async function subscribeToTargetEnhanced(): Promise<boolean> {
  if (
    !USE_ENHANCED_TRANSACTION_STREAM
  ) {
    return false;
  }

  const endpoint =
    getEnhancedWebSocketEndpoint();

  const WebSocketImpl =
    (globalThis as any).WebSocket;

  if (
    !endpoint ||
    !WebSocketImpl
  ) {
    return false;
  }

  closeEnhancedSubscription();

  return new Promise<boolean>(
    resolve => {
      let settled =
        false;

      const requestId =
        Date.now();

      const ws =
        new WebSocketImpl(
          endpoint,
        );

      enhancedWebSocket =
        ws;

      const finish = (
        success: boolean,
      ): void => {
        if (
          settled
        ) {
          return;
        }

        settled =
          true;

        clearTimeout(
          timeout,
        );

        resolve(
          success,
        );
      };

      const timeout =
        setTimeout(
          () => {
            if (
              !settled
            ) {
              status(
                "Enhanced transaction stream timed out; using standard onLogs fallback.",
                "warning",
              );

              enhancedClosingIntentionally =
                true;

              try {
                ws.close();
              } catch {
                // ignore
              }

              finish(
                false,
              );
            }
          },
          ENHANCED_SUBSCRIBE_TIMEOUT_MS,
        );

      ws.addEventListener(
        "open",
        () => {
          try {
            ws.send(
              JSON.stringify({
                jsonrpc:
                  "2.0",
                id:
                  requestId,
                method:
                  "transactionSubscribe",
                params: [
                  {
                    vote:
                      false,
                    failed:
                      false,
                    accountInclude: [
                      TARGET_WALLET,
                    ],
                  },
                  {
                    commitment:
                      "processed",
                    encoding:
                      "jsonParsed",
                    transactionDetails:
                      "full",
                    showRewards:
                      false,
                    maxSupportedTransactionVersion:
                      0,
                  },
                ],
              }),
            );
          } catch {
            finish(
              false,
            );
          }
        },
      );

      ws.addEventListener(
        "message",
        (event: any) => {
          let payload:
            any;

          try {
            const raw =
              typeof event.data === "string"
                ? event.data
                : Buffer.from(
                    event.data,
                  ).toString(
                    "utf8",
                  );

            payload =
              JSON.parse(
                raw,
              );
          } catch {
            return;
          }

          if (
            payload.id === requestId
          ) {
            if (
              payload.error
            ) {
              status(
                `Enhanced transactionSubscribe unavailable: ${String(
                  payload.error?.message ||
                  payload.error,
                )}. Falling back to standard onLogs.`,
                "warning",
              );

              enhancedClosingIntentionally =
                true;

              try {
                ws.close();
              } catch {
                // ignore
              }

              finish(
                false,
              );

              return;
            }

            if (
              payload.result !== undefined
            ) {
              enhancedSubscriptionId =
                Number(
                  payload.result,
                );

              enhancedStreamActive =
                true;

              enhancedClosingIntentionally =
                false;

              stopEnhancedHeartbeat();

              enhancedHeartbeat =
                setInterval(
                  () => {
                    try {
                      if (
                        enhancedWebSocket === ws &&
                        ws.readyState === 1
                      ) {
                        ws.send(
                          JSON.stringify({
                            jsonrpc:
                              "2.0",
                            id:
                              Date.now(),
                            method:
                              "ping",
                          }),
                        );
                      }
                    } catch {
                      // close handler will reconnect if the socket is gone
                    }
                  },
                  ENHANCED_HEARTBEAT_MS,
                );

              finish(
                true,
              );
            }

            return;
          }

          if (
            payload.method !==
              "transactionNotification"
          ) {
            return;
          }

          const result =
            payload.params?.result;

          const tx =
            result?.transaction;

          const signature =
            String(
              result?.signature ||
              "",
            );

          if (
            !tx ||
            !signature ||
            tx.meta?.err
          ) {
            return;
          }

          const logs =
            tx.meta?.logMessages || [];

          if (
            logs.some(
              (log: unknown) =>
                typeof log === "string" &&
                (log.includes(
                  PUMP_PROGRAM_ID,
                ) ||
                log.includes(
                  PUMP_AMM_PROGRAM_ID,
                )),
            )
          ) {
            void getPumpGlobalCached()
              .catch(
                () => undefined,
              );
          }

          handleFastTargetTransaction(
            signature,
            Number(
              result?.slot ||
              0,
            ),
            tx,
            "Enhanced transactionSubscribe",
          );
        },
      );

      ws.addEventListener(
        "error",
        () => {
          if (
            !settled
          ) {
            finish(
              false,
            );
          }
        },
      );

      ws.addEventListener(
        "close",
        () => {
          const intentional =
            enhancedClosingIntentionally;

          enhancedClosingIntentionally =
            false;

          stopEnhancedHeartbeat();

          if (
            enhancedWebSocket === ws
          ) {
            enhancedWebSocket =
              null;

            enhancedSubscriptionId =
              null;

            enhancedStreamActive =
              false;
          }

          if (
            !settled
          ) {
            finish(
              false,
            );
          }

          if (
            !intentional &&
            settled
          ) {
            status(
              "Enhanced transaction stream disconnected; reconnecting.",
              "warning",
            );

            void reconnectWebSocket();
          }
        },
      );
    },
  );
}

// ============================================================
// DIRECT PUMP TRADE EVENT FAST PATH
// ============================================================
// Pump TradeEvent is emitted in `Program data:` logs. The first fields are
// stable and sufficient for copy trading:
//   discriminator[8], mint[32], quote/sol amount u64, token amount u64,
//   is_buy bool, user[32].
//
// We only accept an event whose embedded `user` exactly equals TARGET_WALLET.
// If anything is missing/ambiguous we return null and use the existing parsed-
// transaction verification path. This makes the optimization fail-safe.
const PUMP_TRADE_EVENT_DISCRIMINATOR_HEX =
  "bddb7fd34ee661ee"; // sha256("event:TradeEvent")[0..8]

function decodePumpTradeEventFromLogs(
  logs: string[],
): DetectedTradeLeg | null {
  const matches: DetectedTradeLeg[] = [];

  for (const rawLog of logs) {
    if (typeof rawLog !== "string") {
      continue;
    }

    const match =
      rawLog.match(/^Program data:\s*([A-Za-z0-9+/=]+)\s*$/);

    if (!match) {
      continue;
    }

    try {
      const data =
        Buffer.from(match[1], "base64");

      // 8 discriminator + 32 mint + 8 amount + 8 amount + 1 bool + 32 user
      if (data.length < 89) {
        continue;
      }

      if (
        data.subarray(0, 8).toString("hex") !==
        PUMP_TRADE_EVENT_DISCRIMINATOR_HEX
      ) {
        continue;
      }

      const mint =
        new PublicKey(
          data.subarray(8, 40),
        ).toBase58();

      const solAmount =
        new BN(
          data.subarray(40, 48),
          "le",
        );

      const tokenAmount =
        new BN(
          data.subarray(48, 56),
          "le",
        );

      const isBuy =
        data[56] !== 0;

      const user =
        new PublicKey(
          data.subarray(57, 89),
        ).toBase58();

      if (
        user !== TARGET_WALLET ||
        tokenAmount.isZero()
      ) {
        continue;
      }

      // Pump bonding-curve coins use 6 token decimals. If this ever changes,
      // the fallback parsed-transaction path remains available for events that
      // cannot be decoded safely.
      const decimals = 6;

      // Legacy and current TradeEvent layouts share these reserve fields in
      // the same positions immediately after timestamp. They represent the
      // curve AFTER the target's trade, which is exactly what a reactive SELL
      // wants to price against.
      const hasReserveFields =
        data.length >= 129;

      const virtualSolReserves =
        hasReserveFields
          ? new BN(
              data.subarray(97, 105),
              "le",
            )
          : undefined;

      const virtualTokenReserves =
        hasReserveFields
          ? new BN(
              data.subarray(105, 113),
              "le",
            )
          : undefined;

      const realSolReserves =
        hasReserveFields
          ? new BN(
              data.subarray(113, 121),
              "le",
            )
          : undefined;

      const realTokenReserves =
        hasReserveFields
          ? new BN(
              data.subarray(121, 129),
              "le",
            )
          : undefined;

      matches.push({
        mint,
        rawAmount:
          tokenAmount,
        decimals,
        uiAmount:
          formatTokenAmount(
            tokenAmount,
            decimals,
          ),
        direction:
          isBuy
            ? "BUY"
            : "SELL",
        venue:
          "Pump.fun",
        pumpSolAmount:
          solAmount,
        pumpVirtualSolReserves:
          virtualSolReserves,
        pumpVirtualTokenReserves:
          virtualTokenReserves,
        pumpRealSolReserves:
          realSolReserves,
        pumpRealTokenReserves:
          realTokenReserves,
      });
    } catch {
      // Ignore malformed/non-Pump Program data and keep scanning.
    }
  }

  // More than one matching target TradeEvent is unusual. Do not guess.
  if (matches.length !== 1) {
    return null;
  }

  return matches[0];
}

async function subscribeToTargetStandard(): Promise<void> {
  await closeStandardSubscription();

  websocketSubscriptionId =
    connection.onLogs(
      target,
      (
        logInfo: Logs,
        context,
      ) => {
        const signature =
          logInfo.signature;

        if (
          !signature ||
          logInfo.err
        ) {
          return;
        }

        if (
          (logInfo.logs || []).some(
            log =>
              typeof log === "string" &&
              (log.includes(
                PUMP_PROGRAM_ID,
              ) ||
                log.includes(
                  PUMP_AMM_PROGRAM_ID,
                )),
          )
        ) {
          void getPumpGlobalCached()
            .catch(
              () => undefined,
            );
        }

        const fastTrade =
          decodePumpTradeEventFromLogs(
            logInfo.logs || [],
          );

        // In FAST_PUMP_ONLY mode, do not enqueue transactions that would require
        // the ~1s parsed-transaction RPC fallback. Direct Pump TradeEvents are
        // already fully identified from the WebSocket logs and stay on the ms path.
        if (
          FAST_PUMP_ONLY &&
          !fastTrade
        ) {
          rememberSignature(
            signature,
          );
          return;
        }

        handleFastTargetTransaction(
          signature,
          context.slot,
          null,
          "Standard onLogs",
          fastTrade,
        );
      },
      WS_COMMITMENT,
    );

  status(
    `Standard WebSocket fallback active. Subscription ID: ${websocketSubscriptionId}`,
    "success",
  );
}

async function subscribeToTarget(): Promise<void> {
  section(
    "WEBSOCKET MONITOR",
    ANSI.cyan,
  );

  status(
    "Connecting ultra-fast target stream...",
    "info",
  );

  await closeStandardSubscription();

  const enhanced =
    await subscribeToTargetEnhanced();

  if (
    enhanced
  ) {
    status(
      `Enhanced transactionSubscribe active. Subscription ID: ${enhancedSubscriptionId}`,
      "success",
    );

    kv(
      "Target stream",
      "FULL TX @ processed (no RPC fetch)",
    );
  } else {
    await subscribeToTargetStandard();

    kv(
      "Target stream",
      "onLogs + fast RPC fetch fallback",
    );
  }

  kv(
    "Watching target",
    TARGET_WALLET,
  );
}

// ============================================================
// RECONNECT
// ============================================================

async function reconnectWebSocket(): Promise<void> {
  if (
    reconnecting
  ) {
    return;
  }

  reconnecting =
    true;

  try {
    status(
      "Reconnecting WebSocket...",
      "warning",
    );

    await sleep(
      100,
    );

    await subscribeToTarget();

    status(
      "WebSocket reconnected.",
      "success",
    );
  } catch (error) {
    console.error(
      paint(
        "[X] WebSocket reconnect failed:",
        ANSI.bold,
        ANSI.red,
      ),
      error,
    );
  } finally {
    reconnecting =
      false;
  }
}

// ============================================================
// RPC CHECK
// ============================================================

async function checkRpc(): Promise<void> {
  section(
    "RPC CHECK",
    ANSI.cyan,
  );

  status(
    "Checking Solana RPC...",
    "info",
  );

  const slot =
    await connection.getSlot(
      "processed",
    );

  status(
    `RPC OK. Current slot: ${slot}`,
    "success",
  );

  kv(
    "WebSocket",
    RPC_WS
      ? "configured"
      : "default",
  );
}

// ============================================================
// MONITOR
// ============================================================

async function monitor(): Promise<void> {
  status(
    "SOLANA COPY BOT monitor started.",
    "success",
  );

  section(
    "LIVE MONITOR CONFIG",
    ANSI.cyan,
  );

  kv("Target", TARGET_WALLET);
  kv("BUY_USD", `$${BUY_USD}`);
  kv("SLIPPAGE", `${SLIPPAGE}%`);
  kv("SELL_SLIPPAGE", `${SELL_SLIPPAGE}%`);
  kv("MAX_SOL_PER_TRADE", MAX_SOL_PER_TRADE);
  kv("DRY_RUN", DRY_RUN);
  kv("Priority fee", PRIORITY_FEE_MICROLAMPORTS);
  kv("BUY turbo multi-region", TURBO_BUY_MULTI_REGION);
  kv("BUY event-reserve fast path", TURBO_BUY_USE_EVENT_RESERVES);
  kv("SELL priority fee", SELL_PRIORITY_FEE_MICROLAMPORTS);
  kv("SELL turbo multi-region", TURBO_SELL_MULTI_REGION);
  kv("SELL pre-balance RPC", TURBO_SELL_SKIP_PRE_BALANCE ? "SKIPPED" : "ENABLED");
  kv("Helius Sender", HELIUS_SENDER_ENABLED
    ? (PRIORITY_FEE_MICROLAMPORTS > 0
        ? "SWQOS ENABLED"
        : "CONFIGURED - RPC fallback because priority fee is 0")
    : "DISABLED");
  kv("Sender tip", `${HELIUS_SENDER_TIP_LAMPORTS} lamports`);
  kv("BUY Sender tip", `${BUY_SENDER_TIP_LAMPORTS} lamports`);
  kv("SELL Sender tip", `${SELL_SENDER_TIP_LAMPORTS} lamports`);
  kv("Sender endpoint", safeEndpointLabel(HELIUS_SENDER_URL));
  kv("Pending BUY recovery", "ENABLED");
  kv("Skip preflight", SKIP_PREFLIGHT);
  kv("WebSocket commitment", WS_COMMITMENT);
  kv("Enhanced full-tx stream", USE_ENHANCED_TRANSACTION_STREAM);
  kv("Parallel analysis", ANALYSIS_CONCURRENCY);
  kv("Free-tier RPC mode", "LOW-RPC / 429 SAFE");
  kv("Execution order", "STRICT WebSocket arrival order");
  kv("Own tx settlement", "WS processed/confirmed + direct ATA balance reads");
  kv("Hot path", "cached SOL/USD + blockhash + wallet SOL");
  kv("Latency metrics", "target seen -> tx loaded -> bot sent (ms)");
  kv("Pump direct-log fast path", "ENABLED (TradeEvent -> no tx fetch)");
  kv("FAST_PUMP_ONLY", FAST_PUMP_ONLY
    ? "true - no ~1s fallback fetches in trade queue"
    : "false - Jupiter/PumpSwap/unknown fallback enabled");
  kv("Trailing stop", TRAILING_STOP_ENABLED
    ? `${TRAILING_STOP_PERCENT}% from local peak`
    : "DISABLED");

  section(
    "TRADE FILTERS",
    ANSI.magenta,
  );

  kv("Ordinary SOL transfers", "IGNORED");
  kv("Ordinary token transfers", "IGNORED");
  kv("createIdempotent", "IGNORED");
  kv("Pump creator fees", "IGNORED");
  kv("Pump.fun", "BUY/SELL + verified token delta");
  kv("PumpSwap", "BUY/SELL + verified token delta");
  kv("Jupiter v6", "NET TOKEN DELTA (SOL + stable quotes)");
  kv("Generic Swap instructions", "IGNORED");

  section(
    "EXECUTION RULES",
    ANSI.yellow,
  );

  kv("SELL without tracked BUY", "BLOCKED");
  kv("SELL requires tracked position", "YES");
  kv("Wallet-balance SELL fallback", "DISABLED");
  kv("SELL sizing", "PROPORTIONAL");
  kv("Live SELL state update", TURBO_SELL_SKIP_PRE_BALANCE ? "after successful processed signature" : "after real balance decrease");
  kv("Pump token programs", "SPL Token + Token-2022");
  kv("Jupiter API", JUPITER_API_KEY
    ? "Swap V2 /order + /execute"
    : "Lite Swap V1 (no API key)");
  kv("Jupiter V2 slippage", JUPITER_V2_USE_MANUAL_SLIPPAGE
    ? `MANUAL ${SLIPPAGE}%`
    : "RTSE automatic");

  await subscribeToTarget();

  while (
    true
  ) {
    await sleep(
      30_000,
    );

    try {
      await connection.getSlot(
        "processed",
      );
    } catch (error) {
      console.error(
        paint(
          "[X] RPC health check failed:",
          ANSI.bold,
          ANSI.red,
        ),
        error,
      );

      await reconnectWebSocket();
    }
  }
}

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  printMoneyBanner();

  section(
    "STARTUP",
    ANSI.cyan,
  );

  kv("Target wallet", TARGET_WALLET);
  kv("BUY_USD", BUY_USD);
  kv("SLIPPAGE", `${SLIPPAGE}%`);
  kv("SELL_SLIPPAGE", `${SELL_SLIPPAGE}%`);
  kv("MAX_SOL_PER_TRADE", MAX_SOL_PER_TRADE);
  kv("MIN_SOL_BALANCE", MIN_SOL_BALANCE);
  kv("DRY_RUN", DRY_RUN);
  kv("PRIORITY_FEE_MICROLAMPORTS", PRIORITY_FEE_MICROLAMPORTS);
  kv("TURBO_BUY_MULTI_REGION", TURBO_BUY_MULTI_REGION);
  kv("TURBO_BUY_USE_EVENT_RESERVES", TURBO_BUY_USE_EVENT_RESERVES);
  kv("SELL_PRIORITY_FEE_MICROLAMPORTS", SELL_PRIORITY_FEE_MICROLAMPORTS);
  kv("HELIUS_SENDER_ENABLED", HELIUS_SENDER_ENABLED);
  kv("HELIUS_SENDER_TIP_LAMPORTS", HELIUS_SENDER_TIP_LAMPORTS);
  kv("BUY_SENDER_TIP_LAMPORTS", BUY_SENDER_TIP_LAMPORTS);
  kv("SELL_SENDER_TIP_LAMPORTS", SELL_SENDER_TIP_LAMPORTS);
  kv("TURBO_SELL_MULTI_REGION", TURBO_SELL_MULTI_REGION);
  kv("TURBO_SELL_SKIP_PRE_BALANCE", TURBO_SELL_SKIP_PRE_BALANCE);
  kv("HELIUS_SENDER_URL", safeEndpointLabel(HELIUS_SENDER_URL));
  kv("SKIP_PREFLIGHT", SKIP_PREFLIGHT);
  kv("ENHANCED_TX_STREAM", USE_ENHANCED_TRANSACTION_STREAM);
  kv("FAST_PUMP_ONLY", FAST_PUMP_ONLY);
  kv("TRAILING_STOP_ENABLED", TRAILING_STOP_ENABLED);
  kv("TRAILING_STOP_PERCENT", `${TRAILING_STOP_PERCENT}%`);
  kv("SAFE_COPY_MODE", SAFE_COPY_MODE);
  kv("SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT", `${SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT}%`);
  kv("SAFE_COPY_MAX_OPEN_POSITIONS", SAFE_COPY_MAX_OPEN_POSITIONS);
  kv("SAFE_COPY_ONE_BUY_PER_MINT", SAFE_COPY_ONE_BUY_PER_MINT);
  kv("SAFE_COPY_HARD_STOP_PERCENT", `${SAFE_COPY_HARD_STOP_PERCENT}%`);
  kv("SAFE_COPY_TAKE_PROFIT_PERCENT", `${SAFE_COPY_TAKE_PROFIT_PERCENT}%`);
  kv("SAFE_COPY_TRAILING_ACTIVATE_PERCENT", `${SAFE_COPY_TRAILING_ACTIVATE_PERCENT}%`);
  kv("SAFE_COPY_TRAILING_PERCENT", `${SAFE_COPY_TRAILING_PERCENT}%`);
  kv("SAFE_COPY_BREAKEVEN_ARM_PERCENT", `${SAFE_COPY_BREAKEVEN_ARM_PERCENT}%`);
  kv("SAFE_COPY_BREAKEVEN_FLOOR_PERCENT", `${SAFE_COPY_BREAKEVEN_FLOOR_PERCENT}%`);
  kv("SIGNAL_MIN_TARGET_BUY_SOL", `${SIGNAL_MIN_TARGET_BUY_SOL} SOL`);
  kv("SIGNAL_MAX_TARGET_BUY_SOL", `${SIGNAL_MAX_TARGET_BUY_SOL} SOL`);
  kv("SIGNAL_LEADER_MIN_BUY_SOL", `${SIGNAL_LEADER_MIN_BUY_SOL} SOL`);
  kv("SIGNAL_CONFIRM_WINDOW_MS", SIGNAL_CONFIRM_WINDOW_MS);
  kv("SIGNAL_REQUIRE_LEADER_FOR_SMALL_BUY", SIGNAL_REQUIRE_LEADER_FOR_SMALL_BUY);
  kv("SIGNAL_MIN_CUMULATIVE_BUY_SOL", `${SIGNAL_MIN_CUMULATIVE_BUY_SOL} SOL`);
  kv("SIGNAL_REAL_SOL_RESERVE", `${SIGNAL_MIN_REAL_SOL_RESERVE}-${SIGNAL_MAX_REAL_SOL_RESERVE} SOL`);
  kv("SIGNAL_FULL_EXIT_ON_TARGET_SELL", SIGNAL_FULL_EXIT_ON_TARGET_SELL);
  kv("SAFE_COPY_MAX_HOLD_MS", SAFE_COPY_MAX_HOLD_MS);
  kv(
    "RPC_URL",
    safeEndpointLabel(
      RPC_URL,
    ),
  );
  kv(
    "RPC_WS",
    RPC_WS
      ? safeEndpointLabel(
          RPC_WS,
        )
      : "default",
  );
  kv("STATE_FILE", STATE_FILE);
  kv(
    "Jupiter API",
    JUPITER_API_KEY
      ? JUPITER_V2_API_BASE
      : JUPITER_V1_API_BASE,
  );
  kv(
    "Jupiter V2 slippage",
    JUPITER_V2_USE_MANUAL_SLIPPAGE
      ? `MANUAL ${SLIPPAGE}%`
      : "RTSE automatic",
  );

  status(
    DRY_RUN
      ? "DRY RUN mode - no real trade will be sent."
      : "LIVE MODE - real trades are enabled.",
    DRY_RUN
      ? "warning"
      : "success",
  );

  if (
    DRY_RUN
  ) {
    status(
      "Dry-run state is isolated from live state.",
      "info",
    );
  }

  if (
    !Number.isFinite(
      BUY_USD,
    ) ||
    BUY_USD <= 0
  ) {
    throw new Error(
      "BUY_USD must be greater than 0.",
    );
  }

  if (
    !Number.isFinite(
      SLIPPAGE,
    ) ||
    SLIPPAGE <= 0
  ) {
    throw new Error(
      "SLIPPAGE must be greater than 0.",
    );
  }

  if (
    !Number.isFinite(
      MAX_SOL_PER_TRADE,
    ) ||
    MAX_SOL_PER_TRADE <= 0
  ) {
    throw new Error(
      "MAX_SOL_PER_TRADE must be greater than 0.",
    );
  }

  const wallet =
    getBotWallet();

  const botWalletAddress =
    wallet.publicKey.toBase58();

  kv(
    "Bot wallet",
    botWalletAddress,
  );

  loadPersistentState(
    botWalletAddress,
  );

  await checkRpc();

  status(
    "Warming FAST caches...",
    "info",
  );

  await Promise.allSettled([
    getFastLatestBlockhash(),
    solUsd(),
    getPumpGlobalCached(),
    refreshBotSolBalance(),
    warmHeliusSenderConnection(),
  ]);

  status(
    "FAST caches ready (blockhash / SOL price / Pump global / wallet SOL).",
    "success",
  );

  startHotCacheWarmers();

  await reconcileLivePositionsWithWallet(
    wallet.publicKey,
  );

  await startTrailingStopsForExistingPositions();

  await monitor();
}

// ============================================================
// GLOBAL ERROR
// ============================================================

main().catch(
  error => {
    console.error(
      paint(
        `\n${line("=")}`,
        ANSI.red,
      ),
    );

    console.error(
      paint(
        "FATAL ERROR:",
        ANSI.bold,
        ANSI.red,
      ),
    );

    console.error(
      error,
    );

    process.exit(
      1,
    );
  },
);