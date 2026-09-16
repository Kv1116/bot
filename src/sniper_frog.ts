import "dotenv/config";

import fs from "node:fs";
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Logs,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  PUMP_SDK,
  bondingCurvePda,
} from "@pump-fun/pump-sdk";

// ============================================================
// PUMP.FUN PAPER SNIPER / FILTER ENGINE
// ============================================================
// IMPORTANT:
// - This first version intentionally DOES NOT send real transactions.
// - It watches all Pump.fun TradeEvent logs, scores very-early coins,
//   simulates entries/exits conservatively, and writes every paper trade.
// - The goal is to prove that the rules have positive expectancy BEFORE
//   risking a wallet. No strategy can guarantee profit.
// ============================================================

const RPC_URL =
  process.env.RPC_URL ||
  "https://api.mainnet-beta.solana.com";

const RPC_WS = process.env.RPC_WS || undefined;

const connection = new Connection(
  RPC_URL,
  {
    commitment: "processed",
    wsEndpoint: RPC_WS,
  },
);

const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";
const DEFAULT_PUBKEY =
  "11111111111111111111111111111111";

// Pump bonding-curve TradeEvent discriminator:
// sha256("event:TradeEvent")[0..8]
const PUMP_TRADE_EVENT_DISCRIMINATOR_HEX =
  "bddb7fd34ee661ee";

// CreateEvent = sha256("event:CreateEvent")[0..8].
// We use it so "new token" really means a token created while this scanner is running,
// rather than merely a token whose first trade we happened to observe.
const PUMP_CREATE_EVENT_DISCRIMINATOR_HEX =
  "1b72a94ddeeb6376";

const TARGET_WALLET =
  process.env.TARGET_WALLET ||
  "4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh";

const NEW_TOKENS_ONLY = boolEnv(
  "SNIPER_NEW_TOKENS_ONLY",
  true,
);

// ----------------------------
// SAFETY / PAPER MODE
// ----------------------------
const SNIPER_PAPER_ONLY =
  String(
    process.env.SNIPER_PAPER_ONLY || "true",
  ).toLowerCase() !== "false";

if (!SNIPER_PAPER_ONLY) {
  throw new Error(
    "This sniper build is intentionally PAPER-ONLY. Keep SNIPER_PAPER_ONLY=true until the paper statistics are positive after fees.",
  );
}

// ----------------------------
// ENTRY FILTERS
// ----------------------------
const BUY_SOL = numEnv("SNIPER_BUY_SOL", 0.01);
const MAX_OPEN_POSITIONS = intEnv(
  "SNIPER_MAX_OPEN_POSITIONS",
  1,
);

const MIN_AGE_MS = intEnv(
  "SNIPER_MIN_AGE_MS",
  2500,
);
const MAX_AGE_MS = intEnv(
  "SNIPER_MAX_AGE_MS",
  15000,
);

const MIN_UNIQUE_BUYERS = intEnv(
  "SNIPER_MIN_UNIQUE_BUYERS",
  10,
);
const MIN_BUY_TX = intEnv(
  "SNIPER_MIN_BUY_TX",
  12,
);
const MIN_BUY_VOLUME_SOL = numEnv(
  "SNIPER_MIN_BUY_VOLUME_SOL",
  1.5,
);
const MAX_SELL_VOLUME_RATIO = numEnv(
  "SNIPER_MAX_SELL_VOLUME_RATIO",
  0.18,
);

// Before graduation there is no normal LP pool. The real SOL reserve in the
// bonding curve is used as a conservative liquidity/depth proxy.
const MIN_REAL_SOL_RESERVE = numEnv(
  "SNIPER_MIN_REAL_SOL_RESERVE",
  1.5,
);
const MAX_REAL_SOL_RESERVE = numEnv(
  "SNIPER_MAX_REAL_SOL_RESERVE",
  12,
);

const MIN_MARKET_CAP_SOL = numEnv(
  "SNIPER_MIN_MARKET_CAP_SOL",
  10,
);
const MAX_MARKET_CAP_SOL = numEnv(
  "SNIPER_MAX_MARKET_CAP_SOL",
  45,
);

const MIN_MOMENTUM_PERCENT = numEnv(
  "SNIPER_MIN_MOMENTUM_PERCENT",
  4,
);
const MAX_MOMENTUM_PERCENT = numEnv(
  "SNIPER_MAX_MOMENTUM_PERCENT",
  28,
);

const MAX_TOP_HOLDER_SHARE = numEnv(
  "SNIPER_MAX_TOP_HOLDER_SHARE",
  0.22,
);
const MAX_CREATOR_SHARE = numEnv(
  "SNIPER_MAX_CREATOR_SHARE",
  0.10,
);
const MIN_ENTRY_SCORE = intEnv(
  "SNIPER_MIN_ENTRY_SCORE",
  85,
);

const REJECT_MAYHEM = boolEnv(
  "SNIPER_REJECT_MAYHEM",
  true,
);
const REJECT_HOLDER_REWARD = boolEnv(
  "SNIPER_REJECT_HOLDER_REWARD",
  false,
);

// ----------------------------
// MR. FROG-LIKE EARLY PROFILE (PAPER ONLY)
// ----------------------------
// Based on the public wallet pattern we are testing: mostly fresh Pump.fun
// coins below $100k market cap, short holding periods, and very early entries.
// These are hypotheses to test, not a promise of profit.
const FROG_PROFILE = boolEnv("SNIPER_FROG_PROFILE", true);
const FROG_MIN_MARKET_CAP_USD = numEnv("SNIPER_FROG_MIN_MARKET_CAP_USD", 8000);
const FROG_MAX_MARKET_CAP_USD = numEnv("SNIPER_FROG_MAX_MARKET_CAP_USD", 65000);
const FROG_MIN_AGE_MS = intEnv("SNIPER_FROG_MIN_AGE_MS", 800);
const FROG_MAX_AGE_MS = intEnv("SNIPER_FROG_MAX_AGE_MS", 60000);
const FROG_MIN_UNIQUE_BUYERS = intEnv("SNIPER_FROG_MIN_UNIQUE_BUYERS", 3);
const FROG_MIN_BUY_TX = intEnv("SNIPER_FROG_MIN_BUY_TX", 4);
const FROG_MIN_BUY_VOLUME_SOL = numEnv("SNIPER_FROG_MIN_BUY_VOLUME_SOL", 0.30);
const FROG_MAX_SELL_VOLUME_RATIO = numEnv("SNIPER_FROG_MAX_SELL_VOLUME_RATIO", 0.30);
const FROG_MIN_REAL_SOL_RESERVE = numEnv("SNIPER_FROG_MIN_REAL_SOL_RESERVE", 0.25);
const FROG_MAX_REAL_SOL_RESERVE = numEnv("SNIPER_FROG_MAX_REAL_SOL_RESERVE", 30);
const FROG_MAX_TOP_HOLDER_SHARE = numEnv("SNIPER_FROG_MAX_TOP_HOLDER_SHARE", 0.30);
const FROG_MAX_CREATOR_SHARE = numEnv("SNIPER_FROG_MAX_CREATOR_SHARE", 0.05);
const FROG_MIN_ENTRY_SCORE = intEnv("SNIPER_FROG_MIN_ENTRY_SCORE", 72);

