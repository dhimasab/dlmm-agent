import { getMyPositions } from '/root/experimental-meridian/tools/dlmm.js';

const r = await getMyPositions({ force: true, silent: true });
for (const p of r.positions || []) {
  console.log(p.pair, '| pnl_pct:', p.pnl_pct + '%', '| susp:', p.pnl_pct_suspicious, '| val:', p.total_value_usd, '| unclaimed:', p.unclaimed_fees_usd);
}
