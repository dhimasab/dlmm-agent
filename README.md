# DLMM Agent

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

DLMM Agent runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. It learns from every position it closes.

---

## Install

### Locally
```bash
git clone https://github.com/dhimasab/dlmm-agent.git
cd dlmm-agent
npm install
cp .env.example .env
cp user-config.json.example user-config.json
nano .env
nano user-config.json
node index.js
```

### On VPS (with pm2)

```bash
ssh ubuntu@YOUR_VPS_IP

# Install Node.js 22 using nvm (recommended, avoids apt issues)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc
nvm install 22

# Clone repo
git clone https://github.com/dhimasab/dlmm-agent.git
cd dlmm-agent
npm install

# Copy example configs
cp .env.example .env
cp user-config.json.example user-config.json

# Edit configs with your settings
nano .env
nano user-config.json

# Install pm2 & start
npm install -g pm2
pm2 start node --name "dlmm-agent" -- index.js
pm2 save
pm2 startup
```

### pm2 commands
```bash
pm2 status                    # Check if running
pm2 logs dlmm-agent           # View logs
pm2 restart dlmm-agent        # Restart
pm2 stop dlmm-agent           # Stop
```

### Monitor from anywhere
```bash
# Telegram commands (while running):
/positions       # List open positions
/close <n>       # Close position by index
/set <n> <note>  # Set note on position
/briefing        # Morning briefing
/status          # Wallet + positions
```

---

## Configuration

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
  "deployAmountSol": 0.5,
  "maxDeployAmount": 50,
  "deployAmountUsdc": 100,
  "maxDeployAmountUsdc": 500,
  "maxPositions": 2,
  "minSolToOpen": 0.1,
  "positionSizePct": 0,
  "positionSizePctUsdc": 0,
  "gasReserve": 0.01,
  "capitalSol": 1.4,
  "autoSweepSolToUsdc": true,
  "strategy": "spot",
  "minBinsBelow": 35,
  "maxBinsBelow": 69,
  "managementIntervalMin": 3,
  "screeningIntervalMin": 15,
  "stopLossPct": -10,
  "takeProfitPct": 8,
  "outOfRangeWaitMinutes": 30
}
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
| **Screening** | Every 15 min | Pool screening → deploy |
| **Management** | Every 3 min | Position evaluation → close/stay |

**Data sources:**
- Meteora DLMM SDK (on-chain data)
- Meteora PnL API (yield, fees, PnL)
- OKX OnchainOS (smart money signals)
- Pool screening API (metrics)
- Jupiter API (token audit)

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

