import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import { config } from './config.js';
import { logger } from './logger.js';
import { generateWallet, loadWallet } from './wallet.js';
import { ZolanaClient } from './client.js';
import { BotState } from './state.js';
import { StrategyEngine } from './strategy.js';
import { TelegramBot, formatGachaCards } from './telegram.js';

async function main() {
  const once = process.argv.includes('--once');
  const wallet = loadWallet();
  const client = new ZolanaClient(wallet);
  const state = BotState.load();
  const engine = new StrategyEngine(client, state);
  const telegram = new TelegramBot(state);

  logger.info({
    wallet: wallet.publicKey,
    realRun: config.ZOLANA_REAL_RUN,
    loopMs: config.ZOLANA_LOOP_MS,
  }, 'zolana bot started');
  await telegram.registerCommands();
  await telegram.notify(telegram.menuText(), { reply_markup: telegram.mainKeyboard() });

  // The strategy cycle runs on its own schedule (ZOLANA_LOOP_MS), while Telegram
  // is long-polled continuously so buttons/commands respond within ~1s instead of
  // waiting for the next cycle. `state.data.runCycleNow` lets a command force a run.
  let nextCycleAt = 0;
  let consecutiveErrors = 0;
  do {
    try {
      const due = Date.now() >= nextCycleAt || state.data.runCycleNow;
      if (!state.data.paused && due) {
        state.data.runCycleNow = false;
        await engine.cycle();
        consecutiveErrors = 0;
        // Randomize the next cycle so we never fire on a robotic fixed clock.
        const jitter = Math.floor((Math.random() - 0.5) * 2 * config.ZOLANA_LOOP_JITTER_MS);
        nextCycleAt = Date.now() + config.ZOLANA_LOOP_MS + jitter;
        await drainNotifications(telegram, state);
      }
    } catch (error) {
      // Exponential backoff on repeated failures (network/Cloudflare/rate-limit) so a
      // sustained outage can't hammer the server or spam alerts — resilient, not brittle.
      consecutiveErrors += 1;
      const backoff = Math.min(30 * 60_000, 60_000 * (2 ** (consecutiveErrors - 1)));
      logger.error({ status: error.status, message: error.message, consecutiveErrors, backoffMs: backoff }, 'cycle failed');
      if (consecutiveErrors <= 3 || consecutiveErrors % 5 === 0) {
        await telegram.notify(`⚠️ <b>Zolana bot</b> cycle error (#${consecutiveErrors})\n<code>${esc(error.message)}</code>\nRetry in ${Math.round(backoff / 60000)}m.`).catch(() => {});
      }
      nextCycleAt = Date.now() + backoff;
      try { state.save(); } catch { /* keep looping */ }
    }

    if (once) break;

    // Never let a Telegram hiccup kill the loop.
    const didPoll = await telegram.poll((command, bot) => handleCommand(command, bot, engine, state)).catch(() => false);
    if (!didPoll) await sleep(3000);
  } while (true);
}

const AUTO_KEYS = new Set(['afk', 'claims', 'quests', 'dungeon', 'evolve', 'breed', 'gacha', 'premiumEgg', 'gemcraft', 'buyegg', 'autostamina', 'relic', 'relicEnhance', 'companion', 'epoch', 'pvp', 'slots', 'marketBuy', 'marketSell']);
const AUTO_DEFAULTS = {
  afk: config.ZOLANA_AUTO_AFK,
  claims: config.ZOLANA_AUTO_CLAIMS,
  quests: config.ZOLANA_AUTO_QUESTS,
  dungeon: config.ZOLANA_AUTO_DUNGEON,
  evolve: config.ZOLANA_AUTO_EVOLVE,
  breed: config.ZOLANA_AUTO_BREED,
  gacha: config.ZOLANA_AUTO_GACHA,
  premiumEgg: config.ZOLANA_AUTO_PREMIUM_EGG,
  gemcraft: config.ZOLANA_AUTO_GEMCRAFT,
  buyegg: config.ZOLANA_AUTO_BUY_EGG,
  autostamina: config.ZOLANA_AUTO_STAMINA,
  relic: config.ZOLANA_AUTO_RELIC,
  relicEnhance: config.ZOLANA_AUTO_RELIC_ENHANCE,
  companion: config.ZOLANA_AUTO_COMPANION,
  epoch: config.ZOLANA_AUTO_EPOCH,
  pvp: config.ZOLANA_AUTO_PVP,
  slots: config.ZOLANA_AUTO_SLOTS,
  marketBuy: config.ZOLANA_AUTO_MARKET_BUY,
  marketSell: config.ZOLANA_AUTO_MARKET_SELL,
};

const GACHA_TIER_ALIASES = {
  basic: 'standard',
  standard: 'standard',
  deluxe: 'deluxe',
};

const GACHA_TIER_COSTS = {
  standard: 8,
  deluxe: 15,
};

function normalizeGachaTier(value = 'standard') {
  return GACHA_TIER_ALIASES[String(value).toLowerCase()] || null;
}