// Pullback/recovery gate: do not catch a falling knife. We wait for a small
// pullback and then require a measurable rebound with live buy flow. A much
// larger drawdown is treated as a crash and permanently rejected.
const REQUIRE_PULLBACK_RECOVERY = boolEnv("SNIPER_REQUIRE_PULLBACK_RECOVERY", true);
const PULLBACK_MIN_PERCENT = numEnv("SNIPER_PULLBACK_MIN_PERCENT", 3);
const PULLBACK_MAX_PERCENT = numEnv("SNIPER_PULLBACK_MAX_PERCENT", 12);
const RECOVERY_MIN_PERCENT = numEnv("SNIPER_RECOVERY_MIN_PERCENT", 1.5);
const CRASH_REJECT_PERCENT = numEnv("SNIPER_CRASH_REJECT_PERCENT", 16);
const CRASH_SELL_RATIO = numEnv("SNIPER_CRASH_SELL_RATIO", 0.38);
const TARGET_CONFIRMATION_BONUS = intEnv("SNIPER_TARGET_CONFIRMATION_BONUS", 12);

// ----------------------------
// EXIT RULES (PAPER)
// ----------------------------
const TAKE_PROFIT_PERCENT = numEnv(
  "SNIPER_TAKE_PROFIT_PERCENT",
  15,
);
const TRAILING_ACTIVATE_PERCENT = numEnv(
  "SNIPER_TRAILING_ACTIVATE_PERCENT",
  8,
);
const TRAILING_PERCENT = numEnv(
  "SNIPER_TRAILING_PERCENT",
  4,
);
const STOP_LOSS_PERCENT = numEnv(
  "SNIPER_STOP_LOSS_PERCENT",
  8,
);
const MAX_HOLD_MS = intEnv(
  "SNIPER_MAX_HOLD_MS",
  20000,
);

// Conservative simulation cost model.
// Pump bonding curve platform fee is 1.25%; we default to 1.50% so paper
// results are not flattering. Sender / priority / network costs are modeled
// separately below.
const TRADE_FEE_PERCENT = numEnv(
  "SNIPER_TRADE_FEE_PERCENT",
  1.50,
);
const ENTRY_EXTRA_SLIPPAGE_PERCENT = numEnv(
  "SNIPER_ENTRY_EXTRA_SLIPPAGE_PERCENT",
  1.0,
);
const EXIT_EXTRA_SLIPPAGE_PERCENT = numEnv(
  "SNIPER_EXIT_EXTRA_SLIPPAGE_PERCENT",
  1.0,
);
const TX_COST_SOL = numEnv(
  "SNIPER_TX_COST_SOL",
  0.00003,
);

// Small rolling window for momentum / order-flow quality.
const ROLLING_WINDOW_MS = intEnv(
  "SNIPER_ROLLING_WINDOW_MS",
  5000,
);

const MAX_TRACKED_CANDIDATES = intEnv(
  "SNIPER_MAX_TRACKED_CANDIDATES",
  500,
);

const PAPER_LOG =
  process.env.SNIPER_PAPER_LOG ||
  "sniper-paper.jsonl";

const STATUS_EVERY_MS = intEnv(
  "SNIPER_STATUS_EVERY_MS",
  15000,
);

const SOL_USD_REFRESH_MS = intEnv(
  "SNIPER_SOL_USD_REFRESH_MS",
  60000,
);

// ============================================================
// TYPES
// ============================================================

type Direction = "BUY" | "SELL";

interface PumpCreateEvent {
  mint: string;
  creator: string;
  user: string;
  timestampSec: number;
  virtualQuoteReserves: BN;
  virtualTokenReserves: BN;
  realTokenReserves: BN;
  tokenTotalSupply: BN;
  tokenProgram: string;
  mayhem: boolean;
  observedAtMs: number;
  signature: string;
}

interface PumpTradeEvent {
  mint: string;
  user: string;
  direction: Direction;
  quoteLamports: BN;
  tokenAmount: BN;
  virtualQuoteReserves: BN | null;
  virtualTokenReserves: BN | null;
  realQuoteReserves: BN | null;
  realTokenReserves: BN | null;
  observedAtMs: number;
  signature: string;
}

interface RollingTrade {
  atMs: number;
  user: string;
  direction: Direction;
  quoteLamports: BN;
  tokenAmount: BN;
}

interface Candidate {
  mint: string;
  firstSeenAtMs: number;
  lastSeenAtMs: number;

  firstVirtualQuoteReserves: BN;
  firstVirtualTokenReserves: BN;

  virtualQuoteReserves: BN;
  virtualTokenReserves: BN;
  realQuoteReserves: BN;
  realTokenReserves: BN;

  buyTx: number;
  sellTx: number;
  buyVolumeLamports: BN;
  sellVolumeLamports: BN;
  uniqueBuyers: Set<string>;
  uniqueSellers: Set<string>;

  // Approximate net holdings created by observed trades. Since tracking starts
  // at the first TradeEvent we see, this is useful for concentration checks.
  netTokensByUser: Map<string, BN>;

  rolling: RollingTrade[];

  hydrated: boolean;
  hydrationFailed: boolean;
  tokenTotalSupply: BN | null;
  creator: string | null;
  complete: boolean;
  quoteMint: string | null;
  mayhem: boolean | null;
  holderReward: boolean | null;

  creatorSold: boolean;

  // New-token / microstructure state.
  createdAtMs: number | null;
  peakPriceScaled: BN;
  troughAfterPeakScaled: BN;
  maxDrawdownPct: number;
  targetBoughtEarly: boolean;

  entered: boolean;
  rejectedPermanent: boolean;
  lastRejectReason: string | null;
}

interface PaperPosition {
  mint: string;
  openedAtMs: number;
  tokenAmount: BN;
  buySol: number;
  entryCostSol: number;
  entryMarketCapSol: number;
  entryLiquiditySol: number;
  entryScore: number;
  peakNetValueSol: number;
  peakPnlPct: number;
  trailingArmed: boolean;
  entrySignature: string;
}

interface PaperStats {
  closed: number;
  wins: number;
  losses: number;
  grossPnlSol: number;
  bestPct: number;
  worstPct: number;
}

// ============================================================
// STATE
// ============================================================

const candidates = new Map<string, Candidate>();
const createdMints = new Map<string, PumpCreateEvent>();
const positions = new Map<string, PaperPosition>();

const stats: PaperStats = {
  closed: 0,
  wins: 0,
  losses: 0,
  grossPnlSol: 0,
  bestPct: -Infinity,
  worstPct: Infinity,
};

let solUsd: number | null = null;
let solUsdUpdatedAtMs = 0;
let eventCount = 0;
let candidateCount = 0;
let filteredCount = 0;
let lastStatusAt = 0;

// ============================================================
// ENV HELPERS
// ============================================================

function numEnv(
  key: string,
  fallback: number,
): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value)
    ? value
    : fallback;
}

function intEnv(
  key: string,
  fallback: number,
): number {
  return Math.max(
    0,
    Math.trunc(
      numEnv(key, fallback),
    ),
  );
}

function boolEnv(
  key: string,
  fallback: boolean,
): boolean {
  const raw = process.env[key];
  if (raw == null) return fallback;
  return String(raw).toLowerCase() === "true";
}

// ============================================================
// FORMAT / MATH
// ============================================================

function lamportsToSol(value: BN): number {
  return Number(value.toString(10)) /
    LAMPORTS_PER_SOL;
}

