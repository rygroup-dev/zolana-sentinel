<div align="center">

# ⚡ Zolana Sentinel

**Autonomous farming, trading & progression bot for [play.zolana.gg](https://play.zolana.gg)**

A smart, self-optimizing autopilot for the Solana creature-collector MMO — fully controllable from Telegram.

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Solana](https://img.shields.io/badge/Solana-Mainnet-9945FF?logo=solana&logoColor=white)](https://solana.com)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS-informational)](#)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

## Overview

Zolana Sentinel plays the game for you — around the clock. It reverse-engineers the game economy and makes profit-optimal decisions every cycle: it farms with your best creatures, raids the deepest dungeon it can clear, evolves and breeds toward higher rarities, claims every quest and reward, crafts from surplus materials, and trades on the marketplace — all while staying safe against rate limits and detection.

## ✨ Features

| | |
| --- | --- |
| 🌾 **Smart farming** | Always places the highest gold-per-hour creatures; auto-swaps weak ones out. |
| 🏰 **Dungeon / raid climbing** | Auto-calibrates party power and climbs the 25 floors as far as it can clear. |
| 🧬 **Growth engine** | Budget-aware evolve, breeding for rarity upgrades, gacha, and gem crafting. |
| 📜 **Full reward collection** | Quests, dex milestones, daily, idle, epoch, hold-claims — nothing left on the table. |
| 💠 **Material economy** | Keeps craft/build reserves, sells only the surplus at market floor. |
| 🏪 **Marketplace** | Edge-gated buying and anti-dump selling once unlocked. |
| ⚔️ **PvP** | Auto-builds a battle team and competes when Elder creatures are available. |
| 💰 **Profit tracker** | Live net-worth and $ZOLANA valuation. |
| 📲 **Telegram control** | Inline dashboard + 25+ commands, responses in ~1s. |
| 🛡️ **Resilient & stealthy** | Real browser headers, request jitter, retry/backoff, auto re-auth, crash guards. |

## 🚀 Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/rygroup-dev/zolana-sentinel/main/install.sh | bash
```

The installer:

1. Installs Node.js (if missing) and clones the repo.
2. Installs all npm dependencies.
3. **Interactively prompts** for the three things it needs and writes them to `.env`:
   - 🔑 **Wallet private key** (base58 or JSON array — entered hidden)
   - 🤖 **Telegram bot token** (from [@BotFather](https://t.me/BotFather))
   - 🆔 **Telegram chat id** (your numeric Telegram ID)

```
  ┌────────────────────────────────────────────────┐
  │            ⚡  Z O L A N A   S E N T I N E L      │
  │        Autonomous bot for play.zolana.gg         │
  │                    by rygroup                    │
  └────────────────────────────────────────────────┘

  Wallet private key (base58 or JSON array): ********
  Telegram bot token (from @BotFather): 1234:AA...
  Telegram chat id (your numeric ID): 12345678
```

Your credentials are stored **locally** in `.env` (chmod 600) and are never uploaded.

<details>
<summary>Manual install</summary>

```bash
git clone https://github.com/rygroup-dev/zolana-sentinel.git
cd zolana-sentinel
npm install
cp .env.example .env   # then edit .env
```
</details>

## ⚙️ Configuration

Edit `.env` — see [`.env.example`](.env.example) for every option.

| Key | Purpose |
| --- | --- |
| `ZOLANA_PRIVATE_KEY` | Your wallet secret (base58 or JSON array). Signs login + token transfers. |
| `ZOLANA_TELEGRAM_BOT_TOKEN` | Telegram bot token from [@BotFather](https://t.me/BotFather). |
| `ZOLANA_TELEGRAM_CHAT_ID` | Your Telegram chat id (owner-only control). |
| `ZOLANA_REAL_RUN` | `true` to act on-chain, `false` for a safe dry-run. |
| `SOLANA_RPC_URL` | Solana RPC endpoint. |

> **Security:** every credential is read from the environment. `.env` is git-ignored and never committed. Each user runs with their **own** wallet and keys.

## ▶️ Run

```bash
node src/index.js          # long-running autopilot + Telegram control
node src/index.js --once   # run a single cycle and exit
```

<details>
<summary>Run as a systemd service (Linux)</summary>

```ini
[Unit]
Description=Zolana Sentinel
After=network-online.target

[Service]
WorkingDirectory=/root/zolana-sentinel
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now zolana-sentinel
journalctl -u zolana-sentinel -f
```
</details>

## 📲 Telegram Control

Message your bot and use the inline dashboard or slash commands. `/help` lists them all.

| Group | Commands |
| --- | --- |
| **Overview** | `/status` · `/wallet` · `/profit` · `/inventory` · `/creature` · `/stats` |
| **Actions** | `/dungeon` · `/evolve` · `/breed` · `/companion` · `/relic` · `/epoch` · `/pvp` |
| **Rewards** | `/claim` · `/daily` · `/quests` · `/gemcraft` · `/afk` |
| **Economy** | `/gacha` · `/eggs` · `/buyegg` · `/store` · `/slot` · `/market` · `/listings` · `/fund` |
| **Control** | `/auto` (per-module toggles) · `/once` · `/pause` · `/resume` |
| **Wallet ops** | `/deposit` · `/sendfee` · `/sendzolana` · `/withdrawal` · `/sweep` · `/genwallet` |

Every autopilot module can be toggled live from the `/auto` panel.

### 💤 Going offline

The bot keeps the account in the **AFK zone** automatically, so it keeps farming gold + stamina even while your PC is off. Before shutting down you can also tap **`/afk`** to bank pending rewards and confirm the AFK zone is active.

## 🧠 How It Works

- **Decoupled loop** — the strategy cycle runs on an interval while Telegram is long-polled continuously, so commands respond in ~1 second.
- **Profit-first** — decisions are ranked by expected value: farm the best producers, raid for materials + gold, spend only surplus, and never dip below safety reserves.
- **Self-calibrating** — learns party power from the game, climbs dungeon floors, and adapts as the account grows.
- **Hardened** — per-request timeouts, exponential backoff on network/rate-limit errors, transparent re-authentication, human-like pacing, and process-level crash guards.

## 📁 Project Structure

```
src/
  index.js      main loop + Telegram command router
  strategy.js   autopilot brain (farming, dungeon, evolve, breed, gacha, market…)
  client.js     game API client (auth, requests, hardening)
  wallet.js     Solana wallet (signing, token transfers)
  telegram.js   Telegram bot (dashboard, formatters)
  config.js     env-validated configuration
  state.js      persisted runtime state
  logger.js     structured logging (secrets redacted)
  captcha.js    optional 2captcha fallback
```

## ⚠️ Disclaimer

For educational purposes. Automating a game may violate its terms of service — use at your own risk. You are responsible for your own wallet, keys, and funds.

## 📜 License

Released under the [MIT License](LICENSE).
