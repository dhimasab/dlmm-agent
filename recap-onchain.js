#!/usr/bin/env node
/**
 * On-Chain Recap — Closed Positions via Meteora PnL API
 * 
 * CLI:
 *   node recap-onchain.js today      ← 00:00 WIB → now
 *   node recap-onchain.js yesterday   ← yesterday full day WIB
 *   node recap-onchain.js             ← default: today
 */
import fs from 'fs';

const STATE_FILE = '/home/ubuntu/meridianagent/state.json';
const WALLET = '4KEwHasqDmUzxj6QorqY9GFsC5txDuCnnZ495LQgwQus';

function toWIB(d) { return new Date(d.getTime() + 7 * 60 * 60 * 1000); }
function fromWIB(year, month, day, hour, min, sec) {
  return new Date(Date.UTC(year, month, day, hour - 7, min, sec));
}

function getPeriod(mode) {
  const now = new Date();
  const wib = toWIB(now);
  const y = wib.getUTCFullYear();
  const m = wib.getUTCMonth();
  const d = wib.getUTCDate();
  if (mode === 'today') {
    return { startUTC: fromWIB(y, m, d, 0, 0, 0), endUTC: now, label: `Today (00:00 - ${String(wib.getUTCHours()).padStart(2,'0')}:${String(wib.getUTCMinutes()).padStart(2,'0')} WIB)` };
  } else {
    return { startUTC: fromWIB(y, m, d-1, 0, 0, 0), endUTC: fromWIB(y, m, d-1, 23, 59, 59), label: 'Yesterday (00:00-23:59 WIB)' };
  }
}

async function queryPoolPnL(poolAddress) {
  const res = await fetch(`https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${WALLET}&pageSize=100&page=1`);
  if (!res.ok) return [];
  return (await res.json()).positions || [];
}