function pct(
  value: number,
): string {
  return `${value.toFixed(2)}%`;
}

function formatSol(
  value: number,
): string {
  return `${value.toFixed(5)} SOL`;
}

function marketCapSol(
  c: Candidate,
): number | null {
  if (
    !c.tokenTotalSupply ||
    c.virtualTokenReserves.isZero()
  ) {
    return null;
  }

  const capLamports =
    c.virtualQuoteReserves
      .mul(c.tokenTotalSupply)
      .div(c.virtualTokenReserves);

  return lamportsToSol(capLamports);
}

function priceScaled(
  virtualQuoteReserves: BN,
  virtualTokenReserves: BN,
): BN {
  if (virtualTokenReserves.isZero()) {
    return new BN(0);
  }

  return virtualQuoteReserves
    .mul(new BN("1000000000000000000"))
    .div(virtualTokenReserves);
}

function momentumPercent(
  c: Candidate,
): number {
  const first = priceScaled(
    c.firstVirtualQuoteReserves,
    c.firstVirtualTokenReserves,
  );
  const current = priceScaled(
    c.virtualQuoteReserves,
    c.virtualTokenReserves,
  );

  if (first.isZero()) return 0;

  const ratioBps = current
    .mul(new BN(10000))
    .div(first)
    .sub(new BN(10000));

  return Number(ratioBps.toString(10)) / 100;
}

function pullbackMetrics(
  c: Candidate,
): { drawdownPct: number; reboundPct: number } {
  const current = priceScaled(
    c.virtualQuoteReserves,
    c.virtualTokenReserves,
  );
  const peak = c.peakPriceScaled;
  const trough = c.troughAfterPeakScaled;

  let drawdownPct = 0;
  if (!peak.isZero() && current.lt(peak)) {
    const bps = peak.sub(current)
      .mul(new BN(10000))
      .div(peak);
    drawdownPct = Number(bps.toString(10)) / 100;
  }

  let reboundPct = 0;
  if (!trough.isZero() && current.gt(trough)) {
    const bps = current.sub(trough)
      .mul(new BN(10000))
      .div(trough);
    reboundPct = Number(bps.toString(10)) / 100;
  }

  return { drawdownPct, reboundPct };
}

function circulatingTokens(
  c: Candidate,
): BN | null {
  if (!c.tokenTotalSupply) return null;

  const circulating =
    c.tokenTotalSupply.sub(
      c.realTokenReserves,
    );

  return circulating.isNeg()
    ? new BN(0)
    : circulating;
}

function userShare(
  c: Candidate,
  user: string,
): number {
  const circulating = circulatingTokens(c);
  if (!circulating || circulating.isZero()) {
    return 0;
  }

  const amount =
    c.netTokensByUser.get(user) ||
    new BN(0);

  if (amount.lte(new BN(0))) {
    return 0;
  }

  const bps = amount
    .mul(new BN(10000))
    .div(circulating);

  return Number(bps.toString(10)) /
    10000;
}

function topObservedHolderShare(
  c: Candidate,
): number {
  const circulating = circulatingTokens(c);
  if (!circulating || circulating.isZero()) {
    return 0;
  }

  let largest = new BN(0);
  for (const amount of c.netTokensByUser.values()) {
    if (amount.gt(largest)) {
      largest = amount;
    }
  }

  if (largest.isZero()) return 0;

  const bps = largest
    .mul(new BN(10000))
    .div(circulating);

  return Number(bps.toString(10)) /
    10000;
}

function sellVolumeRatio(
  c: Candidate,
): number {
  const total = c.buyVolumeLamports.add(
    c.sellVolumeLamports,
  );
  if (total.isZero()) return 0;

  const bps = c.sellVolumeLamports
    .mul(new BN(10000))
    .div(total);
  return Number(bps.toString(10)) /
    10000;
}

function rollingMetrics(
  c: Candidate,
  now: number,
): {
  buyTx: number;
  sellTx: number;
  buySol: number;
  sellSol: number;
  uniqueBuyers: number;
} {
  const cutoff = now - ROLLING_WINDOW_MS;
  c.rolling = c.rolling.filter(
    t => t.atMs >= cutoff,
  );

  let buyTx = 0;
  let sellTx = 0;
  let buyLamports = new BN(0);
  let sellLamports = new BN(0);
  const buyers = new Set<string>();

  for (const t of c.rolling) {
    if (t.direction === "BUY") {
      buyTx += 1;
      buyLamports = buyLamports.add(
        t.quoteLamports,
      );
      buyers.add(t.user);
    } else {
      sellTx += 1;
      sellLamports = sellLamports.add(
        t.quoteLamports,
      );
    }
  }

  return {
    buyTx,
    sellTx,
    buySol: lamportsToSol(buyLamports),
    sellSol: lamportsToSol(sellLamports),
    uniqueBuyers: buyers.size,
  };
}

// Conservative constant-product paper quote. This is intentionally not used
// for real transactions. It subtracts a configurable fee/slippage buffer so a
// paper backtest is harder to pass than an optimistic spot-price calculation.
function paperBuyTokenAmount(
  virtualQuoteReserves: BN,
  virtualTokenReserves: BN,
  spendSol: number,
): BN {
  const spendLamports = new BN(
    Math.floor(
      spendSol * LAMPORTS_PER_SOL,
    ).toString(),
  );

  const haircutBps = Math.floor(
    (TRADE_FEE_PERCENT +
      ENTRY_EXTRA_SLIPPAGE_PERCENT) *
      100,
  );

  const effectiveQuote = spendLamports
    .mul(new BN(10000 - haircutBps))
    .div(new BN(10000));

  const k = virtualQuoteReserves.mul(
    virtualTokenReserves,
  );
  const newQuote = virtualQuoteReserves.add(
    effectiveQuote,
  );
  if (newQuote.isZero()) return new BN(0);

  const newToken = k.div(newQuote);
  const out = virtualTokenReserves.sub(
    newToken,
  );

  return out.isNeg()
    ? new BN(0)
    : out;
}

function paperSellSol(
  virtualQuoteReserves: BN,
  virtualTokenReserves: BN,
  tokenAmount: BN,
): number {
  if (tokenAmount.isZero()) return 0;

  const k = virtualQuoteReserves.mul(
    virtualTokenReserves,
  );
  const newToken = virtualTokenReserves.add(
    tokenAmount,
  );
  if (newToken.isZero()) return 0;

  const newQuote = k.div(newToken);
  let gross = virtualQuoteReserves.sub(
    newQuote,
  );
  if (gross.isNeg()) gross = new BN(0);

  const haircutBps = Math.floor(
    (TRADE_FEE_PERCENT +
      EXIT_EXTRA_SLIPPAGE_PERCENT) *
      100,
  );

  const net = gross
    .mul(new BN(10000 - haircutBps))
    .div(new BN(10000));

  return Math.max(
    0,
    lamportsToSol(net) - TX_COST_SOL,
  );
}

// ============================================================
// EVENT DECODER
// ============================================================

function readBorshString(
  data: Buffer,
  offset: number,
): { value: string; offset: number } {
  if (offset + 4 > data.length) throw new Error("borsh string length");
  const len = data.readUInt32LE(offset);
  offset += 4;
  if (len > 4096 || offset + len > data.length) throw new Error("borsh string bounds");
  return {
    value: data.subarray(offset, offset + len).toString("utf8"),
    offset: offset + len,
  };
}

