# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

Meridian runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. It learns from every position it closes.

---

## ⚡ Quick Setup (OpenCode + DeepSeek)

This configuration uses **OpenCode API** with **DeepSeek-v4-Flash** model for cost-effective autonomous trading.

```bash
# Clone
git clone https://github.com/dhimasab/meridianagent.git
cd meridianagent

# Install
npm install

# Setup .env (see below)
# Edit user-config.json if needed

# Test (dry run)
npm run dev

# Go live
npm start
```

---

## Configuration for 1 SOL Wallet

**Conservative settings for low-capital testing:**

### `.env`
```env
# ── LLM Provider (OpenCode + DeepSeek) ────────────────────
LLM_BASE_URL=https://opencode.ai/zen/go/v1
LLM_API_KEY=sk-your-opencode-api-key
LLM_MODEL=deepseek-v4-flash

# ── Wallet ────────────────────────────────────────────────
WALLET_PRIVATE_KEY=your_base58_private_key

# ── Solana RPC ─────────────────────────────────────────────
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=your_helius_key

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

### 1. Create GitHub private repo
```
https://github.com/YOUR_USERNAME/meridianagent
```

### 2. Clone on VPS
```bash
ssh ubuntu@YOUR_VPS_IP
cd ~
git clone https://github.com/YOUR_USERNAME/meridianagent.git meridian
cd meridian
```

### 3. Setup & run
```bash
# Copy .env (secure method recommended)
# nano .env
# (paste your config, Ctrl+X to save)

npm install
npm start
```

### 4. Monitor from anywhere
```bash
# REPL commands while running:
> /status           # Wallet + positions
> /candidates       # Screen pools
> /learn            # Study top LPers
> /thresholds       # Settings + stats
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

Meridian runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts.

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

## Requirements

- Node.js 18+
- OpenCode API key (https://opencode.ai)
- Solana wallet (base58 private key)
- Helius RPC endpoint (https://helius.xyz)
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
| Dry run | `npm run dev` | Test without transactions |
| Live | `npm start` | Autonomous trading |
| CLI tools | `meridian <command>` | Direct tool calls |

---

## Troubleshooting

**Model errors:** If using OpenCode, ensure `tool_choice=auto` (not `required`) — some models don't support it with thinking enabled.

**Connection issues:** Use VPS for 24/7 uptime. Recommended: DigitalOcean, Linode ($5-10/mo).

**Low balance:** Minimum 0.5 SOL recommended for 1-position safety. 5+ SOL for comfortable operation.

---

## License

MIT

