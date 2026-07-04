import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  ZOLANA_PRIVATE_KEY: z.string().optional().default(''),
  ZOLANA_PRIVATE_KEY_FILE: z.string().optional().default(''),
  ZOLANA_USERNAME: z.string().min(3).default('ohmaygawd'),
  ZOLANA_SERVER: z.string().default('sakura'),
  ZOLANA_REAL_RUN: z.coerce.boolean().default(false),
  ZOLANA_LOOP_MS: z.coerce.number().int().min(30_000).default(180_000),
  // Randomize the loop interval ±this so cycles never fire on a robotic fixed clock.
  ZOLANA_LOOP_JITTER_MS: z.coerce.number().int().min(0).default(45_000),
  ZOLANA_MIN_ACTION_GAP_MS: z.coerce.number().int().min(500).default(1500),
  // Random extra delay (0..this) added to every request so pacing looks human.
  ZOLANA_ACTION_JITTER_MS: z.coerce.number().int().min(0).default(1200),
  ZOLANA_MAX_ACTIONS_PER_CYCLE: z.coerce.number().int().min(1).max(50).default(12),
  // Anti-ban: present as a real browser, not "ZolanaBot".
  ZOLANA_USER_AGENT: z.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'),
  // Robustness: per-request timeout + retry/backoff on network/5xx/429.
  ZOLANA_HTTP_TIMEOUT_MS: z.coerce.number().int().min(3000).default(25_000),
  ZOLANA_HTTP_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
  ZOLANA_HTTP_BACKOFF_MS: z.coerce.number().int().min(200).default(1500),
  // 2captcha fallback if Cloudflare ever throws a Turnstile challenge (usually not
  // needed — the API is wallet-signed, not browser-gated). Empty = disabled.
  ZOLANA_2CAPTCHA_KEY: z.string().optional().default(''),
  ZOLANA_LOGIN_MESSAGE_TEMPLATE: z.string().default('auto'),
  ZOLANA_API_BASE: z.string().url().default('https://play.zolana.gg'),
  ZOLANA_HAR_PATH: z.string().default('/root/zolana/play.zolana.gg.har'),
  SOLANA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  ZOLANA_TOKEN_MINT: z.string().default('Ez6gPDiNK7VtGe5o9vnhDHJq9QPHvEYmSo8teu8mpump'),
  // Canonical game treasury (from the client bundle `zolanaTreasury` — matches the
  // server-provided gacha/market treasury). Stamina restore is an on-chain $ZOLANA
  // transfer here (no server quote), so this address must be exact.
  ZOLANA_TREASURY: z.string().default('Auywa2xpfcTaBmfzNCLXSLTM5kzBh9kwjuABHY2usVNC'),
  // Stamina restore ("Stamina Elixir") cost in whole $ZOLANA → refills to full (180).
  ZOLANA_STAMINA_ZENKO_COST: z.coerce.number().int().min(1).default(50),
  // Auto-buy stamina ($ZOLANA) when drained so raids resume immediately (default OFF —
  // it spends token). Hard daily cap bounds the max spend (default 4 × 50 = 200/day).
  ZOLANA_AUTO_STAMINA: z.coerce.boolean().default(false),
  ZOLANA_AUTO_STAMINA_MAX_PER_DAY: z.coerce.number().int().min(0).default(20),
  ZOLANA_AUTO_MARKET: z.coerce.boolean().default(true),
  ZOLANA_AUTO_MARKET_BUY: z.coerce.boolean().default(true),
  ZOLANA_AUTO_MARKET_SELL: z.coerce.boolean().default(true),
  ZOLANA_MARKET_MAX_BUY_USD: z.coerce.number().min(0).default(1.1),
  ZOLANA_MARKET_MAX_BUYS_PER_CYCLE: z.coerce.number().int().min(0).max(5).default(1),
  ZOLANA_MARKET_MIN_EDGE_BPS: z.coerce.number().int().min(0).default(1800),
  ZOLANA_MARKET_ZOLANA_RESERVE: z.coerce.number().min(0).default(10000),
  ZOLANA_MARKET_CYCLE_BUDGET_ZOLANA: z.coerce.number().min(0).default(35000),
  ZOLANA_MARKET_SELL_LEVEL: z.coerce.number().int().min(1).default(5),
  ZOLANA_MARKET_KEEP_CREATURES: z.coerce.number().int().min(0).default(3),
  ZOLANA_MARKET_KEEP_GOLD: z.coerce.number().int().min(0).default(25000),
  // Only auto-buy item kinds that actually grow the account. Speculative kinds
  // (cosmetic/relic/material/gem) are excluded because the bot has no resale path
  // for them — spending token on them is a loss, not a flip.
  ZOLANA_MARKET_BUY_KINDS: z.string().default('egg,creature'),
  // List surplus at this fraction of the current floor so it actually sells,
  // but never below the hard minimum unit price (anti-dump guard).
  ZOLANA_MARKET_SELL_UNDERCUT: z.coerce.number().min(0.5).max(1).default(0.97),
  ZOLANA_MARKET_MIN_SELL_USD: z.coerce.number().min(0).default(0.05),
  ZOLANA_WITHDRAW_MIN_SOL_RESERVE: z.coerce.number().min(0).default(0.01),
  ZOLANA_MAX_WITHDRAW_SOL: z.coerce.number().min(0).default(0.25),
  ZOLANA_AUTO_AFK: z.coerce.boolean().default(true),
  ZOLANA_AUTO_CLAIMS: z.coerce.boolean().default(true),
  ZOLANA_AUTO_QUESTS: z.coerce.boolean().default(true),
  ZOLANA_AUTO_DUNGEON: z.coerce.boolean().default(true),
  // Stamina-cycle raiding: when full, RAID with the STRONGEST creatures (unplaced from
  // farming) in parallel bursts, climbing floors until stamina drains; then FARM (place
  // the strongest for gold) while stamina regenerates; re-raid once refilled. Kill-switch
  // — set false to fall back to the legacy "farm the strongest, raid with the rest".
  ZOLANA_RAID_STAMINA_CYCLE: z.coerce.boolean().default(true),
  // Re-enter the RAID phase once stamina refills to this fraction of the observed max.
  ZOLANA_RAID_REFILL_FRAC: z.coerce.number().min(0.1).max(1).default(0.9),
  ZOLANA_AUTO_EVOLVE: z.coerce.boolean().default(true),
  ZOLANA_AUTO_BREED: z.coerce.boolean().default(true),
  ZOLANA_AUTO_GACHA: z.coerce.boolean().default(true),
  ZOLANA_AUTO_PVP: z.coerce.boolean().default(true),
  ZOLANA_AUTO_SLOTS: z.coerce.boolean().default(true),
  ZOLANA_TARGET_PLACED: z.coerce.number().int().min(1).default(6),
  // Evolve keeps at least this much gold in reserve (so leveling quests like
  // d_gold "hold 30k" and egg buys aren't starved). Evolve spends only surplus.
  ZOLANA_EVOLVE_GOLD_RESERVE: z.coerce.number().int().min(0).default(30000),
  // Max gold to spend on evolutions per cycle (concentrates investment, avoids dumps).
  ZOLANA_EVOLVE_CYCLE_BUDGET: z.coerce.number().int().min(0).default(60000),
  // Gacha: pull this tier (standard=8 gems, deluxe=15 gems) when gems are above
  // the keep-floor. deluxe has better Legendary/Mythical odds.
  ZOLANA_GACHA_TIER: z.string().default('deluxe'),
  ZOLANA_GACHA_KEEP_GEMS: z.coerce.number().int().min(0).default(20),
  // Relics: craft + equip to unlock the d_equip (+150 XP/day) and w_relics quests.
  // Craft costs gold (server-validated); only craft above this floor so it doesn't
  // starve the evolve reserve / d_gold quest. Target = own this many relics (w_relics=3).
  ZOLANA_AUTO_RELIC: z.coerce.boolean().default(true),
  ZOLANA_RELIC_TARGET: z.coerce.number().int().min(0).default(3),
  ZOLANA_RELIC_CRAFT_GOLD_FLOOR: z.coerce.number().int().min(0).default(45000),
  // Epoch: donate surplus gold/materials during a funding window for a $ZOLANA
  // rebate (not level-gated). Only fires when donation is actually open.
  ZOLANA_AUTO_EPOCH: z.coerce.boolean().default(true),
  ZOLANA_EPOCH_DONATE_GOLD_FLOOR: z.coerce.number().int().min(0).default(120000),
  // Spend gems on the best creature source: premium egg (50 gems, Rare/Epic/Legendary)
  // when unlocked, else gacha. Craft gems free from dungeon gem_catalyst.
  ZOLANA_AUTO_PREMIUM_EGG: z.coerce.boolean().default(true),
  ZOLANA_AUTO_GEMCRAFT: z.coerce.boolean().default(true),
  // Auto-buy growth eggs with GOLD (bootstrap + reserve). Toggle off (/buyegg) to let
  // gold accumulate — a forest egg costs 50k, which can keep gold from piling up.
  ZOLANA_AUTO_BUY_EGG: z.coerce.boolean().default(true),
  // Prefer forest egg (50k gold, up to Rare) over basic when gold is plentiful.
  ZOLANA_EGG_PREFER_FOREST: z.coerce.boolean().default(true),
  ZOLANA_FOREST_EGG_GOLD_FLOOR: z.coerce.number().int().min(0).default(90000),
  // Companion = equip strongest creature to buff whole-party raid/PvP power (helps
  // clear higher dungeon regions → more gold/materials). Free, no cost.
  ZOLANA_AUTO_COMPANION: z.coerce.boolean().default(true),
  // Relic enhance: spend relic_shard (from dungeons) to boost the equipped relic's
  // stats (more party power). Keep a small reserve so we don't dump every shard.
  ZOLANA_AUTO_RELIC_ENHANCE: z.coerce.boolean().default(true),
  ZOLANA_RELIC_SHARD_KEEP: z.coerce.number().int().min(0).default(0),
  // Relic enhance is now a deep GOLD sink (post-rework). Only enhance when gold is
  // comfortably above this floor so it never eats into the d_gold quest reserve.
  ZOLANA_RELIC_ENHANCE_GOLD_FLOOR: z.coerce.number().int().min(0).default(45000),
  // Auto-dismantle junk (low-rarity, unequipped) relics into relic_shard = enhance fuel.
  ZOLANA_AUTO_RELIC_DISMANTLE: z.coerce.boolean().default(true),
  ZOLANA_RELIC_DISMANTLE_PER_CYCLE: z.coerce.number().int().min(1).max(10).default(4),
  ZOLANA_SLOT_BUY_GOLD_FLOOR: z.coerce.number().int().min(0).default(60000),
  ZOLANA_EGG_RESERVE_TARGET: z.coerce.number().int().min(0).default(0),
  ZOLANA_EGG_BUY_GOLD_FLOOR: z.coerce.number().int().min(0).default(50000),
  ZOLANA_EGG_BUY_GOLD_RESERVE: z.coerce.number().int().min(0).default(45000),
  ZOLANA_TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  ZOLANA_TELEGRAM_CHAT_ID: z.string().optional().default(''),
  ZOLANA_TELEGRAM_POLL: z.coerce.boolean().default(true),
  LOG_LEVEL: z.string().default('info'),
});

export const config = schema.parse(process.env);