function decodePumpCreateEvents(
  logs: string[],
  signature: string,
  observedAtMs: number,
): PumpCreateEvent[] {
  const events: PumpCreateEvent[] = [];

  for (const rawLog of logs) {
    const match = typeof rawLog === "string"
      ? rawLog.match(/^Program data:\\s*([A-Za-z0-9+/=]+)\\s*$/)
      : null;
    if (!match) continue;

    try {
      const data = Buffer.from(match[1], "base64");
      if (data.length < 8 || data.subarray(0, 8).toString("hex") !== PUMP_CREATE_EVENT_DISCRIMINATOR_HEX) continue;

      let o = 8;
      const name = readBorshString(data, o); o = name.offset;
      const symbol = readBorshString(data, o); o = symbol.offset;
      const uri = readBorshString(data, o); o = uri.offset;
      void name; void symbol; void uri;

      const readPk = () => {
        if (o + 32 > data.length) throw new Error("pubkey bounds");
        const v = new PublicKey(data.subarray(o, o + 32)).toBase58();
        o += 32;
        return v;
      };
      const readU64 = () => {
        if (o + 8 > data.length) throw new Error("u64 bounds");
        const v = new BN(data.subarray(o, o + 8), "le");
        o += 8;
        return v;
      };

      const mint = readPk();
      readPk(); // bonding curve
      const user = readPk();
      const creator = readPk();
      const timestamp = readU64();
      const virtualTokenReserves = readU64();
      const virtualQuoteReserves = readU64();
      const realTokenReserves = readU64();
      const tokenTotalSupply = readU64();
      const tokenProgram = readPk();
      const mayhem = o < data.length ? data[o] !== 0 : false;

      events.push({
        mint, creator, user,
        timestampSec: Number(timestamp.toString(10)),
        virtualQuoteReserves,
        virtualTokenReserves,
        realTokenReserves,
        tokenTotalSupply,
        tokenProgram,
        mayhem,
        observedAtMs,
        signature,
      });
    } catch {
      // Ignore malformed/non-current CreateEvent layouts.
    }
  }
  return events;
}

function decodePumpTradeEvents(
  logs: string[],
  signature: string,
  observedAtMs: number,
): PumpTradeEvent[] {
  const events: PumpTradeEvent[] = [];

  for (const rawLog of logs) {
    if (typeof rawLog !== "string") continue;

    const match = rawLog.match(
      /^Program data:\s*([A-Za-z0-9+/=]+)\s*$/,
    );
    if (!match) continue;

    try {
      const data = Buffer.from(
        match[1],
        "base64",
      );

      if (data.length < 129) continue;

      if (
        data.subarray(0, 8).toString("hex") !==
        PUMP_TRADE_EVENT_DISCRIMINATOR_HEX
      ) {
        continue;
      }

      const mint = new PublicKey(
        data.subarray(8, 40),
      ).toBase58();
      const quoteLamports = new BN(
        data.subarray(40, 48),
        "le",
      );
      const tokenAmount = new BN(
        data.subarray(48, 56),
        "le",
      );
      const isBuy = data[56] !== 0;
      const user = new PublicKey(
        data.subarray(57, 89),
      ).toBase58();

      const virtualQuoteReserves = new BN(
        data.subarray(97, 105),
        "le",
      );
      const virtualTokenReserves = new BN(
        data.subarray(105, 113),
        "le",
      );
      const realQuoteReserves = new BN(
        data.subarray(113, 121),
        "le",
      );
      const realTokenReserves = new BN(
        data.subarray(121, 129),
        "le",
      );

      if (
        tokenAmount.isZero() ||
        virtualQuoteReserves.isZero() ||
        virtualTokenReserves.isZero()
      ) {
        continue;
      }

      events.push({
        mint,
        user,
        direction: isBuy ? "BUY" : "SELL",
        quoteLamports,
        tokenAmount,
        virtualQuoteReserves,
        virtualTokenReserves,
        realQuoteReserves,
        realTokenReserves,
        observedAtMs,
        signature,
      });
    } catch {
      // Ignore non-matching / malformed Program data.
    }
  }

  return events;
}

// ============================================================
// CANDIDATE TRACKING
// ============================================================

function createCandidate(
  e: PumpTradeEvent,
  created: PumpCreateEvent | null = null,
): Candidate {
  const virtualQuote =
    e.virtualQuoteReserves!;
  const virtualToken =
    e.virtualTokenReserves!;
  const realQuote =
    e.realQuoteReserves!;
  const realToken =
    e.realTokenReserves!;

  candidateCount += 1;

  return {
    mint: e.mint,
    firstSeenAtMs: created?.observedAtMs ?? e.observedAtMs,
    lastSeenAtMs: e.observedAtMs,
    firstVirtualQuoteReserves:
      (created?.virtualQuoteReserves ?? virtualQuote).clone(),
    firstVirtualTokenReserves:
      (created?.virtualTokenReserves ?? virtualToken).clone(),
    virtualQuoteReserves:
      virtualQuote.clone(),
    virtualTokenReserves:
      virtualToken.clone(),
    realQuoteReserves:
      realQuote.clone(),
    realTokenReserves:
      realToken.clone(),
    buyTx: 0,
    sellTx: 0,
    buyVolumeLamports: new BN(0),
    sellVolumeLamports: new BN(0),
    uniqueBuyers: new Set(),
    uniqueSellers: new Set(),
    netTokensByUser: new Map(),
    rolling: [],
    hydrated: false,
    hydrationFailed: false,
    tokenTotalSupply: created?.tokenTotalSupply.clone() ?? null,
    creator: created?.creator ?? null,
    complete: false,
    quoteMint: null,
    mayhem: created?.mayhem ?? null,
    holderReward: null,
    creatorSold: false,
    createdAtMs: created?.observedAtMs ?? null,
    peakPriceScaled: priceScaled(virtualQuote, virtualToken),
    troughAfterPeakScaled: priceScaled(virtualQuote, virtualToken),
    maxDrawdownPct: 0,
    targetBoughtEarly: false,
    entered: false,
    rejectedPermanent: false,
    lastRejectReason: null,
  };
}