export async function generateRecap(mode) {
  const period = getPeriod(mode);
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const allPositions = Object.values(state.positions || {});
  const poolSet = new Set();
  const positionMap = {};
  for (const pos of allPositions) {
    if (!pos.closed || !pos.closed_at) continue;
    const t = new Date(pos.closed_at);
    if (t >= period.startUTC && t <= period.endUTC) {
      poolSet.add(pos.pool);
      positionMap[pos.position] = { pool: pos.pool, name: pos.pool_name };
    }
  }
  const sortedPools = [...poolSet].sort();
  const allOnChain = [];
  for (const poolAddr of sortedPools) {
    const onChainPositions = await queryPoolPnL(poolAddr);
    for (const oc of onChainPositions) {
      const addr = oc.positionAddress;
      if (!addr || !oc.isClosed) continue;
      const info = positionMap[addr];
      if (!info) continue;
      const closedAt = new Date(oc.closedAt * 1000);
      if (closedAt < period.startUTC || closedAt > period.endUTC) continue;
      allOnChain.push({
        name: info.name, position: addr, closedAt,
        pnlUsd: parseFloat(oc.pnlUsd || '0'), pnlPct: parseFloat(oc.pnlPctChange || '0'),
        deposit: parseFloat(oc.allTimeDeposits?.total?.usd || '0'),
        withdraw: parseFloat(oc.allTimeWithdrawals?.total?.usd || '0'),
        fees: parseFloat(oc.allTimeFees?.total?.usd || '0'),
        durationMin: Math.round((oc.closedAt - oc.createdAt) / 60),
      });
    }
  }
  allOnChain.sort((a, b) => b.closedAt - a.closedAt);
  const lines = [];
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━`); lines.push(`📅 ${period.label}`); lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━`);
  if (allOnChain.length === 0) { lines.push(``); lines.push(`Tidak ada posisi closed dalam periode ini.`); lines.push(``); return lines.join('\n'); }
  const totalPnl = allOnChain.reduce((s, p) => s + p.pnlUsd, 0);
  const totalFees = allOnChain.reduce((s, p) => s + p.fees, 0);
  const totalDeposit = allOnChain.reduce((s, p) => s + p.deposit, 0);
  const winners = allOnChain.filter(p => p.pnlUsd >= 0).length;
  const losers = allOnChain.filter(p => p.pnlUsd < 0).length;
  lines.push(``); lines.push(`📊 SUMMARY`);
  lines.push(`├ Positions Closed: ${allOnChain.length}`);
  lines.push(`├ Total PnL: ${totalPnl >= 0 ? '✅' : '❌'} ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
  lines.push(`├ Total Fees: 💎 $${totalFees.toFixed(2)}`);
  lines.push(`├ Win Rate: ${allOnChain.length > 0 ? Math.round((winners / allOnChain.length) * 100) : 0}% (${winners}W / ${losers}L)`);
  lines.push(`└ ROI: ${totalDeposit > 0 ? ((totalPnl / totalDeposit) * 100).toFixed(2) : '0.00'}%`);
  lines.push(``); lines.push(`📋 CLOSED POSITIONS`);
  for (let i = 0; i < allOnChain.length; i++) {
    const p = allOnChain[i];
    const icon = p.pnlUsd >= 0 ? '🟢' : '🔴';
    const pnlStr = `${p.pnlUsd >= 0 ? '+' : ''}$${p.pnlUsd.toFixed(2)}`;
    const pctStr = `${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(2)}%`;
    const durHrs = Math.floor(p.durationMin / 60);
    const durMins = p.durationMin % 60;
    const durStr = durHrs > 0 ? `${durHrs}h ${durMins}m` : `${p.durationMin}m`;
    const closeWIB = new Date(p.closedAt.getTime() + 7 * 3600000);
    const timeStr = `${String(closeWIB.getUTCHours()).padStart(2,'0')}:${String(closeWIB.getUTCMinutes()).padStart(2,'0')} WIB`;
    lines.push(`${'─'.repeat(28)}`);
    lines.push(`${icon} ${p.name} — ${pnlStr} (${pctStr})`);
    lines.push(`   Duration: ${durStr} | Close: ${timeStr}`);
    lines.push(`   Fees: $${p.fees.toFixed(2)}`);
    lines.push(`   Deposit: $${p.deposit.toFixed(2)} → Withdraw: $${p.withdraw.toFixed(2)}`);
  }
  lines.push(`${'─'.repeat(28)}`);
  lines.push(``);

  // ── Current Open Positions (via Meteora portfolio API) ───
  try {
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${WALLET}`;
    const res = await fetch(portfolioUrl);
    if (res.ok) {
      const portfolio = await res.json();
      const pools = portfolio.pools || [];
      if (pools.length > 0) {
        lines.push(`🔓 OPEN POSITIONS (${pools.length})`);
        for (const pool of pools) {
          const name = `${pool.tokenX || '?'}-${pool.tokenY || '?'}`;
          const deposit = parseFloat(pool.totalDeposit || '0');
          const pnl = parseFloat(pool.pnl || '0');
          const pnlPct = parseFloat(pool.pnlPctChange || '0');
          const fees = parseFloat(pool.unclaimedFees || '0');
          const oor = pool.outOfRange ? ' ⚠️ OOR' : '';
          const posCount = pool.listPositions?.length || 1;
          lines.push(`├ ${name}${pool.outOfRange ? ' ⚠️' : ''}`);
          lines.push(`├   Deposit: $${deposit.toFixed(2)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)${oor}`);
          lines.push(`└   Unclaimed Fees: $${fees.toFixed(2)}`);
        }
      } else {
        lines.push(`🔓 Tidak ada posisi terbuka.`);
      }
    } else {
      lines.push(`🔓 Open positions: API ${res.status}`);
    }
  } catch (e) {
    lines.push(`🔓 Open positions: ${e.message.slice(0, 60)}`);
  }

  lines.push(``);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━`);
  return lines.join('\n');
}

const mode = process.argv[2] || 'today';
if (mode === 'today' || mode === 'yesterday') {
  generateRecap(mode).then(output => console.log(output));
}