async function handleCommand(command, tg, engine, state) {
  const [name, ...args] = command.split(/\s+/);
  const client = engine.client;
  const menuMarkup = { reply_markup: tg.mainKeyboard() };

  // Manual commands always get a fresh action budget — otherwise a full autopilot
  // cycle can exhaust the per-cycle cap and silently drop button-triggered actions.
  engine.actionsThisCycle = 0;
  // Ensure we have a valid session before hitting any game endpoint on demand.
  await client.ensureLogin().catch(() => {});

  // Pending manual-sale price entry: a plain (non-command) message while a /sell pick
  // is waiting → parse "<price> [qty]" and list it. Expires after 5 min.
  const ps = state.data.pendingSale;
  if (ps && !name.startsWith('/')) {
    const nums = command.split(/\s+/).map(Number).filter(Number.isFinite);
    if (nums.length && nums[0] > 0 && (Date.now() - ps.ts) < 5 * 60 * 1000) {
      state.data.pendingSale = null; state.save();
      const qty = ps.needsQty ? Math.min(Math.floor(nums[1] || ps.qtyDefault), ps.maxQty) : ps.qtyDefault;
      return performList(client, tg, sellPayload(ps, nums[0], qty));
    }
  }

  switch (name) {
    case '/start':
    case '/commands':
    case '/help':
      return tg.notify(tg.menuText(), menuMarkup);

    case '/status': {
      // Fetch LIVE (not the ~3-min-old cycle snapshot) so stamina/gold/xp are real-time.
      // Refresh the cache too, and fall back to the snapshot if the live fetch fails.
      let snap = state.data.lastPlayer;
      try {
        const live = await client.loadPlayer();
        snap = engine.snapshotPlayer(live);
        state.data.lastPlayer = snap; state.save();
      } catch { /* offline/maintenance → show last snapshot */ }
      return tg.notify(tg.formatStatus(snap, state.data.market), menuMarkup);
    }

    case '/market': {
      const s = state.data.market?.summary || {};
      const checked = state.data.market?.checkedAt ? new Date(state.data.market.checkedAt) : null;
      const order = ['creature', 'egg', 'relic', 'cosmetic', 'material', 'gem', 'gold'];
      const emoji = { creature: '🐾', egg: '🥚', relic: '💍', cosmetic: '🎀', material: '⛏️', gem: '💎', gold: '💰' };
      const lines = ['<b>🏪 MARKETPLACE</b>', '━━━━━━━━━━━━━━━━━━━━', '<i>Floor price per unit ($):</i>', ''];
      let any = false;
      for (const k of order) {
        const f = s[k];
        if (!f || !f.count) continue;
        any = true;
        const floor = f.floorUnitUsd != null ? `$${f.floorUnitUsd}` : '—';
        lines.push(`${emoji[k]} <b>${k}</b> — floor ${floor} · ${f.count} listed`);
      }
      if (!any) lines.push('<i>No market data cached yet (updates every ~20 min).</i>');
      if (checked) lines.push('', `<i>Updated ${checked.toISOString().slice(11, 16)} UTC</i>`);
      const rows = [
        [{ text: '🏷️ Sell My Items', callback_data: '/sell' }],
        [{ text: '📄 My Listings', callback_data: '/listings' }, { text: '💎 Buy Gems', callback_data: '/buygems' }],
        [{ text: '⬅️ Back', callback_data: '/start' }],
      ];
      return tg.notify(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    case '/wallet': {
      const sol = await client.wallet.solBalance().catch(() => 0);
      let token = null;
      try { token = await client.wallet.tokenBalance(); } catch { /* no ata yet */ }
      const price = Number(state.data.profit?.zolanaPriceUsd) || null;
      return tg.notify(tg.formatWallet(sol, token, price), menuMarkup);
    }

    case '/profit':
      return tg.notify(tg.formatProfit(), menuMarkup);

    case '/stats':
      return tg.notify(tg.formatStats(), menuMarkup);

    case '/once':
      await tg.notify('▶️ Running one cycle…');
      await engine.cycle();
      return tg.notify(tg.formatStatus(state.data.lastPlayer, state.data.market), menuMarkup);

    case '/pause':
      state.data.paused = true; state.save();
      return tg.notify('⏸ Autopilot <b>paused</b>.', menuMarkup);

    case '/resume':
      state.data.paused = false;
      state.data.runCycleNow = true; // kick a cycle immediately on resume
      state.save();
      return tg.notify('✅ Autopilot <b>resumed</b> — running a cycle now.', menuMarkup);

    case '/daily': {
      const res = await client.claimDaily().catch((e) => ({ error: e.message }));
      state.count('daily');
      if (res?.error) return tg.notify(`🎁 Daily: <code>${esc(res.error)}</code>`, menuMarkup);
      state.cooldown('daily', 23 * 60 * 60 * 1000); state.save();
      return tg.notify('🎁 <b>Daily reward claimed!</b>', menuMarkup);
    }

    case '/auto':
      return tg.notify('⚙️ <b>Autopilot panel</b>\nTap to toggle each module on/off:', {
        reply_markup: tg.autoKeyboard(engine),
      });

    case '/toggle': {
      const key = args[0];
      if (!AUTO_KEYS.has(key)) return tg.notify('Unknown toggle.');
      const current = engine.toggle(key, AUTO_DEFAULTS[key]);
      engine.setToggle(key, !current);
      return tg.notify(`⚙️ <b>${key}</b> → ${!current ? '🟢 ON' : '🔴 OFF'}`, {
        reply_markup: tg.autoKeyboard(engine),
      });
    }

    case '/pvp': {
      await tg.notify('⚔️ Finding a PvP opponent…');
      const res = await client.pvpMatch().catch((e) => ({ error: e.message }));
      const pvp = res?.pvp || res;
      if (res?.error) return tg.notify(`⚔️ PvP failed: <code>${res.error}</code>`, menuMarkup);
      const won = pvp?.result === 'win' || pvp?.won === true;
      return tg.notify(`⚔️ <b>PvP ${won ? '🏆 WON' : 'done'}</b>\n<code>${esc(JSON.stringify(pvp).slice(0, 300))}</code>`, menuMarkup);
    }

    case '/dungeon': {
      const player = await client.loadPlayer().catch(() => null);
      await engine.dungeonRun(player);
      return tg.notify('🏰 Dungeon: start/claim processed (see /stats).', menuMarkup);
    }

    case '/evolve': {
      const player = await client.loadPlayer().catch(() => null);
      state.data.cooldowns.evolve = 0;
      await engine.evolveBest(player);
      return tg.notify('🧬 Evolving all eligible creatures (advanced-first, within gold budget).', menuMarkup);
    }

    case '/quests': {
      const player = await client.loadPlayer().catch(() => null);
      state.data.cooldowns.quests = 0;
      await engine.claimQuests(player);
      return tg.notify('📜 Claimed all completed quests (+150 account XP each).', menuMarkup);
    }

    case '/breed': {
      const player = await client.loadPlayer().catch(() => null);
      state.data.cooldowns.breed = 0;
      await engine.breedForRarity(player);
      return tg.notify('🧬 Breeding the 2 strongest Adult/Elder creatures (chance of higher rarity → Legendary/Mythical).', menuMarkup);
    }

    case '/relic': {
      const player = await client.loadPlayer().catch(() => null);
      state.data.cooldowns.relic = 0;
      await engine.relicAutopilot(player);
      const owned = Array.isArray(player?.relics) ? player.relics.length : 0;
      return tg.notify(`💍 Relic processed (craft+equip). Owned: <b>${owned}</b>. Unlocks d_equip (+150 XP/day) & w_relics quests.`, menuMarkup);
    }

    case '/epoch': {
      const player = await client.loadPlayer().catch(() => null);
      state.data.cooldowns.epoch = 0;
      await engine.epochAutopilot(player);
      const e = await client.epoch().catch(() => null);
      const st = e?.epoch?.status || '-';
      return tg.notify(`🌌 Epoch processed. Status: <b>${esc(st)}</b> (donation only runs during the funding phase → $ZOLANA rebate).`, menuMarkup);
    }

    case '/companion': {
      const player = await client.loadPlayer().catch(() => null);
      state.data.cooldowns.companion = 0;
      await engine.companionAutopilot(player);
      return tg.notify('🐾 Companion set to the strongest creature (buffs whole-party raid & PvP power → higher dungeon floors).', menuMarkup);
    }

    case '/gemcraft': {
      const player = await client.loadPlayer().catch(() => null);
      state.data.cooldowns.gemcraft = 0;
      await engine.gemCraftAuto(player);
      const cat = (player?.materials || []).find((m) => m.material_id === 'gem_catalyst');
      return tg.notify(`💠 Gem craft processed (needs 5 gem_catalyst from dungeon floor 2+). Have: <b>${esc(cat?.quantity ?? 0)}</b>.`, menuMarkup);
    }

    case '/inventory':
    case '/backpack': {
      const data = await client.loadPlayer().catch((e) => ({ error: e.message }));
      if (data?.error) return tg.notify(`🎒 Failed to load: <code>${esc(data.error)}</code>`, menuMarkup);
      return tg.notify(tg.formatInventory(data), menuMarkup);
    }

    case '/creature':
    case '/creatures': {
      const data = await client.loadPlayer().catch((e) => ({ error: e.message }));
      if (data?.error) return tg.notify(`🐉 Failed to load: <code>${esc(data.error)}</code>`, menuMarkup);
      return tg.notify(tg.formatCreatures(data), menuMarkup);
    }

    case '/eggs': {
      const sol = await client.wallet.solBalance().catch(() => 0);
      return tg.notify([
        '<b>🥚 EGG CATALOG & QUALITY</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        '<b>Available now:</b>',
        '• <code>/buyegg basic</code> — 2.500 gold · Common 70 / Uncommon 30',
        '• <code>/buyegg forest</code> — 50.000 gold · Common 40 / Uncommon 40 / <b>Rare 20</b>',
        '',
        '<b>GOOD eggs (locked — unlock when $ZOLANA goes live / Phase 3):</b>',
        '• <code>/buyegg premium</code> — 50 gems · <b>Rare 50 / Epic 35 / Legendary 15</b> 🔥',
        '• <code>/buyegg golden</code> — 90 gems · Guaranteed Golden variant (5× gold)',
        '',
        '<b>Other good creature sources:</b> gacha (<code>/gacha</code>), breed (<code>/breed</code>, needs Adult), marketplace.',
        '',
        `ℹ️ Good eggs need <b>gems</b>. How to get gems: see <code>/fund</code>.`,
      ].join('\n'), menuMarkup);
    }

    case '/fund': {
      const sol = await client.wallet.solBalance().catch(() => 0);
      let token = null;
      try { token = await client.wallet.tokenBalance(); } catch { /* no ata */ }
      const lvl = state.data.lastPlayer?.level ?? '-';
      return tg.notify([
        '<b>💵 FUND THE ACCOUNT</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        'Deposit $ZOLANA / SOL to the bot wallet:',
        `<code>${esc(client.wallet.publicKey)}</code>`,
        `🪙 $ZOLANA sekarang: <b>${token ? esc(Math.round(token.uiAmount).toLocaleString('en-US')) : '0'}</b>   ◎ SOL: <b>${Number(sol).toFixed(4)}</b>`,
        '',
        '<b>Funding → power (most worthwhile first):</b>',
        `1️⃣ <b>Hold $ZOLANA</b> → daily gem stipend rises (10k hold≈9/day … 250k≈40/day). Needs account <b>Level 5</b> (now Lv ${esc(lvl)}). Gems → <code>/buyegg premium</code>.`,
        '2️⃣ <b>Dungeon</b> (auto) → gem_catalyst → <code>/gemcraft</code> = free gems.',
        '3️⃣ <b>$ZOLANA gacha</b> (<code>/gacha</code>) → pay token directly per pull (unlocks when token is live).',
        '',
        '💡 Most worth it: hold token for daily gems → premium egg (15% Legendary). The bot auto-buys premium eggs once gems ≥ 50 and the egg is unlocked.',
      ].join('\n'), menuMarkup);
    }

    case '/claim': {
      const player = await client.loadPlayer().catch(() => null);
      for (const k of ['holdClaim', 'epochClaim', 'afk']) state.data.cooldowns[k] = 0;
      await engine.freeClaims(player);
      await engine.afkFarm(player);
      await engine.safeAct('daily', () => client.claimDaily());
      await engine.safeAct('idleClaim', () => client.claimIdle());
      return tg.notify('🎁 All free rewards claimed (hold gems, epoch, dex, afk, daily, idle).', menuMarkup);
    }

    case '/afk': {
      // Manual: enter the AFK zone so creatures keep farming gold + stamina passively
      // while the PC/bot is offline. Banks any pending rewards first, then (re)starts
      // the session. (The autopilot also keeps the AFK zone active — this is an explicit
      // "I'm going offline now" convenience.)
      const collect = await client.afkCollect(false).catch(() => null); // bank + keep running
      const banked = Number(collect?.afkCollected || 0);
      const stamina = Number(collect?.afkStamina || 0);
      const start = await client.afkStart().catch((e) => ({ error: e.message }));
      if (start?.error && !collect) return tg.notify(`💤 AFK failed: <code>${esc(start.error)}</code>`, menuMarkup);
      state.count('afk:manual'); state.save();
      return tg.notify([
        '💤 <b>AFK ZONE ACTIVE</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        banked > 0 || stamina > 0 ? `🪙 Banked: <b>${esc(banked.toLocaleString('en-US'))}</b> gold · ⚡ <b>${esc(String(stamina))}</b> stamina` : '',
        'Your creatures now farm <b>gold + stamina</b> passively.',
        '✅ Safe to turn off your PC — rewards accumulate while offline (up to the game cap).',
        'Back online? Tap <code>/claim</code> to collect.',
      ].filter(Boolean).join('\n'), menuMarkup);
    }

    case '/slot': {
      const res = await client.buyPlaceSlot().catch((e) => ({ error: e.message }));
      if (res?.error) return tg.notify(`➕ Slot failed: <code>${res.error}</code>`, menuMarkup);
      await client.placeAuto(1).catch(() => {});
      return tg.notify('➕ Plot slot bought & creature placed.', menuMarkup);
    }

    case '/buyegg': {
      const type = args[0];
      // No arg → show the AUTO-buy toggle (what the user reaches for) + manual buy menu.
      // Requiring an explicit type also prevents an accidental gold purchase.
      if (!type) {
        const on = engine.toggle('buyegg', AUTO_DEFAULTS.buyegg);
        return tg.notify([
          '🥚 <b>Buy Egg</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `🤖 Auto-buy (gold eggs): <b>${on ? '🟢 ON' : '🔴 OFF'}</b>`,
          on
            ? 'Autopilot buys growth eggs with gold (basic/forest). Turn OFF to let gold pile up.'
            : 'Autopilot will NOT spend gold on eggs. Turn ON to auto-grow the roster.',
          '',
          'Or buy one manually below:',
        ].join('\n'), {
          reply_markup: {
            inline_keyboard: [
              [{ text: on ? '🔴 Turn Auto-buy OFF' : '🟢 Turn Auto-buy ON', callback_data: '/toggle buyegg' }],
              [{ text: '🥚 Basic · 2.5k gold', callback_data: '/buyegg basic' }, { text: '🌲 Forest · 50k gold', callback_data: '/buyegg forest' }],
              [{ text: '💎 Premium · 50 gems', callback_data: '/buyegg premium' }, { text: '🥇 Golden · 90 gems', callback_data: '/buyegg golden' }],
              [{ text: '⬅️ Back', callback_data: '/start' }],
            ],
          },
        });
      }
      const res = await client.buyEgg(type).catch((e) => ({ error: e.message }));
      return tg.notify(res?.error ? `🥚 Failed: <code>${res.error}</code>` : `🥚 Egg <b>${esc(type)}</b> bought.`, menuMarkup);
    }

    case '/buystamina': {
      // On-chain $ZOLANA purchase → full stamina. MANUAL only (token spend, zero-mistake
      // mandate: no autopilot auto-drains the wallet). Confirm-gated like /buygems.
      const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
      const cost = config.ZOLANA_STAMINA_ZENKO_COST;
      const readStamina = async () => {
        try { const p = await client.loadPlayer(); const a = (p.player || p).account || p.player || p; return Number(a.stamina); }
        catch { return null; }
      };

      if (args[0] === 'CONFIRM') {
        await tg.notify(`⚡ Restoring stamina — sending <b>${esc(fmtN(cost))}</b> $ZOLANA on-chain…`);
        const res = await client.staminaRestore('full').catch((e) => ({ error: e.message }));
        if (res?.error) return tg.notify(`⚡ Failed: <code>${esc(res.error)}</code>`, menuMarkup);
        state.count('buystamina'); state.save();
        const stam = await readStamina();
        logger.info({ spentZolana: cost }, 'stamina restored (on-chain)');
        return tg.notify([
          '⚡ <b>STAMINA RESTORED</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `Full stamina for <b>${esc(fmtN(cost))}</b> $ZOLANA`,
          stam != null ? `🔋 Stamina now: <b>${esc(stam)}</b>` : '',
          'Autopilot will now RAID with your strongest creatures.',
        ].filter(Boolean).join('\n'), menuMarkup);
      }

      const stam = await readStamina();
      const bal = await client.wallet.tokenBalance().catch(() => null);
      const autoOn = engine.toggle('autostamina', AUTO_DEFAULTS.autostamina);
      return tg.notify([
        '⚡ <b>Buy Stamina</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        stam != null ? `🔋 Current stamina: <b>${esc(stam)}</b>` : '',
        `💰 Cost: <b>${esc(fmtN(cost))}</b> $ZOLANA → <b>full</b> stamina (raid fuel)`,
        bal ? `👛 Your $ZOLANA: <b>${esc(fmtN(Math.floor(bal.uiAmount)))}</b>` : '',
        '',
        `🤖 Auto-buy when drained: <b>${autoOn ? '🟢 ON' : '🔴 OFF'}</b> (max ${esc(config.ZOLANA_AUTO_STAMINA_MAX_PER_DAY)}/day)`,
        autoOn
          ? 'Bot will auto-refill stamina to keep raiding, up to the daily cap.'
          : 'Turn ON to auto-refill + keep raiding (spends $ZOLANA — capped per day).',
        '',
        '⚠️ Real on-chain transaction.',
      ].filter(Boolean).join('\n'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: `⚡ Buy Full Now · ${fmtN(cost)} $ZOLANA`, callback_data: '/buystamina CONFIRM' }],
            [{ text: autoOn ? '🔴 Turn Auto-buy OFF' : '🟢 Turn Auto-buy ON', callback_data: '/toggle autostamina' }],
            [{ text: '⬅️ Back', callback_data: '/start' }],
          ],
        },
      });
    }

    case '/gacha': {
      if (args[2] !== 'CONFIRM') {
        let gems = 0;
        try { gems = Number((await client.loadPlayer())?.player?.gems ?? 0); } catch { /* snapshot */ }
        return tg.notify([
          '🎰 <b>Gacha</b> — RNG result (needs CONFIRM)',
          '━━━━━━━━━━━━━━━━━━━━',
          `💎 Your gems: <b>${esc(gems)}</b>`,
          '',
          '<b>Use GEMS (cheap, recommended):</b>',
          '• standard = 8 gems · deluxe = 15 gems',
          '',
          '<b>Use $ZOLANA token</b> (expensive ~99k/deluxe — only if gems run out):',
          '• pay token directly to treasury',
          '',
          'Deluxe drops 6 cards: materials + gold + relic + <b>high-rarity egg</b> 🔥',
        ].join('\n'), {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💎 Deluxe / 15 Gems', callback_data: '/gacha deluxe gems CONFIRM' }],
              [{ text: '🎰 Standard / 8 Gems', callback_data: '/gacha standard gems CONFIRM' }],
              [{ text: '🪙 Deluxe / $ZOLANA token', callback_data: '/gacha deluxe zenko CONFIRM' }],
              [{ text: '⬅️ Back', callback_data: '/start' }],
            ],
          },
        });
      }
      const tier = normalizeGachaTier(args[0] || 'deluxe');
      if (!tier) {
        return tg.notify('🎰 Unknown tier. Use <code>standard</code> or <code>deluxe</code>.', menuMarkup);
      }
      const currency = (args[1] || 'gems').toLowerCase();
      if (!['gems', 'zenko', 'zolana'].includes(currency)) {
        return tg.notify('🎰 Valid currency: <code>gems</code> or <code>zenko</code> ($ZOLANA token).', menuMarkup);
      }
      await tg.notify(`🎰 Pulling gacha <b>${esc(tier)}</b> (${esc(currency === 'gems' ? 'gems' : '$ZOLANA token')})…`);
      const res = await client.gachaPayAndPull(tier, currency).catch((e) => ({ error: e.message }));
      if (res?.error) {
        logger.warn({ tier, currency, message: res.error }, 'gacha failed');
        return tg.notify(`🎰 Failed: <code>${esc(res.error)}</code>`, menuMarkup);
      }
      state.count(`gacha:${tier}:${currency}`);
      if (res?.player) state.data.lastPlayer = engine.snapshotPlayer(res);
      state.save();
      const cards = formatGachaCards(res?.gacha);
      const cost = res?.gacha?.costGems ? `${res.gacha.costGems} gems` : (res?.gacha?.costZenko ? `${Number(res.gacha.costZenko).toLocaleString('en-US')} $ZOLANA` : '');
      logger.info({ tier, currency, cards: res?.gacha?.cards }, 'gacha ok');
      return tg.notify([
        `🎉 <b>GACHA ${esc(tier.toUpperCase())} — DAPAT:</b>`,
        cost ? `<i>cost ${esc(cost)}</i>` : '',
        '━━━━━━━━━━━━━━━━━━━━',
        cards || 'Result saved (check /inventory).',
      ].filter(Boolean).join('\n'), menuMarkup);
    }

    case '/buygems': {
      // Buy gems from the marketplace with $ZOLANA. Buying is NOT level-gated
      // (only SELLING needs Level 8), so this works at any level.
      const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
      const fmtUsd = (n) => `$${Number(n || 0).toFixed(Number(n) < 0.001 ? 6 : 2)}`;
      const gm = await client.market('gem').catch((e) => ({ error: e.message }));
      if (gm?.error) return tg.notify(`💎 Market fetch failed: <code>${esc(gm.error)}</code>`, menuMarkup);
      const price = Number(gm.zolanaPriceUsd || 0);
      const listings = (Array.isArray(gm.listings) ? gm.listings : [])
        .filter((l) => l.status === 'active' && l.item_kind === 'gem'
          && l.seller !== client.wallet.publicKey && Number(l.quantity) > 0)
        .map((l) => ({ id: l.id, qty: Number(l.quantity), usd: Number(l.price_usd) }))
        .map((l) => ({ ...l, unit: l.usd / Math.max(1, l.qty) }))
        .sort((a, b) => a.unit - b.unit);

      // --- Buy path: /buygems <listingId> CONFIRM ---
      if (args[1] === 'CONFIRM' && args[0]) {
        const chosen = listings.find((l) => l.id === args[0]);
        if (!chosen) return tg.notify('💎 That listing is gone (sold/expired). Send <code>/buygems</code> for the live list.', menuMarkup);
        const quote = await client.marketQuote(args[0]).catch((e) => ({ error: e.message }));
        if (quote?.error) return tg.notify(`💎 Quote failed: <code>${esc(quote.error)}</code>`, menuMarkup);
        const dec = Number(quote.decimals || 6);
        const costZ = Number(BigInt(quote.zolanaTotal)) / 10 ** dec;
        const bal = await client.wallet.tokenBalance().catch(() => null);
        if (bal && bal.uiAmount - costZ < config.ZOLANA_MARKET_ZOLANA_RESERVE) {
          return tg.notify(`💎 Not enough $ZOLANA: need <b>${esc(fmtN(Math.ceil(costZ)))}</b> + reserve <b>${esc(fmtN(config.ZOLANA_MARKET_ZOLANA_RESERVE))}</b>, balance <b>${esc(fmtN(Math.floor(bal.uiAmount)))}</b>.`, menuMarkup);
        }
        await tg.notify(`💎 Buying <b>${esc(chosen.qty)}</b> gems for <b>${esc(fmtN(Math.round(costZ)))}</b> $ZOLANA (${esc(fmtUsd(chosen.usd))})…`);
        const res = await client.marketBuyWithQuote(quote).catch((e) => ({ error: e.message }));
        if (res?.error) return tg.notify(`💎 Buy failed: <code>${esc(res.error)}</code>`, menuMarkup);
        state.count('buygems'); state.save();
        let gemsNow = null;
        try { gemsNow = Number((await client.loadPlayer())?.player?.gems); } catch { /* snapshot best-effort */ }
        logger.info({ listing: chosen.id, gems: chosen.qty, spentZolana: Math.round(costZ) }, 'gems bought on market');
        return tg.notify([
          '💎 <b>GEMS PURCHASED</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          `+<b>${esc(chosen.qty)}</b> gems for <b>${esc(fmtN(Math.round(costZ)))}</b> $ZOLANA (${esc(fmtUsd(chosen.usd))})`,
          gemsNow != null ? `💎 Balance now: <b>${esc(gemsNow)}</b> gems` : '',
          'Spend them on /gacha or /eggs.',
        ].filter(Boolean).join('\n'), menuMarkup);
      }

      // --- List path: show the gem shop with clear prices ---
      if (!listings.length) return tg.notify('💎 No gems on the market right now — try again later.', menuMarkup);
      const bal = await client.wallet.tokenBalance().catch(() => null);
      const lines = [
        '<b>💎 BUY GEMS</b> — pay with your $ZOLANA (no Level 8 needed)',
        '━━━━━━━━━━━━━━━━━━━━',
        bal ? `🪙 Your $ZOLANA: <b>${esc(fmtN(Math.floor(bal.uiAmount)))}</b> (${esc(fmtUsd(bal.uiAmount * price))})` : '',
        `💵 Floor: <b>${esc(fmtUsd(listings[0].unit))}</b>/gem  ·  💵 $ZOLANA ${esc(fmtUsd(price))}`,
        '<i>Tap a listing below to buy it instantly.</i>',
        '',
      ];
      const rows = [];
      for (const l of listings.slice(0, 6)) {
        const costZ = price ? l.usd / price : 0;
        lines.push(`• <b>${esc(l.qty)}</b> gems — <b>${esc(fmtUsd(l.usd))}</b> (${esc(fmtUsd(l.unit))}/gem) ≈ <b>${esc(fmtN(Math.round(costZ)))}</b> $ZOLANA`);
        rows.push([{ text: `💎 ${l.qty} gems · ${fmtUsd(l.usd)}`, callback_data: `/buygems ${l.id} CONFIRM` }]);
      }
      rows.push([{ text: '⬅️ Back', callback_data: '/start' }]);
      return tg.notify(lines.filter(Boolean).join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    case '/store': {
      const res = await client.storeState().catch((e) => ({ error: e.message }));
      if (res?.error) return tg.notify(`🛒 Store failed: <code>${res.error}</code>`, menuMarkup);
      const offers = Array.isArray(res?.offers) ? res.offers : Array.isArray(res) ? res : [];
      if (!offers.length) return tg.notify('🛒 Store empty / no offers.', menuMarkup);
      const lines = ['<b>🛒 GEM STORE</b>', '━━━━━━━━━━━━━━━━━━━━'];
      for (const o of offers.slice(0, 12)) {
        lines.push(`• <b>${esc(o.label || o.name || o.id)}</b> — ${esc(o.cost ?? o.price ?? '?')} ${esc(o.currency || '')}\n  <code>/buy ${esc(o.id)}</code>`);
      }
      return tg.notify(lines.join('\n'), menuMarkup);
    }

    case '/buy': {
      const id = args[0];
      if (!id) return tg.notify('Format: <code>/buy &lt;offerId&gt;</code>');
      const res = await client.storeBuy(id).catch((e) => ({ error: e.message }));
      return tg.notify(res?.error ? `🛒 Failed: <code>${res.error}</code>` : `🛒 Offer <code>${esc(id)}</code> bought.`, menuMarkup);
    }

    case '/listing':
    case '/listings': {
      const res = await client.marketMine().catch((e) => ({ error: e.message }));
      if (res?.error) return tg.notify(`📄 Failed: <code>${res.error}</code>`, menuMarkup);
      const items = Array.isArray(res?.listings) ? res.listings : [];
      if (!items.length) return tg.notify('📄 No active listings.', menuMarkup);
      const lines = ['<b>📄 LISTING SAYA</b>', '━━━━━━━━━━━━━━━━━━━━'];
      for (const it of items.slice(0, 15)) {
        const p = it.price_usd != null ? `$${it.price_usd}` : (it.price_gems != null ? `${it.price_gems}💎` : '?');
        lines.push(`• ${esc(it.item_kind || 'item')} — ${p}\n  <code>/cancel ${esc(it.id)}</code>`);
      }
      return tg.notify(lines.join('\n'), menuMarkup);
    }

    case '/cancel': {
      const id = args[0];
      if (!id) return tg.notify('Format: <code>/cancel &lt;listingId&gt;</code>');
      const res = await client.marketCancel(id).catch((e) => ({ error: e.message }));
      return tg.notify(res?.error ? `❌ Failed: <code>${res.error}</code>` : `❌ Listing <code>${esc(id)}</code> cancelled.`, menuMarkup);
    }

    case '/sell': {
      state.data.pendingSale = null; state.save();
      const summary = state.data.market?.summary || {};
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load inventory (game offline/maintenance?). Try again.', menuMarkup); }
      const acct = player.player || player;

      // Per-material floor (only market source that carries per-resource unit price).
      const matFloor = {};
      try {
        const mb = await client.market('material', { sort: 'cheap', limit: 50 });
        for (const l of (mb?.listings || [])) {
          const r = l.resource; const u = Number(l.price_usd) / Math.max(1, Number(l.quantity || 1));
          if (r && Number.isFinite(u) && u > 0) matFloor[r] = Math.min(matFloor[r] ?? Infinity, u);
        }
      } catch { /* fall back to placeholder prices */ }

      const rows = [];
      const price = (kind, resource) => sellUnitFloor(summary, kind, matFloor, resource) * 0.97;

      // 💰 Gold
      const gold = Number(acct.gold || 0);
      if (gold > 1000) {
        const q = Math.min(gold - 1000, 300000);
        rows.push([{ text: `💰 Gold ×${short(q)} · ~$${(price('gold') * q).toFixed(2)}`, callback_data: `/sp g all` }]);
      }
      // ⛏️ Materials (any stack ≥ 50)
      for (const m of (player.materials || []).filter((x) => Number(x.quantity) >= 50).slice(0, 6)) {
        const q = Math.min(Number(m.quantity), 2000);
        rows.push([{ text: `⛏️ ${m.material_id} ×${short(m.quantity)} · ~$${(price('material', m.material_id) * q).toFixed(3)}`, callback_data: `/sp m ${m.material_id}` }]);
      }
      // 🎀 Cosmetics (tradeable, not equipped/listed/stored) — pure vanity = free profit
      for (const c of (player.cosmetics || []).filter((x) => x.tradeable && !x.equipped && !x.listed && !x.stored).slice(0, 6)) {
        rows.push([{ text: `🎀 ${c.cosmetic_id} ${c.rarity} · ~$${price('cosmetic').toFixed(2)}`, callback_data: `/sp k ${c.id}` }]);
      }
      // 💍 Relics (not equipped/bound/soulbound/listed/stored)
      for (const r of (player.relics || []).filter((x) => !x.equipped_on && !x.bound && !x.soulbound && !x.listed && !x.stored).slice(0, 8)) {
        rows.push([{ text: `💍 ${r.base_id} ${r.rarity} · ~$${price('relic').toFixed(2)}`, callback_data: `/sp r ${r.id}` }]);
      }
      // 🐾 Creatures (Common surplus only in quick-list — protects producers/breeders)
      for (const c of (player.creatures || []).filter((x) => x.rarity === 'Common' && !x.listed && !x.stored && !x.run_id).slice(0, 8)) {
        rows.push([{ text: `🐾 ${c.creature_id} ${c.stage} · ~$${price('creature').toFixed(2)}`, callback_data: `/sp c ${c.id}` }]);
      }
      // 🥚 Eggs (unhatched, not listed) — all types; user decides
      for (const e of (player.eggs || []).filter((x) => x.status !== 'hatched' && !x.creature_id && !x.listed).slice(0, 6)) {
        rows.push([{ text: `🥚 ${e.egg_type} egg · ~$${price('egg').toFixed(2)}`, callback_data: `/sp e ${e.id}` }]);
      }

      if (!rows.length) return tg.notify('🏷️ <b>Nothing sellable right now.</b>\nGrind a bit — surplus gold/materials/creatures will show up here.', menuMarkup);
      rows.push([{ text: '📄 My Listings', callback_data: '/listings' }, { text: '⬅️ Back', callback_data: '/market' }]);
      return tg.notify([
        '<b>🏷️ SELL — tap an item</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        '<i>Prices shown are the market floor. After tapping you can confirm or set your own price/qty.</i>',
      ].join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    // Pick an item to sell: /sp <t> <ref>  (t = g|m|k|r|c|e)
    case '/sp': {
      const map = { g: 'gold', m: 'material', k: 'cosmetic', r: 'relic', c: 'creature', e: 'egg' };
      const kind = map[args[0]];
      const ref = args[1];
      if (!kind || !ref) return tg.notify('❌ Bad selection. Open /sell again.', menuMarkup);
      const summary = state.data.market?.summary || {};
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load inventory. Try again.', menuMarkup); }
      const acct = player.player || player;

      let name = kind; let unit = 0; let needsQty = false; let qtyDefault = 1; let maxQty = 1;
      if (kind === 'gold') {
        const gold = Number(acct.gold || 0);
        if (gold <= 1000) return tg.notify('❌ Not enough gold to sell.', menuMarkup);
        needsQty = true; maxQty = gold; qtyDefault = Math.min(gold - 1000, 300000);
        unit = sellUnitFloor(summary, 'gold') * 0.97; name = 'Gold';
      } else if (kind === 'material') {
        const held = (player.materials || []).find((m) => m.material_id === ref);
        if (!held) return tg.notify(`❌ Material <code>${esc(ref)}</code> not found.`, menuMarkup);
        const matFloor = {};
        try {
          const mb = await client.market('material', { sort: 'cheap', limit: 50 });
          for (const l of (mb?.listings || [])) { const u = Number(l.price_usd) / Math.max(1, Number(l.quantity || 1)); if (l.resource && u > 0) matFloor[l.resource] = Math.min(matFloor[l.resource] ?? Infinity, u); }
        } catch { /* placeholder */ }
        needsQty = true; maxQty = Number(held.quantity); qtyDefault = Math.min(maxQty, 2000);
        unit = sellUnitFloor(summary, 'material', matFloor, ref) * 0.97; name = ref;
      } else {
        const pool = kind === 'cosmetic' ? player.cosmetics : kind === 'relic' ? player.relics : kind === 'creature' ? player.creatures : player.eggs;
        const it = (pool || []).find((x) => x.id === ref);
        if (!it) return tg.notify(`❌ ${esc(kind)} not found (maybe already sold).`, menuMarkup);
        unit = sellUnitFloor(summary, kind) * 0.97; name = itemLabel(kind, it);
      }

      const total = needsQty ? unit * qtyDefault : unit;
      state.data.pendingSale = { kind, ref, name, unit, needsQty, qtyDefault, maxQty, ts: Date.now() };
      state.save();
      const priceStr = `$${total.toFixed(total < 0.01 ? 4 : 2)}`;
      const lines = [
        `<b>🏷️ Sell: ${esc(name)}</b>`,
        '━━━━━━━━━━━━━━━━━━━━',
        needsQty ? `Suggested: <b>${priceStr}</b> for <b>${short(qtyDefault)}</b> (floor price).` : `Suggested price: <b>${priceStr}</b> (floor).`,
        '',
        needsQty
          ? `✍️ Or type your own: <code>&lt;total$&gt; &lt;qty&gt;</code>  (e.g. <code>0.20 ${qtyDefault}</code>)`
          : '✍️ Or type your own price, e.g. <code>0.25</code>',
      ];
      const rows = [
        [{ text: `✅ List at ${priceStr}`, callback_data: '/sg' }],
        [{ text: '✖️ Cancel', callback_data: '/sell' }],
      ];
      return tg.notify(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    // Confirm sale at the suggested price/qty.
    case '/sg': {
      const ps = state.data.pendingSale;
      if (!ps) return tg.notify('❌ Nothing pending. Open /sell.', menuMarkup);
      state.data.pendingSale = null; state.save();
      const total = ps.needsQty ? ps.unit * ps.qtyDefault : ps.unit;
      return performList(client, tg, sellPayload(ps, total, ps.qtyDefault));
    }

    case '/leaderboard': {
      const res = await client.leaderboards().catch((e) => ({ error: e.message }));
      if (res?.error) return tg.notify(`🏆 Failed: <code>${res.error}</code>`, menuMarkup);
      const rows = Array.isArray(res?.leaderboard) ? res.leaderboard : Array.isArray(res) ? res : [];
      if (!rows.length) return tg.notify('🏆 Leaderboard empty.', menuMarkup);
      const lines = ['<b>🏆 LEADERBOARD</b>', '━━━━━━━━━━━━━━━━━━━━'];
      rows.slice(0, 10).forEach((r, i) => lines.push(`${i + 1}. ${esc(r.username || r.name || r.wallet)} — ${esc(r.score ?? r.level ?? '')}`));
      return tg.notify(lines.join('\n'), menuMarkup);
    }

    case '/deposit': {
      const balance = await client.wallet.solBalance().catch(() => 0);
      return tg.notify([
        '<b>📥 DEPOSIT</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        `Address:\n<code>${esc(client.wallet.publicKey)}</code>`,
        `◎ SOL balance: <b>${Number(balance).toFixed(6)}</b>`,
        '',
        'Send SOL to this address for gas & market actions.',
      ].join('\n'), menuMarkup);
    }

    case '/genwallet': {
      const wallet = generateWallet();
      fs.mkdirSync('data/generated-wallets', { recursive: true });
      const file = `data/generated-wallets/${wallet.publicKey}.json`;
      fs.writeFileSync(file, JSON.stringify({
        publicKey: wallet.publicKey,
        privateKey: wallet.privateKey,
        secretKey: wallet.json,
        createdAt: new Date().toISOString(),
      }, null, 2), { mode: 0o600 });
      fs.chmodSync(file, 0o600);

      const showPrivate = args[0] === 'SHOW_PRIVATE' && args[1] === 'CONFIRM';
      const lines = [
        '<b>🧾 GENERATED WALLET</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        `Address:\n<code>${esc(wallet.publicKey)}</code>`,
        `Saved local:\n<code>${esc(file)}</code>`,
      ];
      if (showPrivate) {
        lines.push('', `Private key:\n<code>${esc(wallet.privateKey)}</code>`);
      } else {
        lines.push('', 'Private key not shown in chat.');
        lines.push('If you really need to show it:');
        lines.push('<code>/genwallet SHOW_PRIVATE CONFIRM</code>');
      }
      return tg.notify(lines.join('\n'), menuMarkup);
    }

    case '/sendfee': {
      const [amount, destination, confirm] = args;
      if (!amount || !destination || confirm !== 'CONFIRM') {
        return tg.notify([
          '<b>💸 SEND SOL FEE</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          'Format:',
          '<code>/sendfee &lt;amount_SOL&gt; &lt;destination_wallet&gt; CONFIRM</code>',
          '',
          `Max sekali kirim: <b>${config.ZOLANA_MAX_WITHDRAW_SOL}</b> SOL`,
          `Reserve: <b>${config.ZOLANA_WITHDRAW_MIN_SOL_RESERVE}</b> SOL`,
        ].join('\n'), menuMarkup);
      }
      const signature = await client.wallet.withdrawSol(amount, destination).catch((e) => ({ error: e.message }));
      if (signature?.error) return tg.notify(`💸 Send fee failed: <code>${esc(signature.error)}</code>`, menuMarkup);
      return tg.notify(`💸 SOL fee sent:\n<code>${esc(signature)}</code>`, menuMarkup);
    }

    case '/sendzolana': {
      const [amount, destination, confirm] = args;
      if (!amount || !destination || confirm !== 'CONFIRM') {
        return tg.notify([
          '<b>🪙 SEND $ZOLANA</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          'Format:',
          '<code>/sendzolana &lt;amount_ZOLANA&gt; &lt;destination_wallet&gt; CONFIRM</code>',
          '',
          `Reserve default: <b>${config.ZOLANA_MARKET_ZOLANA_RESERVE}</b> $ZOLANA`,
        ].join('\n'), menuMarkup);
      }
      const signature = await client.wallet.transferToken(amount, destination).catch((e) => ({ error: e.message }));
      if (signature?.error) return tg.notify(`🪙 Send $ZOLANA failed: <code>${esc(signature.error)}</code>`, menuMarkup);
      return tg.notify(`🪙 $ZOLANA sent:\n<code>${esc(signature)}</code>`, menuMarkup);
    }

    case '/sweep': {
      const [destination, sweepAll, confirm] = args;
      if (!destination || sweepAll !== 'SWEEP_ALL' || confirm !== 'CONFIRM') {
        return tg.notify([
          '<b>🧹 SWEEP $ZOLANA</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          'Send all $ZOLANA from this bot wallet to a destination.',
          '',
          'Format:',
          '<code>/sweep &lt;destination_wallet&gt; SWEEP_ALL CONFIRM</code>',
          '',
          'For the main account, only use this if you really want to empty the token.',
        ].join('\n'), menuMarkup);
      }
      const signature = await client.wallet.sweepToken(destination).catch((e) => ({ error: e.message }));
      if (signature?.error) return tg.notify(`🧹 Sweep failed: <code>${esc(signature.error)}</code>`, menuMarkup);
      return tg.notify(`🧹 $ZOLANA swept:\n<code>${esc(signature)}</code>`, menuMarkup);
    }

    case '/withdrawal':
    case '/withdraw': {
      const [amount, destination, confirm] = args;
      if (!amount || !destination || confirm !== 'CONFIRM') {
        return tg.notify('Format: <code>/withdrawal &lt;amount_SOL&gt; &lt;destination_wallet&gt; CONFIRM</code>');
      }
      const signature = await client.wallet.withdrawSol(amount, destination).catch((e) => ({ error: e.message }));
      if (signature?.error) return tg.notify(`📤 Failed: <code>${signature.error}</code>`, menuMarkup);
      return tg.notify(`📤 Withdrawal sent:\n<code>${esc(signature)}</code>`, menuMarkup);
    }

    default:
      return; // ignore non-commands / chatter
  }
}

function esc(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// Compact number for button labels: 12345 -> "12.3k".
function short(n) {
  const v = Number(n || 0);
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

// Market floor per unit for a sell kind (fallbacks when no market data cached).
const SELL_FALLBACK = { creature: 0.03, egg: 0.05, cosmetic: 0.15, relic: 0.05, gem: 0.2 };
function sellUnitFloor(summary, kind, matFloor, resource) {
  if (kind === 'material') return matFloor?.[resource] || 0.0005;
  if (kind === 'gold') { const f = Number(summary?.gold?.floorUnitUsd); return f > 0 ? f : 1 / 320000; }
  const f = Number(summary?.[kind]?.floorUnitUsd);
  return f > 0 ? f : (SELL_FALLBACK[kind] || 0.05);
}

// Human label for an inventory item, per kind.
function itemLabel(kind, o) {
  if (!o) return kind;
  switch (kind) {
    case 'creature': return `${o.creature_id} ${o.rarity || ''}/${o.stage || ''}`;
    case 'egg': return `${o.egg_type} egg`;
    case 'relic': return `${o.base_id} ${o.rarity || ''}`;
    case 'cosmetic': return `${o.cosmetic_id} (${o.slot || ''})`;
    default: return kind;
  }
}

// Build a /api/market/list payload from a pending sale + chosen price/qty.
function sellPayload(ps, priceUsd, qty) {
  const p = { itemKind: ps.kind, currency: 'zenko', priceUsd: Number(priceUsd) };
  if (ps.needsQty) { p.quantity = Math.floor(qty); if (ps.kind === 'material') p.resource = ps.ref; }
  else { p.itemId = ps.ref; }
  return p;
}

// Execute a market listing and reply with a clear confirmation.
async function performList(client, tg, payload) {
  const menuMarkup = { reply_markup: tg.mainKeyboard() };
  const res = await client.marketList(payload).catch((e) => ({ error: e.message }));
  if (res?.error) return tg.notify(`❌ List failed: <code>${esc(res.error)}</code>`, menuMarkup);
  const qtyStr = payload.quantity ? ` ×${Number(payload.quantity).toLocaleString('en-US')}` : '';
  return tg.notify([
    '🏷️ <b>LISTED ON MARKET!</b>',
    `${esc(payload.resource || payload.itemKind)}${qtyStr} — <b>$${payload.priceUsd}</b>`,
    "You'll get a 💰 alert when it sells.",
    'Manage: /listings · cancel with <code>/cancel &lt;id&gt;</code>',
  ].join('\n'), menuMarkup);
}

// Send any messages the strategy queued during the cycle (e.g. autopilot gacha drops).
async function drainNotifications(telegram, state) {
  const queue = Array.isArray(state.data.notify) ? state.data.notify : [];
  if (!queue.length) return;
  state.data.notify = [];
  state.save();
  for (const item of queue) {
    if (item?.type === 'gacha') {
      const cards = formatGachaCards(item.gacha);
      if (cards) await telegram.notify(`🎰 <b>Auto-gacha ${esc(item.gacha?.tier || '')} — GOT:</b>\n━━━━━━━━━━━━━━━━━━━━\n${cards}`);
    } else if (item?.text) {
      await telegram.notify(item.text);
    }
  }
}

// Crash guards: a stray async error must never kill the long-running bot. Log and
// keep going (systemd also restarts on a real exit, but we prefer to stay up).
process.on('unhandledRejection', (reason) => {
  logger.error({ message: reason?.message || String(reason) }, 'unhandledRejection (ignored)');
});
process.on('uncaughtException', (error) => {
  logger.error({ message: error?.message || String(error) }, 'uncaughtException (ignored)');
});

main().catch((error) => {
  // Only hard-exit on setup errors (bad key/config); systemd will restart transient ones.
  if (error.message.includes('ZOLANA_PRIVATE_KEY')) {
    logger.error({ message: error.message }, 'setup incomplete');
    process.exit(1);
  }
  logger.fatal({ message: error.message }, 'bot crashed — systemd will restart');
  process.exit(1);
});