function applyTrade(
  c: Candidate,
  e: PumpTradeEvent,
): void {
  c.lastSeenAtMs = e.observedAtMs;
  c.virtualQuoteReserves =
    e.virtualQuoteReserves!.clone();
  c.virtualTokenReserves =
    e.virtualTokenReserves!.clone();
  c.realQuoteReserves =
    e.realQuoteReserves!.clone();
  c.realTokenReserves =
    e.realTokenReserves!.clone();

  const currentPx = priceScaled(
    c.virtualQuoteReserves,
    c.virtualTokenReserves,
  );
  if (c.peakPriceScaled.isZero() || currentPx.gt(c.peakPriceScaled)) {
    c.peakPriceScaled = currentPx.clone();
    c.troughAfterPeakScaled = currentPx.clone();
  } else {
    if (currentPx.lt(c.troughAfterPeakScaled)) {
      c.troughAfterPeakScaled = currentPx.clone();
    }
    if (!c.peakPriceScaled.isZero()) {
      const ddBps = c.peakPriceScaled.sub(currentPx)
        .mul(new BN(10000))
        .div(c.peakPriceScaled);
      c.maxDrawdownPct = Math.max(
        c.maxDrawdownPct,
        Number(ddBps.toString(10)) / 100,
      );
    }
  }

  if (e.direction === "BUY" && e.user === TARGET_WALLET) {
    c.targetBoughtEarly = true;
  }

  c.rolling.push({
    atMs: e.observedAtMs,
    user: e.user,
    direction: e.direction,
    quoteLamports: e.quoteLamports.clone(),
    tokenAmount: e.tokenAmount.clone(),
  });

  const previous =
    c.netTokensByUser.get(e.user) ||
    new BN(0);

  if (e.direction === "BUY") {
    c.buyTx += 1;
    c.buyVolumeLamports =
      c.buyVolumeLamports.add(
        e.quoteLamports,
      );
    c.uniqueBuyers.add(e.user);
    c.netTokensByUser.set(
      e.user,
      previous.add(e.tokenAmount),
    );
  } else {
    c.sellTx += 1;
    c.sellVolumeLamports =
      c.sellVolumeLamports.add(
        e.quoteLamports,
      );
    c.uniqueSellers.add(e.user);

    const updated = previous.sub(
      e.tokenAmount,
    );
    c.netTokensByUser.set(
      e.user,
      updated.isNeg()
        ? new BN(0)
        : updated,
    );

    if (
      c.creator &&
      e.user === c.creator
    ) {
      c.creatorSold = true;
    }
  }
}

function readBoolField(
  obj: any,
  names: string[],
): boolean | null {
  for (const name of names) {
    if (typeof obj?.[name] === "boolean") {
      return obj[name];
    }
  }
  return null;
}

function readPublicKeyField(
  obj: any,
  names: string[],
): string | null {
  for (const name of names) {
    const value = obj?.[name];
    if (!value) continue;
    try {
      if (typeof value === "string") {
        return new PublicKey(value).toBase58();
      }
      if (typeof value.toBase58 === "function") {
        return value.toBase58();
      }
    } catch {
      // continue
    }
  }
  return null;
}

async function hydrateCandidate(
  c: Candidate,
): Promise<void> {
  if (c.hydrated || c.hydrationFailed) {
    return;
  }

  try {
    const mint = new PublicKey(c.mint);
    const curveAddress = bondingCurvePda(mint);
    const accountInfo = await connection.getAccountInfo(
      curveAddress,
      "processed",
    );

    if (!accountInfo) {
      c.hydrationFailed = true;
      return;
    }

    const curve =
      PUMP_SDK.decodeBondingCurveNullable(
        accountInfo,
      );

    if (!curve) {
      c.hydrationFailed = true;
      return;
    }

    c.tokenTotalSupply =
      curve.tokenTotalSupply
        ? new BN(
            curve.tokenTotalSupply.toString(),
          )
        : null;

    c.creator = readPublicKeyField(
      curve,
      ["creator", "coinCreator"],
    );

    c.quoteMint = readPublicKeyField(
      curve,
      ["quoteMint", "quote_mint"],
    );

    c.complete = Boolean(
      curve.complete,
    );

    c.mayhem = readBoolField(
      curve,
      [
        "mayhemMode",
        "isMayhemMode",
        "mayhem_mode",
        "is_mayhem_mode",
      ],
    );

    c.holderReward = readBoolField(
      curve,
      [
        "isHolderReward",
        "holderReward",
        "is_holder_reward",
      ],
    );

    // Prefer the account's latest reserves over the event snapshot.
    if (curve.virtualQuoteReserves) {
      c.virtualQuoteReserves = new BN(
        curve.virtualQuoteReserves.toString(),
      );
    } else if (curve.virtualSolReserves) {
      c.virtualQuoteReserves = new BN(
        curve.virtualSolReserves.toString(),
      );
    }

    if (curve.virtualTokenReserves) {
      c.virtualTokenReserves = new BN(
        curve.virtualTokenReserves.toString(),
      );
    }

    if (curve.realQuoteReserves) {
      c.realQuoteReserves = new BN(
        curve.realQuoteReserves.toString(),
      );
    } else if (curve.realSolReserves) {
      c.realQuoteReserves = new BN(
        curve.realSolReserves.toString(),
      );
    }

    if (curve.realTokenReserves) {
      c.realTokenReserves = new BN(
        curve.realTokenReserves.toString(),
      );
    }

    // If we already saw creator SELL events before hydration, recover that
    // signal from the rolling / all-time net flow history as best we can.
    if (c.creator) {
      for (const t of c.rolling) {
        if (
          t.user === c.creator &&
          t.direction === "SELL"
        ) {
          c.creatorSold = true;
          break;
        }
      }
    }

    c.hydrated = true;
  } catch {
    c.hydrationFailed = true;
  }
}

function isSolQuoted(
  c: Candidate,
): boolean {
  // Pump docs use Pubkey::default() for native-SOL-paired legacy/current
  // bonding curves. Accept WSOL too for compatibility with newer interfaces.
  if (!c.quoteMint) return true;
  return (
    c.quoteMint === DEFAULT_PUBKEY ||
    c.quoteMint === WSOL_MINT
  );
}

function prefilterReady(
  c: Candidate,
  now: number,
): boolean {
  const age = now - c.firstSeenAtMs;
  const buySol = lamportsToSol(c.buyVolumeLamports);
  const minAge = FROG_PROFILE ? FROG_MIN_AGE_MS : MIN_AGE_MS;
  const minBuyers = FROG_PROFILE ? FROG_MIN_UNIQUE_BUYERS : MIN_UNIQUE_BUYERS;
  const minVol = FROG_PROFILE ? FROG_MIN_BUY_VOLUME_SOL : MIN_BUY_VOLUME_SOL;

  return (
    age >= Math.min(minAge, 800) &&
    c.uniqueBuyers.size >= Math.max(2, Math.floor(minBuyers / 2)) &&
    buySol >= Math.max(0.10, minVol / 2)
  );
}

interface EntryEvaluation {
  pass: boolean;
  score: number;
  reasons: string[];
  marketCapSol: number | null;
  marketCapUsd: number | null;
  liquiditySol: number;
  momentumPct: number;
  pullbackPct: number;
  reboundPct: number;
  targetConfirmed: boolean;
  topHolderShare: number;
  creatorShare: number;
  sellRatio: number;
}

