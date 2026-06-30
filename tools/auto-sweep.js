#!/usr/bin/env node
/**
 * Auto-Sweep SOL → USDC
 *
 * Logic:
 *  1. Skip if autoSweepSolToUsdc === false
 *  2. Skip if today (WIB) already swept → autoSweepSolToUsdc-state.json lastSweepDate
 *  3. Get wallet SOL balance via Helius
 *  4. If balance <= capitalSol → skip (might increase later when position closes)
 *  5. If open positions in state.json → skip, retry next cron tick
 *  6. Swap excess (balance - capitalSol) → USDC via Jupiter
 *  7. On success, mark today as swept
 *
 * Runs via cron every 15 min. Self-gating — no action until conditions met.
 */

import "dotenv/config";
import fs from "fs";
import { swapToken, getWalletBalances } from "./wallet.js";

const SWEEP_STATE_PATH = new URL("../autoSweepSolToUsdc-state.json", import.meta.url).pathname;
const USER_CONFIG_PATH  = new URL("../user-config.json", import.meta.url).pathname;
const STATE_PATH        = new URL("../state.json", import.meta.url).pathname;

function readJson(path) {
  try {
    if (!fs.existsSync(path)) return {};
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/** Get current date in WIB (UTC+7) as YYYY-MM-DD */
function getTodayWIB() {
  const now = new Date();
  const wibMs = now.getTime() + 7 * 60 * 60 * 1000;
  return new Date(wibMs).toISOString().slice(0, 10);
}

async function main() {
  // ── 1. Load config ──────────────────────────────────────────────
  const userConfig = readJson(USER_CONFIG_PATH);

  if (userConfig.autoSweepSolToUsdc === false) {
    console.log("[sweep] Disabled (autoSweepSolToUsdc=false)");
    process.exit(0);
  }

  const capitalSol = userConfig.capitalSol ?? 15;
  const today = getTodayWIB();

  // ── 2. Already swept today? ─────────────────────────────────────
  const sweepState = readJson(SWEEP_STATE_PATH);
  if (sweepState.lastSweepDate === today) {
    console.log(`[sweep] Already swept today (${today})`);
    process.exit(0);
  }

  // ── 3. Get wallet balance ───────────────────────────────────────
  const balances = await getWalletBalances();
  if (balances.error) {
    console.error(`[sweep] Balance fetch error: ${balances.error}`);
    process.exit(1);
  }

  const balanceSol = balances.sol ?? 0;
  console.log(`[sweep] Balance: ${balanceSol.toFixed(4)} SOL | Capital: ${capitalSol} SOL`);

  // ── 4. Balance check ────────────────────────────────────────────
  if (balanceSol <= capitalSol + 0.005) {
    console.log(`[sweep] Balance ${balanceSol.toFixed(4)} ≤ capital ${capitalSol} — no excess`);
    process.exit(0);
  }

  // ── 5. Open positions check ─────────────────────────────────────
  const state = readJson(STATE_PATH);
  const positions = state.positions || {};
  const openPositions = Object.values(positions).filter((p) => !p.closed);

  if (openPositions.length > 0) {
    console.log(`[sweep] ${openPositions.length} open position(s) — waiting for close`);
    for (const p of openPositions) {
      console.log(`  - ${p.pool_name || "?"}: ${p.amount_sol || "?"} SOL`);
    }
    process.exit(0);
  }

  // ── 6. Calculate & swap excess ──────────────────────────────────
  const excessSol = parseFloat((balanceSol - capitalSol).toFixed(4));
  if (excessSol < 0.01) {
    console.log(`[sweep] Excess ${excessSol} SOL too small — skip`);
    process.exit(0);
  }

  console.log(`[sweep] Swapping ${excessSol} SOL → USDC ...`);
  const result = await swapToken({
    input_mint: "SOL",
    output_mint: "USDC",
    amount: excessSol,
  });

  if (!result.success) {
    console.error(`[sweep] SWAP FAILED: ${result.error}`);
    process.exit(1);
  }

  // ── 7. Success ──────────────────────────────────────────────────
  console.log(`[sweep] SUCCESS! Tx: ${result.tx}`);
  console.log(`[sweep] Received ${result.amount_out} USDC`);

  writeJson(SWEEP_STATE_PATH, {
    lastSweepDate: today,
    lastSweepAt: new Date().toISOString(),
    lastSweepAmountSol: excessSol,
    lastSweepAmountUsdc: result.amount_out ?? 0,
    lastSweepTx: result.tx,
  });

  console.log(`[sweep] Marked ${today} as swept ✅`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[sweep] Unhandled: ${err.message}`);
  process.exit(1);
});
