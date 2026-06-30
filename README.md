# DLMM Agent

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

DLMM Agent runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. It learns from every position it closes.

---

## ⚡ Quick Setup

```bash
# Clone repo
git clone https://github.com/dhimasab/dlmm-agent.git
cd dlmm-agent

# Install dependencies
npm install

# Setup .env (see below)
# Edit user-config.json if needed

# Go live
node index.js
```

---

## Configuration for 1 SOL Wallet

**Conservative settings for low-capital testing:**

### `.env`
```env
# ── LLM Provider ──────────────────────────────────────────
LLM_BASE_URL=<your-llm-base-url>
LLM_API_KEY=<your-llm-api-key>
LLM_MODEL=<your-model>

# ── Wallet ────────────────────────────────────────────────
WALLET_PRIVATE_KEY=your_base58_private_key

# ── Solana RPC ─────────────────────────────────────────────
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=your_helius_key

# ── Jupiter API (opsional, tanpa key juga jalan) ──────────
JUPITER_API_KEY=

# ── Deploy Settings (1 SOL wallet) ─────────────────────────
DEPLOY_AMOUNT_SOL=0.05         # Per position
MAX_DEPLOY_AMOUNT=0.3          # Max per cycle
POSITION_SIZE_PCT=0.25         # 25% wallet
GAS_RESERVE=0.2                # Gas buffer

# ── Telegram (optional) ────────────────────────────────────
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# ── Mode ───────────────────────────────────────────────────
DRY_RUN=true                   # Set false for live
LOG_LEVEL=info
```

### `user-config.json` (key settings)
```json
{
  "deployAmountSol": 0.05,
  "maxDeployAmount": 0.3,
  "maxPositions": 2,
  "minSolToOpen": 0.15,
  "positionSizePct": 0.25,
  "gasReserve": 0.2
}
```

**Wallet math:**
- Total: 1 SOL
- Gas reserve: 0.2 SOL (locked)
- Deployable: 0.8 SOL
- Per cycle: 2 positions × 0.05 = 0.1 SOL max
- Buffer: 0.5 SOL remaining ✓

---

## Deploy to VPS

### 1. Clone on VPS
```bash
ssh ubuntu@YOUR_VPS_IP
git clone https://github.com/dhimasab/dlmm-agent.git
cd dlmm-agent
npm install
```

### 2. Setup & run with pm2
```bash
# Copy .env
nano .env
# (paste your config, Ctrl+X to save)

# Start with pm2
pm2 start node --name "dlmm-agent" -- index.js
pm2 save
pm2 startup
```

### 3. pm2 commands
```bash
pm2 status                    # Check if running
pm2 logs dlmm-agent           # View logs
pm2 logs dlmm-agent --lines 50 --nostream  # Recent logs
pm2 restart dlmm-agent        # Restart
pm2 stop dlmm-agent           # Stop
pm2 delete dlmm-agent         # Remove from pm2
```

### 4. Monitor from anywhere
```bash
# Telegram commands (while running):
/positions       # List open positions
/close <n>       # Close position by index
/set <n> <note>  # Set note on position
/briefing        # Morning briefing
/status          # Wallet + positions
/thresholds      # Settings
```

---

## What It Does

- **Screens pools** — scans Meteora DLMM pools against configurable thresholds
- **Manages positions** — monitors, claims fees, closes positions autonomously
- **Learns from performance** — studies top LPers, evolves thresholds from history
- **Discord signals** — optional LP Army channel monitoring
- **Telegram chat** — full agent chat + cycle reports

---

## How It Works

DLMM Agent runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts.

| Agent | Interval | Role |
|---|---|---|
| **Screening** | Every 30 min | Pool screening → deploy |
| **Management** | Every 10 min | Position evaluation → close/stay |

**Data sources:**
- Meteora DLMM SDK (on-chain data)
- Meteora PnL API (yield, fees, PnL)
- OKX OnchainOS (smart money signals)
- Pool screening API (metrics)
- Jupiter API (token audit)

---

## Out of Range (OOR) Handling

### Direction-Aware OOR Logic

DLMM Agent now distinguishes between OOR directions with different exit behaviors:

| Direction | Behavior |
|-----------|----------|
| **OOR Up** (price above upper bin) | Waits 45 minutes before closing (configurable via `outOfRangeWaitMinutes`) |
| **OOR Down** (price below lower bin) | **Immediate Stop Loss** - closes position and swaps to SOL |

### Configuration

```json
{
  "outOfRangeWaitMinutes": 30,
  "outOfRangeDownTriggersSL": true,
  "stopLossPct": -10
}
```

- `outOfRangeWaitMinutes` - minutes to wait before closing OOR Up positions (default: 45)
- `outOfRangeDownTriggersSL` - enable/disable immediate SL for OOR Down (default: true)

### Why Separate Handling?

- **OOR Down** typically indicates strong downward momentum - waiting wastes time and risks further loss
- **OOR Up** often recovers quickly as price can spike above range temporarily

---

## Requirements

- Node.js 18+
- LLM API key (OpenAI-compatible endpoint, e.g. OpenRouter)
- Solana wallet (base58 private key)
- Solana RPC endpoint
- Telegram bot token (optional)

---

## Files

- `.env` — API keys, wallet, RPC, deploy settings
- `user-config.json` — risk preset, thresholds, models
- `decision-log.json` — all decisions + reasoning
- `pool-notes.json` — pool observations
- `lessons.json` — learned patterns

---

## Running Modes

| Mode | Command | Usage |
|---|---|---|
| Dry run | `node index.js` | Test without transactions (set `DRY_RUN=true` in .env) |
| Live | `node index.js` | Autonomous trading |
| pm2 | `pm2 start node --name "dlmm-agent" -- index.js` | Daemon mode |
| CLI tools | `node cli.js <command>` | Direct tool calls |

---

## Troubleshooting

**Model errors:** If using a thinking/reasoning model, ensure `tool_choice=auto` or omit it — some models don't support `tool_choice=required` with thinking enabled.

**Connection issues:** Use VPS for 24/7 uptime with pm2 for auto-restart. Recommended: DigitalOcean, Linode ($5-10/mo).

**Low balance:** Minimum 0.5 SOL recommended for 1-position safety. 5+ SOL for comfortable operation.

---

## License

MIT