function evaluateEntry(
  c: Candidate,
  now: number,
): EntryEvaluation {
  const reasons: string[] = [];
  let score = 0;

  const age = now - c.firstSeenAtMs;
  const liquiditySol = lamportsToSol(c.realQuoteReserves);
  const mc = marketCapSol(c);
  const mcUsd = mc != null && solUsd != null ? mc * solUsd : null;
  const momentum = momentumPercent(c);
  const sellRatio = sellVolumeRatio(c);
  const topShare = topObservedHolderShare(c);
  const creatorShare = c.creator ? userShare(c, c.creator) : 0;
  const rolling = rollingMetrics(c, now);
  const pullback = pullbackMetrics(c);

  const minAge = FROG_PROFILE ? FROG_MIN_AGE_MS : MIN_AGE_MS;
  const maxAge = FROG_PROFILE ? FROG_MAX_AGE_MS : MAX_AGE_MS;
  const minBuyers = FROG_PROFILE ? FROG_MIN_UNIQUE_BUYERS : MIN_UNIQUE_BUYERS;
  const minBuyTx = FROG_PROFILE ? FROG_MIN_BUY_TX : MIN_BUY_TX;
  const minBuyVol = FROG_PROFILE ? FROG_MIN_BUY_VOLUME_SOL : MIN_BUY_VOLUME_SOL;
  const maxSellRatio = FROG_PROFILE ? FROG_MAX_SELL_VOLUME_RATIO : MAX_SELL_VOLUME_RATIO;
  const minLiq = FROG_PROFILE ? FROG_MIN_REAL_SOL_RESERVE : MIN_REAL_SOL_RESERVE;
  const maxLiq = FROG_PROFILE ? FROG_MAX_REAL_SOL_RESERVE : MAX_REAL_SOL_RESERVE;
  const maxTop = FROG_PROFILE ? FROG_MAX_TOP_HOLDER_SHARE : MAX_TOP_HOLDER_SHARE;
  const maxCreator = FROG_PROFILE ? FROG_MAX_CREATOR_SHARE : MAX_CREATOR_SHARE;
  const minScore = FROG_PROFILE ? FROG_MIN_ENTRY_SCORE : MIN_ENTRY_SCORE;

  if (NEW_TOKENS_ONLY && c.createdAtMs == null) reasons.push("not-new-create-event");
  if (age < minAge) reasons.push("too-young");
  if (age > maxAge) reasons.push("too-old");
  if (c.complete) reasons.push("curve-complete");
  if (!isSolQuoted(c)) reasons.push("not-SOL-paired");
  if (REJECT_MAYHEM && c.mayhem === true) reasons.push("mayhem");
  if (REJECT_HOLDER_REWARD && c.holderReward === true) reasons.push("holder-reward");

  if (c.uniqueBuyers.size < minBuyers) reasons.push("few-buyers"); else score += 18;
  if (c.buyTx < minBuyTx) reasons.push("few-buy-tx"); else score += 10;

  const buyVol = lamportsToSol(c.buyVolumeLamports);
  if (buyVol < minBuyVol) reasons.push("low-buy-volume");
  else score += buyVol >= minBuyVol * 2 ? 16 : 11;

  if (sellRatio > maxSellRatio) reasons.push("sell-pressure");
  else score += sellRatio <= 0.12 ? 14 : 9;

  if (liquiditySol < minLiq || liquiditySol > maxLiq) reasons.push("liquidity-range");
  else score += 8;

  if (FROG_PROFILE) {
    if (mcUsd == null || mcUsd < FROG_MIN_MARKET_CAP_USD || mcUsd > FROG_MAX_MARKET_CAP_USD) {
      reasons.push("frog-market-cap-usd");
    } else score += 12;
  } else if (mc == null || mc < MIN_MARKET_CAP_SOL || mc > MAX_MARKET_CAP_SOL) {
    reasons.push("market-cap-range");
  } else score += 10;

  // Keep only plausible early momentum. For the Frog profile the recovery gate
  // is more informative than requiring a large already-completed pump.
  if (!FROG_PROFILE && (momentum < MIN_MOMENTUM_PERCENT || momentum > MAX_MOMENTUM_PERCENT)) {
    reasons.push("momentum-range");
  } else if (FROG_PROFILE && momentum > 55) {
    reasons.push("already-overextended");
  } else score += 8;

  if (topShare > maxTop) reasons.push("top-holder-concentration"); else score += 8;
  if (c.creator && creatorShare > maxCreator) reasons.push("creator-concentration"); else score += 6;
  if (c.creatorSold) reasons.push("creator-sold"); else score += 4;

  // Big early dump = permanent danger signal. Small pullback + rebound is allowed.
  if (c.maxDrawdownPct >= CRASH_REJECT_PERCENT ||
      (pullback.drawdownPct >= PULLBACK_MAX_PERCENT && sellRatio >= CRASH_SELL_RATIO)) {
    reasons.push("crash-pattern");
  }

  if (REQUIRE_PULLBACK_RECOVERY) {
    if (c.maxDrawdownPct < PULLBACK_MIN_PERCENT) reasons.push("no-pullback-yet");
    if (c.maxDrawdownPct > PULLBACK_MAX_PERCENT) reasons.push("pullback-too-deep");
    if (pullback.reboundPct < RECOVERY_MIN_PERCENT) reasons.push("no-recovery-confirmation");
  }

  // Recent flow must confirm the bounce: at least 2 distinct buyers and buy SOL
  // above sell SOL in the rolling window.
  if (rolling.buyTx < 2 || rolling.uniqueBuyers < 2 || rolling.buySol <= rolling.sellSol) {
    reasons.push("weak-recent-flow");
  } else score += 10;

  if (c.targetBoughtEarly) score += TARGET_CONFIRMATION_BONUS;
  if (score < minScore) reasons.push("score");

  return {
    pass: reasons.length === 0,
    score,
    reasons,
    marketCapSol: mc,
    marketCapUsd: mcUsd,
    liquiditySol,
    momentumPct: momentum,
    pullbackPct: c.maxDrawdownPct,
    reboundPct: pullback.reboundPct,
    targetConfirmed: c.targetBoughtEarly,
    topHolderShare: topShare,
    creatorShare,
    sellRatio,
  };
}

// ============================================================
// PAPER POSITION MANAGEMENT
// ============================================================

