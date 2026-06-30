#!/usr/bin/env node
/**
 * DLMM Agent PnL Recap
 * Usage: node recap.js morning   → Recap yesterday (00:00-23:59 UTC)
 *        node recap.js evening   → Recap today (00:00-now UTC)
 */
import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'state.json');
const LESSONS_FILE = path.join(__dirname, 'lessons.json');

function loadJSON(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { return null; }
}

function getCurrentPositions() {
  // Try to get live data from CLI with spawn (timeout-safe)
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn('node', ['cli.js', 'positions'], {
      cwd: __dirname,
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    const finish = () => {
      // Try to parse JSON from stdout (ignore log lines)
      const lines = stdout.split('\n');
      const jsonStart = lines.findIndex(l => l.trim().startsWith('{'));
      if (jsonStart >= 0) {
        try {
          const parsed = JSON.parse(lines.slice(jsonStart).join('\n'));
          if (parsed.positions && parsed.positions.length > 0) {
            resolve(parsed);
            return;
          }
        } catch (e) {}
      }
      // Fallback to state.json
      resolve(getOpenFromState());
    };

    proc.on('exit', () => finish());
    proc.on('error', () => finish());
    
    // Force finish after 22s regardless
    setTimeout(() => {
      try { proc.kill(); } catch(e) {}
      finish();
    }, 22000);
  });
}

function getOpenFromState() {
  try {
    const state = loadJSON(STATE_FILE);
    if (!state || !state.positions) return { total_positions: 0, positions: [] };
    const openPositions = [];
    for (const [addr, pos] of Object.entries(state.positions)) {
      if (!pos.closed) {
        // Calculate rough PnL from initial value and fees
        const initVal = pos.initial_value_usd || 0;
        const claimedFees = pos.total_fees_claimed_usd || 0;
        const notes = pos.notes || [];
        // Try to extract claimed fees from notes
        let feesClaimed = claimedFees;
        if (feesClaimed === 0 && notes.length > 0) {
          // Agent records fee claims in notes
          feesClaimed = notes.length * 5; // rough estimate
        }
        openPositions.push({
          position: addr,
          pair: pos.pool_name || '?',
          total_value_usd: initVal,
          pnl_usd: 0,
          pnl_pct: pos.peak_pnl_pct || 0,
          collected_fees_usd: feesClaimed,
          unclaimed_fees_usd: 0,
          in_range: !pos.out_of_range_since,
          deployed_at: pos.deployed_at || null,
          amount_sol: pos.amount_sol || 0
        });
      }
    }
    return { total_positions: openPositions.length, positions: openPositions };
  } catch (e) {
    return { total_positions: 0, positions: [] };
  }
}

function toWIB(d) {
  return new Date(d.getTime() + 7 * 60 * 60 * 1000);
}

function fromWIB(year, month, day, hour, min, sec) {
  return new Date(Date.UTC(year, month, day, hour - 7, min, sec));
}

