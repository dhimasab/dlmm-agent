import { computePositions } from '/root/experimental-meridian/tools/pnl.js';
import { getMyPositions } from '/root/experimental-meridian/tools/dlmm.js';

console.log('=== pnl.js path ===');
const r1 = await computePositions('FHogGW8cfNy24c5S9Jvy4SrvBymP7Kqbmqp9M2RvvddQ');
for (const p of r1.positions || []) {
  console.log(p.pair, '| pnl_pct:', p.pnl_pct + '%', '| susp:', p.pnl_pct_suspicious, '| val:', p.total_value_usd);
}

console.log('\n=== dlmm.js path (mgmt cycle uses this) ===');
try {
  const r2 = await getMyPositions({ force: true, silent: true });
  for (const p of r2.positions || []) {
    console.log(p.pair, '| pnl_pct:', p.pnl_pct + '%', '| susp:', p.pnl_pct_suspicious, '| val:', p.total_value_usd);
  }
} catch(e) { console.log('dlmm.js err:', e.message); }