function appendPaperLog(
  payload: Record<string, unknown>,
): void {
  fs.appendFileSync(
    PAPER_LOG,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      ...payload,
    })}\n`,
  );
}

function currentPaperNetValueSol(
  c: Candidate,
  p: PaperPosition,
): number {
  return paperSellSol(
    c.virtualQuoteReserves,
    c.virtualTokenReserves,
    p.tokenAmount,
  );
}

function pnlPct(
  p: PaperPosition,
  netValueSol: number,
): number {
  if (p.entryCostSol <= 0) return 0;
  return (
    (netValueSol - p.entryCostSol) /
    p.entryCostSol
  ) * 100;
}

function openPaperPosition(
  c: Candidate,
  e: EntryEvaluation,
  triggerSignature: string,
): void {
  if (
    positions.size >= MAX_OPEN_POSITIONS ||
    positions.has(c.mint) ||
    c.entered
  ) {
    return;
  }

  const tokenAmount = paperBuyTokenAmount(
    c.virtualQuoteReserves,
    c.virtualTokenReserves,
    BUY_SOL,
  );

  if (tokenAmount.isZero()) return;

  const entryCostSol = BUY_SOL + TX_COST_SOL;
  const immediateNet = paperSellSol(
    c.virtualQuoteReserves,
    c.virtualTokenReserves,
    tokenAmount,
  );

  const p: PaperPosition = {
    mint: c.mint,
    openedAtMs: Date.now(),
    tokenAmount,
    buySol: BUY_SOL,
    entryCostSol,
    entryMarketCapSol:
      e.marketCapSol || 0,
    entryLiquiditySol:
      e.liquiditySol,
    entryScore: e.score,
    peakNetValueSol: immediateNet,
    peakPnlPct: pnlPct(
      {
        mint: c.mint,
        openedAtMs: Date.now(),
        tokenAmount,
        buySol: BUY_SOL,
        entryCostSol,
        entryMarketCapSol:
          e.marketCapSol || 0,
        entryLiquiditySol:
          e.liquiditySol,
        entryScore: e.score,
        peakNetValueSol: immediateNet,
        peakPnlPct: 0,
        trailingArmed: false,
        entrySignature: triggerSignature,
      },
      immediateNet,
    ),
    trailingArmed: false,
    entrySignature: triggerSignature,
  };

  c.entered = true;
  positions.set(c.mint, p);

  const mcUsd = e.marketCapUsd;

  console.log("\n============================================================");
  console.log("PAPER SNIPER ENTRY");
  console.log(`Mint: ${c.mint}`);
  console.log(`Score: ${e.score}`);
  console.log(
    `Market cap: ${e.marketCapSol?.toFixed(2)} SOL${
      mcUsd != null
        ? ` (~$${mcUsd.toFixed(0)})`
        : ""
    }`,
  );
  console.log(
    `Curve SOL reserve: ${e.liquiditySol.toFixed(2)} SOL`,
  );
  console.log(
    `Unique buyers: ${c.uniqueBuyers.size} | buys=${c.buyTx} sells=${c.sellTx}`,
  );
  console.log(
    `Momentum: ${pct(e.momentumPct)} | pullback=${pct(e.pullbackPct)} | rebound=${pct(e.reboundPct)}`,
  );
  console.log(
    `Sell ratio=${pct(e.sellRatio * 100)} | target confirmation=${e.targetConfirmed ? "YES" : "no"}`,
  );
  console.log(
    `Top observed holder: ${pct(e.topHolderShare * 100)} | creator=${pct(e.creatorShare * 100)}`,
  );
  console.log(
    `Simulated buy: ${formatSol(BUY_SOL)} (NO REAL TX)`,
  );
  console.log("============================================================\n");

  appendPaperLog({
    type: "ENTRY",
    mint: c.mint,
    score: e.score,
    marketCapSol: e.marketCapSol,
    marketCapUsd: mcUsd,
    liquiditySol: e.liquiditySol,
    uniqueBuyers: c.uniqueBuyers.size,
    buyTx: c.buyTx,
    sellTx: c.sellTx,
    buyVolumeSol: lamportsToSol(
      c.buyVolumeLamports,
    ),
    sellVolumeSol: lamportsToSol(
      c.sellVolumeLamports,
    ),
    momentumPct: e.momentumPct,
    pullbackPct: e.pullbackPct,
    reboundPct: e.reboundPct,
    targetConfirmed: e.targetConfirmed,
    topHolderShare: e.topHolderShare,
    creatorShare: e.creatorShare,
    buySol: BUY_SOL,
    entryCostSol,
    tokenAmountRaw: tokenAmount.toString(10),
    triggerSignature,
  });
}

function closePaperPosition(
  c: Candidate,
  p: PaperPosition,
  reason: string,
  signature: string,
): void {
  const net = currentPaperNetValueSol(c, p);
  const pnlSol = net - p.entryCostSol;
  const pPct = pnlPct(p, net);

  positions.delete(c.mint);

  stats.closed += 1;
  stats.grossPnlSol += pnlSol;
  if (pnlSol > 0) stats.wins += 1;
  else stats.losses += 1;
  stats.bestPct = Math.max(
    stats.bestPct,
    pPct,
  );
  stats.worstPct = Math.min(
    stats.worstPct,
    pPct,
  );

  console.log("\n------------------------------------------------------------");
  console.log("PAPER SNIPER EXIT");
  console.log(`Mint: ${c.mint}`);
  console.log(`Reason: ${reason}`);
  console.log(
    `Entry cost: ${formatSol(p.entryCostSol)} | Exit net: ${formatSol(net)}`,
  );
  console.log(
    `P/L: ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(6)} SOL (${pPct >= 0 ? "+" : ""}${pPct.toFixed(2)}%)`,
  );
  console.log(
    `Paper total: ${stats.grossPnlSol >= 0 ? "+" : ""}${stats.grossPnlSol.toFixed(6)} SOL | ${stats.wins}W/${stats.losses}L`,
  );
  console.log("------------------------------------------------------------\n");

  appendPaperLog({
    type: "EXIT",
    mint: c.mint,
    reason,
    holdMs: Date.now() - p.openedAtMs,
    entryCostSol: p.entryCostSol,
    exitNetSol: net,
    pnlSol,
    pnlPct: pPct,
    peakPnlPct: p.peakPnlPct,
    exitSignature: signature,
    stats: { ...stats },
  });
}

function evaluateOpenPosition(
  c: Candidate,
  signature: string,
): void {
  const p = positions.get(c.mint);
  if (!p) return;

  const now = Date.now();
  const net = currentPaperNetValueSol(c, p);
  const pPct = pnlPct(p, net);

  if (net > p.peakNetValueSol) {
    p.peakNetValueSol = net;
    p.peakPnlPct = pPct;
  }

  if (
    !p.trailingArmed &&
    pPct >= TRAILING_ACTIVATE_PERCENT
  ) {
    p.trailingArmed = true;
  }

  // Safety first: creator selling after our entry is an immediate exit signal.
  if (c.creatorSold) {
    closePaperPosition(
      c,
      p,
      "CREATOR_SELL",
      signature,
    );
    return;
  }

  if (pPct >= TAKE_PROFIT_PERCENT) {
    closePaperPosition(
      c,
      p,
      "TAKE_PROFIT",
      signature,
    );
    return;
  }

  if (pPct <= -STOP_LOSS_PERCENT) {
    closePaperPosition(
      c,
      p,
      "STOP_LOSS",
      signature,
    );
    return;
  }

  if (p.trailingArmed) {
    const peak = p.peakNetValueSol;
    const drawdownPct = peak > 0
      ? ((peak - net) / peak) * 100
      : 0;

    if (drawdownPct >= TRAILING_PERCENT) {
      closePaperPosition(
        c,
        p,
        "TRAILING_STOP",
        signature,
      );
      return;
    }
  }

  if (now - p.openedAtMs >= MAX_HOLD_MS) {
    closePaperPosition(
      c,
      p,
      "TIME_EXIT",
      signature,
    );
  }
}

// ============================================================
// MAIN EVENT HANDLER
// ============================================================

async function handleTradeEvent(
  e: PumpTradeEvent,
): Promise<void> {
  eventCount += 1;

  const creation = createdMints.get(e.mint) || null;
  if (NEW_TOKENS_ONLY && !creation) {
    return;
  }

  let c = candidates.get(e.mint);
  if (!c) {
    c = createCandidate(e, creation);
    candidates.set(e.mint, c);
  }

  applyTrade(c, e);

  // Existing paper positions are evaluated on every new on-chain trade,
  // giving us event-driven exits without polling delays.
  evaluateOpenPosition(
    c,
    e.signature,
  );

  if (
    positions.has(c.mint) ||
    c.entered ||
    c.rejectedPermanent
  ) {
    pruneCandidates();
    maybePrintStatus();
    return;
  }

  const now = e.observedAtMs;
  const age = now - c.firstSeenAtMs;

  const effectiveMaxAge = FROG_PROFILE ? FROG_MAX_AGE_MS : MAX_AGE_MS;
  if (age > effectiveMaxAge) {
    c.rejectedPermanent = true;
    c.lastRejectReason = "too-old";
    filteredCount += 1;
    pruneCandidates();
    maybePrintStatus();
    return;
  }

  if (
    !c.hydrated &&
    !c.hydrationFailed &&
    prefilterReady(c, now)
  ) {
    await hydrateCandidate(c);
  }

  if (!c.hydrated) {
    pruneCandidates();
    maybePrintStatus();
    return;
  }

  const evaluation = evaluateEntry(c, now);
  c.lastRejectReason =
    evaluation.reasons.join(",");

  if (evaluation.pass) {
    openPaperPosition(
      c,
      evaluation,
      e.signature,
    );
  }

  pruneCandidates();
  maybePrintStatus();
}

function pruneCandidates(): void {
  if (candidates.size <= MAX_TRACKED_CANDIDATES) {
    return;
  }

  const removable = [...candidates.values()]
    .filter(
      c => !positions.has(c.mint),
    )
    .sort(
      (a, b) =>
        a.lastSeenAtMs - b.lastSeenAtMs,
    );

  const removeCount =
    candidates.size - MAX_TRACKED_CANDIDATES;

  for (
    let i = 0;
    i < removeCount && i < removable.length;
    i += 1
  ) {
    candidates.delete(removable[i].mint);
  }
}

function maybePrintStatus(): void {
  const now = Date.now();
  if (now - lastStatusAt < STATUS_EVERY_MS) {
    return;
  }
  lastStatusAt = now;

  const winRate = stats.closed > 0
    ? (stats.wins / stats.closed) * 100
    : 0;

  console.log(
    `[STATUS] events=${eventCount} candidates=${candidateCount} tracked=${candidates.size} open=${positions.size} closed=${stats.closed} winRate=${winRate.toFixed(1)}% pnl=${stats.grossPnlSol >= 0 ? "+" : ""}${stats.grossPnlSol.toFixed(5)} SOL`,
  );
}

// ============================================================
// SOL/USD (DISPLAY ONLY)
// ============================================================

async function refreshSolUsd(): Promise<void> {
  const now = Date.now();
  if (
    solUsd != null &&
    now - solUsdUpdatedAtMs < SOL_USD_REFRESH_MS
  ) {
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      1200,
    );

    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: controller.signal },
    );
    clearTimeout(timeout);

    if (!response.ok) return;
    const data = await response.json();
    const price = Number(data?.solana?.usd);
    if (Number.isFinite(price) && price > 0) {
      solUsd = price;
      solUsdUpdatedAtMs = now;
    }
  } catch {
    // Display-only. Never stop the scanner because price lookup failed.
  }
}

// ============================================================
// STARTUP
// ============================================================

function printConfig(): void {
  console.log("\n============================================================");
  console.log("            PUMP.FUN MR. FROG PROFILE SNIPER - PAPER MODE");
  console.log("============================================================");
  console.log(`RPC: ${RPC_URL.replace(/api-key=[^&]+/i, "api-key=[hidden]")}`);
  console.log(`PAPER ONLY: ${SNIPER_PAPER_ONLY}`);
  console.log(`BUY: ${BUY_SOL} SOL`);
  console.log(`Age window: ${MIN_AGE_MS}-${MAX_AGE_MS} ms`);
  console.log(`Unique buyers >= ${MIN_UNIQUE_BUYERS}`);
  console.log(`Buy tx >= ${MIN_BUY_TX}`);
  console.log(`Buy volume >= ${MIN_BUY_VOLUME_SOL} SOL`);
  console.log(`Sell-volume ratio <= ${(MAX_SELL_VOLUME_RATIO * 100).toFixed(1)}%`);
  console.log(`Curve SOL reserve: ${MIN_REAL_SOL_RESERVE}-${MAX_REAL_SOL_RESERVE} SOL`);
  console.log(`Market cap: ${MIN_MARKET_CAP_SOL}-${MAX_MARKET_CAP_SOL} SOL`);
  console.log(`Momentum: ${MIN_MOMENTUM_PERCENT}-${MAX_MOMENTUM_PERCENT}%`);
  console.log(`Top observed holder <= ${(MAX_TOP_HOLDER_SHARE * 100).toFixed(1)}%`);
  console.log(`Creator observed share <= ${(MAX_CREATOR_SHARE * 100).toFixed(1)}%`);
  console.log(`Entry score >= ${MIN_ENTRY_SCORE}`);
  console.log(`TP ${TAKE_PROFIT_PERCENT}% | trail activates ${TRAILING_ACTIVATE_PERCENT}% / trails ${TRAILING_PERCENT}% | SL ${STOP_LOSS_PERCENT}% | max hold ${MAX_HOLD_MS / 1000}s`);
  console.log(`New tokens only: ${NEW_TOKENS_ONLY}`);
  console.log(`Frog profile: ${FROG_PROFILE} | target=${TARGET_WALLET.slice(0, 8)}...`);
  if (FROG_PROFILE) {
    console.log(`Frog MC window: $${FROG_MIN_MARKET_CAP_USD}-$${FROG_MAX_MARKET_CAP_USD}`);
    console.log(`Pullback/recovery: ${PULLBACK_MIN_PERCENT}-${PULLBACK_MAX_PERCENT}% dip, >=${RECOVERY_MIN_PERCENT}% rebound; crash >=${CRASH_REJECT_PERCENT}% rejected`);
  }
  console.log(`Paper log: ${PAPER_LOG}`);
  console.log("============================================================\n");
}

async function main(): Promise<void> {
  printConfig();

  const slot = await connection.getSlot(
    "processed",
  );
  console.log(`[OK] RPC slot ${slot}`);

  await refreshSolUsd();
  if (solUsd) {
    console.log(`[OK] SOL/USD display price ~$${solUsd.toFixed(2)}`);
  }

  setInterval(
    () => {
      void refreshSolUsd();
    },
    SOL_USD_REFRESH_MS,
  ).unref();

  const subscriptionId = connection.onLogs(
    PUMP_PROGRAM_ID,
    (logInfo: Logs) => {
      if (logInfo.err) return;

      const observedAtMs = Date.now();

      const creates = decodePumpCreateEvents(
        logInfo.logs,
        logInfo.signature,
        observedAtMs,
      );
      for (const created of creates) {
        createdMints.set(created.mint, created);
        console.log(
          `[NEW] ${created.mint} creator=${created.creator.slice(0, 6)}... mayhem=${created.mayhem}`,
        );
      }

      const events = decodePumpTradeEvents(
        logInfo.logs,
        logInfo.signature,
        observedAtMs,
      );

      for (const event of events) {
        void handleTradeEvent(event).catch(
          error => {
            console.error(
              "TradeEvent handler error:",
              error,
            );
          },
        );
      }
    },
    "processed",
  );

  console.log(
    `[OK] Watching Pump.fun CreateEvent + TradeEvent. Subscription ${subscriptionId}.`,
  );
  console.log(
    "[SAFE] No real trades can be sent by this file. Let it collect paper statistics first.\n",
  );
}

process.on("SIGINT", () => {
  const winRate = stats.closed > 0
    ? (stats.wins / stats.closed) * 100
    : 0;

  console.log("\nFINAL PAPER SUMMARY");
  console.log(`Closed: ${stats.closed}`);
  console.log(`Wins/Losses: ${stats.wins}/${stats.losses}`);
  console.log(`Win rate: ${winRate.toFixed(1)}%`);
  console.log(`Net paper P/L: ${stats.grossPnlSol.toFixed(6)} SOL`);
  process.exit(0);
});

main().catch(error => {
  console.error("FATAL:", error);
  process.exit(1);
});