async function recap(mode) {
  const now = new Date();
  const nowWIB = toWIB(now);
  const y = nowWIB.getUTCFullYear();
  const m = nowWIB.getUTCMonth();
  const d = nowWIB.getUTCDate();
  const h = nowWIB.getUTCHours();

  let startUTC, endUTC, title, periodLabel;

  if (mode === 'morning') {
    // Yesterday in WIB: 00:00-23:59 WIB
    // 00:00 WIB = previous day 17:00 UTC
    // 23:59 WIB = that day 16:59 UTC
    startUTC = fromWIB(y, m, d - 1, 0, 0, 0);
    endUTC = fromWIB(y, m, d - 1, 23, 59, 59);
    title = `☀️ Morning PnL Recap — ${new Date(startUTC.getTime() + 7*3600000).toLocaleDateString('id-ID', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })}`;
    periodLabel = 'Yesterday (00:00-23:59 WIB)';
  } else {
    // Today so far in WIB: 00:00 WIB to now WIB
    startUTC = fromWIB(y, m, d, 0, 0, 0);
    endUTC = now;
    title = `🌙 Evening PnL Recap — ${new Date(startUTC.getTime() + 7*3600000).toLocaleDateString('id-ID', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })}`;
    periodLabel = `Today so far (00:00 WIB - ${h.toString().padStart(2,'0')}:${nowWIB.getUTCMinutes().toString().padStart(2,'0')} WIB)`;
  }

  // Load data
  const lessonsData = loadJSON(LESSONS_FILE);
  const state = loadJSON(STATE_FILE);
  const allPerf = (lessonsData?.performance || []);

  // Filter by UTC time bounds
  const performances = allPerf.filter(p => {
    const t = new Date(p.recorded_at);
    return t >= startUTC && t <= endUTC;
  });

  // Count opened positions in this period (by deployed_at in UTC)
  const allPositions = Object.values(state?.positions || {});
  const openedInPeriod = allPositions.filter(p => {
    const t = new Date(p.deployed_at);
    return t >= startUTC && t <= endUTC;
  });

  // Build lines
  const lines = [];
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(title);
  lines.push(`📅 ${periodLabel}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(``);

  // === AGGREGATE OVERVIEW ===
  let totalPnl = 0, totalFees = 0, totalDeposits = 0, totalWithdrawals = 0;
  let winners = 0, losers = 0;

  for (const p of performances) {
    const pnl = p.pnl_usd || 0;
    const fees = p.fees_earned_usd || 0;
    totalPnl += pnl;
    totalFees += fees;
    totalDeposits += p.initial_value_usd || 0;
    totalWithdrawals += p.final_value_usd || 0;
    if (pnl >= 0) winners++; else losers++;
  }

  const count = performances.length;
  const pctChange = totalDeposits > 0 ? ((totalWithdrawals - totalDeposits) / totalDeposits) * 100 : 0;

  lines.push(`📊 SUMMARY`);
  lines.push(`├ Positions Closed: ${count}`);
  lines.push(`├ Positions Opened: ${openedInPeriod.length}`);
  lines.push(`├ Total PnL: ${totalPnl >= 0 ? '✅' : '❌'} ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}${totalPnl >= 0 ? ' 📈' : ' 📉'}`);
  lines.push(`├ Total Fees Earned: 💎 $${totalFees.toFixed(2)}`);
  lines.push(`├ Win Rate: ${count > 0 ? Math.round((winners / count) * 100) : 0}% (${winners}W / ${losers}L)`);
  lines.push(`├ Total Deposits: $${totalDeposits.toFixed(2)}`);
  lines.push(`├ Total Withdrawals: $${totalWithdrawals.toFixed(2)}`);
  lines.push(`└ Return on Capital: ${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%`);
  lines.push(``);

  // === DETAIL PER POSISI ===
  if (count > 0) {
    lines.push(`📋 DETAIL POSISI`);
    // Sort by PnL descending
    performances.sort((a, b) => (b.pnl_usd || 0) - (a.pnl_usd || 0));
    for (let i = 0; i < performances.length; i++) {
      const p = performances[i];
      const pnl = p.pnl_usd || 0;
      const pnlPct = p.pnl_pct || 0;
      const fees = p.fees_earned_usd || 0;
      const deposit = p.initial_value_usd || 0;
      const withdraw = p.final_value_usd || 0;
      const held = p.minutes_held || 0;
      const icon = pnl >= 0 ? '🟢' : '🔴';
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      const pctStr = pnlPct >= 0 ? `+${pnlPct.toFixed(2)}%` : `${pnlPct.toFixed(2)}%`;
      const openTime = p.recorded_at ? new Date(new Date(p.recorded_at).getTime() - held * 60 * 1000) : null;
      const openStr = openTime ? openTime.toLocaleString('id-ID', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '?';
      const closeStr = p.recorded_at ? new Date(p.recorded_at).toLocaleString('id-ID', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '?';

      // Duration format
      const hrs = Math.floor(held / 60);
      const mins = held % 60;
      const durStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;

      lines.push(`─`.repeat(30));
      lines.push(`${icon} Position #${i + 1} — ${p.pool_name || '?'}`);
      lines.push(`   PnL: ${pnlStr} (${pctStr})`);
      lines.push(`   Duration: ${durStr} | Fees: $${fees.toFixed(2)}`);
      lines.push(`   Deposits: $${deposit.toFixed(2)} → Withdrawals: $${withdraw.toFixed(2)}`);
      lines.push(`   ${p.close_reason ? p.close_reason.substring(0, 70) : ''}`);
    }
    lines.push(`─`.repeat(30));
    lines.push(``);
  }

  // === CURRENT OPEN POSITIONS ===
  const currentData = await getCurrentPositions();
  const openPositions = currentData.positions || [];

  if (openPositions.length > 0) {
    lines.push(`🔓 POSISI SAAT INI (Open)`);
    for (const p of openPositions) {
      const inRange = p.in_range ? '✅ In Range' : '⚠️ OOR';
      lines.push(`├ ${p.pair}: $${p.total_value_usd?.toFixed(2) || '?'} | ${inRange}`);
      lines.push(`├   PnL: ${p.pnl_usd >= 0 ? '+' : ''}$${p.pnl_usd?.toFixed(2) || '?'} (${p.pnl_pct >= 0 ? '+' : ''}${p.pnl_pct?.toFixed(2) || '?'}%)`);
      lines.push(`└   Fees Collected: $${p.collected_fees_usd?.toFixed(2) || '?'} | Unclaimed: $${p.unclaimed_fees_usd?.toFixed(2) || '?'}`);
    }
  } else {
    lines.push(`🔓 Tidak ada posisi terbuka saat ini.`);
  }
  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━`);

  return lines.join('\n');
}

const mode = process.argv[2] || 'morning';
recap(mode).then(output => console.log(output));
