import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import { config } from './config.js';
import { logger } from './logger.js';
import { generateWallet, loadWallet } from './wallet.js';
import { ZolanaClient } from './client.js';
import { BotState } from './state.js';
import { StrategyEngine } from './strategy.js';
import { TelegramBot, formatGachaCards, eggState } from './telegram.js';

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

const AUTO_KEYS = new Set(['realrun', 'afk', 'claims', 'quests', 'dungeon', 'evolve', 'breed', 'gacha', 'premiumEgg', 'gemcraft', 'buyegg', 'autostamina', 'relic', 'relicEnhance', 'relicDismantle', 'companion', 'epoch', 'pvp', 'slots', 'marketBuy', 'marketSell', 'raidnotify']);
const AUTO_DEFAULTS = {
  realrun: config.ZOLANA_REAL_RUN,
  raidnotify: config.ZOLANA_RAID_NOTIFY,
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
  relicDismantle: config.ZOLANA_AUTO_RELIC_DISMANTLE,
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
      return performList(client, tg, sellPayload(ps, nums[0], qty), engine);
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
        [{ text: '🛒 Buy Items', callback_data: '/mbuy' }, { text: '🏷️ Sell My Items', callback_data: '/sell' }],
        [{ text: '📄 My Listings', callback_data: '/listings' }, { text: '💎 Gems', callback_data: '/gems' }],
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

    case '/history': {
      const h = Array.isArray(state.data.history) ? state.data.history : [];
      if (!h.length) return tg.notify('📜 <b>No history yet.</b>\nEvents (sales, hatches, new eggs, sacrifices…) will appear here.', menuMarkup);
      const lines = ['<b>📜 ACTIVITY HISTORY</b>', '━━━━━━━━━━━━━━━━━━━━'];
      for (const e of h.slice(-20).reverse()) {
        const hh = new Date(e.t).toISOString().slice(11, 16);
        lines.push(`<code>${hh}</code>  ${esc(e.text)}`);
      }
      lines.push('', '<i>Times in UTC · newest first</i>');
      return tg.notify(lines.join('\n'), menuMarkup);
    }

    case '/once':
      await tg.notify('▶️ Running one cycle…');
      await engine.cycle();
      return tg.notify(tg.formatStatus(state.data.lastPlayer, state.data.market), menuMarkup);

    case '/pause':
    case '/stop':
      state.data.paused = true; state.save();
      return tg.notify('⏸ Autopilot <b>STOPPED</b> — all actions halted (farm, raid, evolve, relic, market). Safe to play manually on the website. Tap /resume when done.', {
        reply_markup: { inline_keyboard: [[{ text: '▶️ Resume bot', callback_data: '/resume' }], [{ text: '🏠 Home', callback_data: '/start' }]] },
      });

    case '/resume':
    case '/startbot':
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
      const now = !current;
      if (key === 'realrun') {
        const note = now
          ? '⚡ <b>REAL-RUN → 🟢 ON</b>\nBot sekarang eksekusi aksi beneran (raid, evolve, craft, on-chain). Butuh stamina + creature buat mulai raid.'
          : '🛑 <b>REAL-RUN → 🔴 OFF</b>\nMode dry-run — bot jalan tapi TIDAK eksekusi apa pun (raid/craft/on-chain di-skip).';
        return tg.notify(note, { reply_markup: tg.autoKeyboard(engine) });
      }
      return tg.notify(`⚙️ <b>${key}</b> → ${now ? '🟢 ON' : '🔴 OFF'}`, {
        reply_markup: tg.autoKeyboard(engine),
      });
    }

    case '/pvp': {
      // PvP needs a 3-Elder lineup (server rule). Panel: status + set team + attack.
      const rankMap = { Common: 1, Uncommon: 2, Rare: 3, Epic: 4, Legendary: 5, Mythical: 6 };
      const pvp = await client.pvp().catch((e) => ({ error: e.message }));
      if (pvp?.error) return tg.notify(`⚔️ PvP load failed: <code>${esc(pvp.error)}</code>`, menuMarkup);
      const me = pvp?.me || {};
      const player = await client.loadPlayer().catch(() => null);
      const elders = (player?.creatures || [])
        .filter((c) => c.stage === 'Elder' && !c.listed && !c.stored)
        .sort((a, b) => (rankMap[b.rarity] || 0) - (rankMap[a.rarity] || 0) || (b.level || 0) - (a.level || 0));
      const tickets = Number(me.tickets ?? 0);
      const teamSet = Number(me.power || 0) > 0 || (me.teamDisplay || []).length >= 3;

      if (args[0] === 'team') {
        if (elders.length < 3) return tg.notify(`⚔️ Need <b>3</b> Elders — you have <b>${elders.length}</b>.`, menuMarkup);
        const team = elders.slice(0, 3).map((c, idx) => ({ rowId: c.id, formation: idx === 1 ? 'front' : 'back' }));
        const res = await client.pvpTeam(team).catch((e) => ({ error: e.message }));
        if (res?.error) return tg.notify(`⚔️ Set team failed: <code>${esc(res.error)}</code>`, menuMarkup);
        return tg.notify(`⚔️ <b>Team set!</b> ${esc(elders.slice(0, 3).map((c) => c.creature_id).join(', '))} — center = FRONT tank. Also your defense team (passive points when attackers lose).`, { reply_markup: { inline_keyboard: [[{ text: '⚔️ Attack now', callback_data: '/pvp attack' }], [{ text: '⬅️ PvP', callback_data: '/pvp' }]] } });
      }
      if (args[0] === 'attack') {
        if (tickets < 1) return tg.notify(`⚔️ No tickets — +1 in ~${Math.round((me.regenMs || 8640000) / 3600000)}h.`, menuMarkup);
        await tg.notify('⚔️ Finding an opponent…');
        const res = await client.pvpMatch().catch((e) => ({ error: e.message }));
        if (res?.error) return tg.notify(`⚔️ Attack failed: <code>${esc(res.error)}</code>`, menuMarkup);
        const won = res?.pvp?.result === 'win' || res?.won === true;
        state.count('pvp'); state.save();
        return tg.notify(`⚔️ <b>${won ? '🏆 VICTORY' : 'Battle done'}</b> — ${tickets - 1}🎟️ left.`, { reply_markup: { inline_keyboard: [[{ text: `⚔️ Attack again (${tickets - 1}🎟️)`, callback_data: '/pvp attack' }], [{ text: '⬅️ PvP', callback_data: '/pvp' }]] } });
      }

      const lines = [
        '⚔️ <b>PvP ARENA</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        `🏅 Tier: <b>${esc(me.tier || '-')}</b> · Rank <b>#${me.rank ?? '-'}</b> · Points <b>${me.points ?? 0}</b>`,
        `📊 W-L: <b>${me.wins ?? 0}</b>–<b>${me.losses ?? 0}</b> · Defense wins ${me.defenseWins ?? 0}`,
        `🎟️ Tickets: <b>${tickets}/${me.ticketCap ?? 10}</b> (regen ~${Math.round((me.regenMs || 8640000) / 3600000)}h each)`,
        `👥 Team: ${teamSet ? `✅ set (power ${me.power || 0})` : '❌ <b>not set</b>'}`,
        '',
        elders.length >= 3
          ? `🐉 <b>${elders.length}</b> Elders ready — top 3: ${esc(elders.slice(0, 3).map((c) => `${c.creature_id} L${c.level}`).join(', '))}`
          : `⚠️ <b>Need 3 Elders</b> to compete — you have <b>${elders.length}</b>. Auto-evolve is pushing your strongest toward Elder.`,
      ];
      const rows = [];
      if (elders.length >= 3) rows.push([{ text: teamSet ? '👥 Update Team' : '👥 Set Team', callback_data: '/pvp team' }]);
      if (teamSet && tickets >= 1) rows.push([{ text: `⚔️ Attack (${tickets}🎟️)`, callback_data: '/pvp attack' }]);
      rows.push([{ text: '🔄 Refresh', callback_data: '/pvp' }, { text: '🏠 Home', callback_data: '/start' }]);
      return tg.notify(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    case '/dungeon': {
      const player = await client.loadPlayer().catch(() => null);
      await engine.dungeonRun(player);
      return tg.notify('🏰 Dungeon: start/claim processed (see /stats).', menuMarkup);
    }

    case '/evolve': {
      const player = await client.loadPlayer().catch(() => null);
      if (!player) return tg.notify('❌ Could not load creatures (game offline?). Try again.', menuMarkup);
      const now = Date.now();
      // Only creatures the rarity gate actually allows to evolve (Common skipped,
      // Adult→Elder Epic/Legendary+ only) — so the list matches what the button does.
      const all = (player.creatures || [])
        .map((c) => ({ c, st: evolveStatus(c, now) }))
        .filter((x) => x.st);
      const eligible = all.filter((x) => evolveAllowedUI(x.st.stage, x.c.rarity));
      const skippedN = all.length - eligible.length;

      if (args[0] === 'GO') {
        state.data.cooldowns.evolve = 0;
        await engine.evolveBest(player, true); // force: run even though auto-evolve is toggled OFF
        return tg.notify('🧬 Evolving all <b>ready</b> creatures now (Common skipped · Adult→Elder Epic/Legendary only · within gold budget).', menuMarkup);
      }

      if (!eligible.length) {
        return tg.notify([
          '<b>🧬 EVOLVE</b>', '━━━━━━━━━━━━━━━━━━━━',
          'No eligible creatures pending evolution.',
          skippedN ? `<i>(${skippedN} eligible-by-timer but skipped by rarity rule.)</i>` : '',
          '', '🌱 Keep creatures placed/raiding so they gain XP and climb Baby→Juvenile→Adult→Elder.',
          '💡 Rule: Common never evolves · Adult→Elder = <b>Epic/Legendary only</b>.',
        ].filter(Boolean).join('\n'), menuMarkup);
      }

      // Advanced-first (closest to Elder), then soonest-ready.
      eligible.sort((a, b) =>
        (EVOLVE_STAGES.indexOf(b.st.stage) - EVOLVE_STAGES.indexOf(a.st.stage))
        || (a.st.remainSec - b.st.remainSec));
      const gold = Number((player.player || {}).gold || 0);
      const readyN = eligible.filter((x) => x.st.timeReady || x.st.xpReady).length;
      const lines = [
        '<b>🧬 EVOLVE STATUS</b>', '━━━━━━━━━━━━━━━━━━━━',
        `🪙 Gold: <b>${short(gold)}</b>   ✅ Ready: <b>${readyN}</b>/${eligible.length}`, '',
      ];
      for (const { c, st } of eligible.slice(0, 15)) {
        let when;
        if (st.timeReady) when = '✅ <b>Ready now</b>';
        else if (st.xpReady) when = `⚡ XP-skip ready (${st.xp}/${st.skipXp} xp)`;
        else when = `⏳ <b>${fmtDur(st.remainSec)}</b> · xp ${st.xp}/${st.skipXp}`;
        lines.push(`${RARITY_EMOJI2[c.rarity] || ''} <b>${esc(c.creature_id)}</b> ${c.rarity} · ${st.stage}→${st.next}`);
        lines.push(`   ${when} · cost ${short(st.cost)} gold`);
      }
      if (eligible.length > 15) lines.push(`<i>…and ${eligible.length - 15} more</i>`);
      if (skippedN) lines.push('', `<i>⚪ ${skippedN} skipped by rarity rule (Common, or non-Epic/Leg at Adult).</i>`);
      const rows = [];
      if (readyN) rows.push([{ text: `🧬 Evolve ${readyN} ready now`, callback_data: '/evolve GO' }]);
      rows.push([{ text: '🔄 Refresh', callback_data: '/evolve' }, { text: '⬅️ Back', callback_data: '/start' }]);
      return tg.notify(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    case '/quests': {
      const player = await client.loadPlayer().catch(() => null);
      state.data.cooldowns.quests = 0;
      await engine.claimQuests(player);
      return tg.notify('📜 Claimed all completed quests (+150 account XP each).', menuMarkup);
    }

    // 🧬 Breed — manual picker. Both parents must be Adult/Elder + idle + off cooldown.
    // Offspring rarity = min(parent rarity)+1 (up to Legendary), delivered as a Mystery Egg.
    case '/breed': {
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load creatures (game offline?). Try again.', menuMarkup); }
      const now = Date.now();
      const breedables = (player.creatures || []).filter((c) => isBreedable(c, now))
        .sort((a, b) => creatureValue(b) - creatureValue(a));
      const gold = Number((player.player || {}).gold || 0);

      if (breedables.length < 2) {
        const adults = (player.creatures || []).filter((c) => ['Adult', 'Elder'].includes(c.stage)).length;
        return tg.notify([
          '<b>🧬 BREED</b>', '━━━━━━━━━━━━━━━━━━━━',
          `You need <b>2 idle Adult/Elder</b> creatures. Ready now: <b>${breedables.length}</b>.`,
          adults > breedables.length ? `<i>(${adults} are Adult+ but raiding, on the 25-min breed cooldown, or happiness &lt;50. Farming/placed ones CAN breed.)</i>` : '',
          '', '🌱 <b>How to get Adults:</b> keep creatures placed/raiding so they gain XP and evolve (Baby→Juvenile→Adult). Auto-evolve is on.',
          '💡 Offspring = <b>one rarity above the weaker parent</b> (up to Legendary), as a Mystery Egg.',
        ].filter(Boolean).join('\n'), menuMarkup);
      }

      // Recommend the best pair (highest offspring tier, then success, then cost).
      const ranked = bestBreedPairs(breedables);
      const lines = ['<b>🧬 BREED — pick parent 1</b>', '━━━━━━━━━━━━━━━━━━━━', `🪙 Gold: <b>${short(gold)}</b>`];
      const rows = [];
      if (ranked.length) {
        const top = ranked[0];
        const p = top.plan;
        lines.push('', `⭐ <b>Best pair:</b> ${RARITY_EMOJI2[top.a.rarity]}${esc(top.a.creature_id)}(${elementOf(top.a) || '?'}) × ${RARITY_EMOJI2[top.b.rarity]}${esc(top.b.creature_id)}(${elementOf(top.b) || '?'})`,
          `   → ${RARITY_EMOJI2[p.result]} <b>${p.result}</b>${p.hybrid ? ' (hybrid)' : ''} · ${Math.round(p.success * 100)}% · ${short(p.cost)} gold`);
        rows.push([{ text: `⭐ Best: ${top.a.creature_id}×${top.b.creature_id} → ${p.result}`.slice(0, 55), callback_data: `/bx ${bShort(top.a.id)} ${bShort(top.b.id)}` }]);
      } else {
        lines.push('', '⚠️ <b>No compatible pairs.</b> Elements must match:',
          '<i>Terra↔Flora · Aqua↔Aero/Flora · Ignis↔Aero · Void↔Lux · or same element.</i>');
      }
      lines.push('', '<i>…or pick parent 1 yourself:</i>');
      for (const c of breedables.slice(0, 8)) {
        rows.push([{ text: `${RARITY_EMOJI2[c.rarity]} ${c.creature_id}(${elementOf(c) || '?'}) ${c.stage} L${c.level}`.slice(0, 58), callback_data: `/bp ${bShort(c.id)}` }]);
      }
      // v0.18: bred-out creatures (8/8) — offer Renew (gems) to reset the breed count.
      const bredOut = (player.creatures || []).filter((c) => ['Adult', 'Elder'].includes(c.stage) && isBredOut(c) && !c.listed && !c.stored);
      if (bredOut.length) {
        lines.push('', `🔄 <b>Bred-out (8/8):</b> ${bredOut.length} — tap to Renew with gems:`);
        for (const c of bredOut.slice(0, 5)) {
          const cost = RENEW_GEM_COST[c.rarity] ?? 5;
          rows.push([{ text: `🔄 ${RARITY_EMOJI2[c.rarity]} ${c.creature_id} — Renew ${cost}💎`.slice(0, 58), callback_data: `/brenew ${bShort(c.id)}` }]);
        }
      }
      rows.push([{ text: '⬅️ Back', callback_data: '/start' }]);
      return tg.notify(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    // v0.18 Breed Renew — reset a bred-out (8/8) creature's breed_count for gems.
    case '/brenew': {
      const [short8, go] = args;
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load creatures. Try again.', menuMarkup); }
      const c = findByShort(player, short8);
      if (!c) return tg.notify('❌ Creature not found. Open /breed.', menuMarkup);
      const cost = RENEW_GEM_COST[c.rarity] ?? 5;
      const gems = Number((player.player || {}).gems || 0);
      if (go === 'GO') {
        if (gems < cost) return tg.notify(`❌ Need <b>${cost}</b>💎 to renew (you have ${gems}).`, menuMarkup);
        const res = await client.breedRenew(c.id).catch((e) => ({ error: e.message }));
        if (res?.error) return tg.notify(`❌ Renew failed: <code>${esc(res.error)}</code>`, menuMarkup);
        logHistory(state, `🔄 Renewed ${c.creature_id} breed count (−${cost}💎)`);
        return tg.notify(`🔄 <b>RENEWED!</b> ${RARITY_EMOJI2[c.rarity]} ${esc(c.creature_id)} breed count reset to 0/8 (−${cost}💎). It can breed again.`, { reply_markup: { inline_keyboard: [[{ text: '🧬 Breed', callback_data: '/breed' }]] } });
      }
      return tg.notify([
        '<b>🔄 BREED RENEW</b>', '━━━━━━━━━━━━━━━━━━━━',
        `${RARITY_EMOJI2[c.rarity]} <b>${esc(c.creature_id)}</b> ${c.rarity} — breed count <b>${c.breed_count || 0}/8</b>`,
        `💎 Cost: <b>${cost}</b> gems ${gems >= cost ? '✅' : `❌ (you have ${gems})`}`,
        'Resets breed count to 0/8 so it can breed again.',
      ].join('\n'), { reply_markup: { inline_keyboard: [
        gems >= cost ? [{ text: `🔄 Renew for ${cost}💎`, callback_data: `/brenew ${short8} GO` }] : [{ text: '💠 Get gems (/gemcraft)', callback_data: '/gemcraft' }],
        [{ text: '⬅️ Back', callback_data: '/breed' }],
      ] } });
    }

    // Pick parent 2 (after parent 1 chosen).
    case '/bp': {
      const idA = args[0];
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load creatures. Try again.', menuMarkup); }
      const now = Date.now();
      const a = findByShort(player, idA);
      if (!a || !isBreedable(a, now)) return tg.notify('❌ That creature can\'t breed now. Open /breed.', menuMarkup);
      // Compatible partners first (a valid breedPlan), then by value.
      const others = (player.creatures || []).filter((c) => c.id !== a.id && isBreedable(c, now))
        .sort((x, y) => (breedPlan(a, y) ? 1 : 0) - (breedPlan(a, x) ? 1 : 0) || creatureValue(y) - creatureValue(x));
      if (!others.length) return tg.notify('❌ No second breedable creature available. Open /breed.', menuMarkup);
      const rows = others.slice(0, 10).map((c) => {
        const p = breedPlan(a, c);
        const tag = p ? `→ ${p.result} ${Math.round(p.success * 100)}%` : `✖ ${breedReason(a, c)}`;
        return [{ text: `${RARITY_EMOJI2[c.rarity]} ${c.creature_id}(${elementOf(c) || '?'}) L${c.level} ${tag}`.slice(0, 60), callback_data: `/bx ${idA} ${bShort(c.id)}` }];
      });
      rows.push([{ text: '⬅️ Back', callback_data: '/breed' }]);
      return tg.notify([
        `<b>🧬 BREED — parent 1: ${RARITY_EMOJI2[a.rarity]}${esc(a.creature_id)} (${elementOf(a) || '?'})</b>`,
        '━━━━━━━━━━━━━━━━━━━━',
        'Pick parent 2 <i>(elements must match)</i>:',
      ].join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    // Show the breed plan for a chosen pair + confirm button.
    case '/bx': {
      const [idA, idB] = args;
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load creatures. Try again.', menuMarkup); }
      const now = Date.now();
      const a = findByShort(player, idA);
      const b = findByShort(player, idB);
      if (!a || !b || !isBreedable(a, now) || !isBreedable(b, now)) return tg.notify('❌ One parent is no longer available. Open /breed.', menuMarkup);
      const plan = breedPlan(a, b);
      if (!plan) return tg.notify('❌ Two Legendaries can\'t breed higher (Legendary is the breed cap). Pick a different pair.', menuMarkup);
      const gold = Number((player.player || {}).gold || 0);
      const afford = gold >= plan.cost;
      const mins = Math.round(plan.timeSec / 60);
      const lines = [
        '<b>🧬 BREED PLAN</b>', '━━━━━━━━━━━━━━━━━━━━',
        `👪 ${RARITY_EMOJI2[a.rarity]}${esc(a.creature_id)} ${a.rarity} × ${RARITY_EMOJI2[b.rarity]}${esc(b.creature_id)} ${b.rarity}`,
        `🥚 Offspring: ${RARITY_EMOJI2[plan.result]} <b>${plan.result}</b>${plan.hybrid ? ' <i>(hybrid species)</i>' : ''} — as a Mystery Egg`,
        `🎲 Success: <b>${Math.round(plan.success * 100)}%</b>  ${plan.success < 1 ? '<i>(fail = 50% gold back)</i>' : ''}`,
        `💰 Cost: <b>${short(plan.cost)}</b> gold ${afford ? '✅' : `❌ (you have ${short(gold)})`}`,
        `⏳ Hatch time: ~${mins} min`,
      ];
      const rows = [];
      if (afford) rows.push([{ text: `♥ Breed → ${plan.result} (${Math.round(plan.success * 100)}%)`, callback_data: `/bgo ${idA} ${idB}` }]); // idA/idB already 8-char
      rows.push([{ text: '⬅️ Back', callback_data: '/breed' }, { text: '✖️ Cancel', callback_data: '/start' }]);
      return tg.notify(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    // Execute the breed.
    case '/bgo': {
      const [idA, idB] = args;
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load creatures. Try again.', menuMarkup); }
      const now = Date.now();
      const a = findByShort(player, idA);
      const b = findByShort(player, idB);
      if (!a || !b || !isBreedable(a, now) || !isBreedable(b, now)) return tg.notify('❌ A parent is no longer available. Open /breed.', menuMarkup);
      const plan = breedPlan(a, b);
      if (!plan) return tg.notify('❌ That pair can\'t breed. Open /breed.', menuMarkup);
      await tg.notify(`🧬 Breeding <b>${esc(a.creature_id)}</b> × <b>${esc(b.creature_id)}</b>…`);
      const res = await client.breed(a.id, b.id).catch((e) => ({ error: e.message }));
      if (res?.error) return tg.notify(`❌ Breed failed: <code>${esc(res.error)}</code>`, menuMarkup);
      state.data.cooldowns.breed = 0; state.count('breed'); state.save();
      const ok = res?.success !== false;
      logHistory(state, ok
        ? `🧬 Bred ${a.creature_id}×${b.creature_id} → ${plan.result} Mystery Egg`
        : `🧬 Breed ${a.creature_id}×${b.creature_id} FAILED (50% gold back)`);
      return tg.notify(ok ? [
        '<b>🧬 BREEDING SUCCESS!</b>', '━━━━━━━━━━━━━━━━━━━━',
        `🥚 A <b>${plan.result}</b> Mystery Egg landed in your nest!`,
        'Hatch it from 🐣 /hatch when the timer\'s done.',
      ].join('\n') : [
        '<b>🧬 Breed didn\'t take</b>', 'The roll failed — you got 50% of the gold back + trainer XP.',
        'Try a lower-tier pair for a safer breed.',
      ].join('\n'), { reply_markup: { inline_keyboard: [[{ text: '🧬 Breed again', callback_data: '/breed' }, { text: '🐣 Hatch', callback_data: '/hatch' }]] } });
    }

    case '/relicmenu': {
      const player = await client.loadPlayer().catch(() => null);
      const rank = { Common: 1, Uncommon: 2, Rare: 3, Epic: 4, Legendary: 5, Mythical: 6 };
      const relics = player?.relics || [];
      const equipped = relics.filter((r) => r.equipped_on).length;
      const good = relics.filter((r) => (rank[r.rarity] || 0) >= 4).length;
      const legPets = (player?.creatures || []).filter((c) => (rank[c.rarity] || 0) >= 5).length;
      return tg.notify([
        '💍 <b>RELIC</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        `Owned: <b>${relics.length}</b> · Equipped: <b>${equipped}</b> · Epic+: <b>${good}</b>`,
        `Target pets: <b>${legPets}</b> Legendary (${legPets * 3} slots)`,
        '',
        '🔄 <b>Auto</b> — craft Epic + equip to Legendary pets',
        '🔨 <b>Forge</b> — craft a combat relic (pick rarity+stat)',
        '⚒️ <b>Enchant</b> — enhance the best equipped relic',
        '♻️ <b>Recycle</b> — bulk-sacrifice spare relics → shard',
      ].join('\n'), {
        reply_markup: { inline_keyboard: [
          [{ text: '🔄 Auto', callback_data: '/relic' }, { text: '🔨 Forge', callback_data: '/relicforge' }],
          [{ text: '💠 Combine', callback_data: '/reliccombine' }, { text: '⚒️ Enchant', callback_data: '/relicenchant' }],
          [{ text: '♻️ Recycle', callback_data: '/relicrecycle' }],
          [{ text: '⬅️ Back', callback_data: '/start' }],
        ] },
      });
    }

    case '/relic': {
      const player = await client.loadPlayer().catch(() => null);
      state.data.cooldowns.relic = 0;
      await engine.relicAutopilot(player);
      const owned = Array.isArray(player?.relics) ? player.relics.length : 0;
      return tg.notify(`💍 Relic processed (craft+equip). Owned: <b>${owned}</b>. Unlocks d_equip (+150 XP/day) & w_relics quests.`, {
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Relic menu', callback_data: '/relicmenu' }], [{ text: '🏠 Home', callback_data: '/start' }]] },
      });
    }

    case '/relicforge': {
      const player = await client.loadPlayer().catch(() => null);
      if (!player) return tg.notify('❌ Could not load (game offline?). Try again.', menuMarkup);
      const rarityArg = args[0];
      // POST /api/relic/craft-combat {rarity, stat}. Costs + success odds (RE from live).
      const FORGE = {
        Rare: { odds: 60, cost: '22 glimmer · 18 mana · 2 astral · 10k gold' },
        Epic: { odds: 35, cost: '30 glimmer · 28 mana · 5 astral · 50k gold' },
        Legendary: { odds: 18, cost: '40 glimmer · 40 mana · 8 astral · 1 catalyst · 200k gold' },
      };
      if (rarityArg) {
        const rarity = rarityArg[0].toUpperCase() + rarityArg.slice(1).toLowerCase();
        // Batch mode: /relicforge <Rarity> x5 → try up to N times, stop on first success.
        const batch = /^x(\d+)$/i.exec(args[1] || '');
        const stat = (batch ? args[2] : args[1]) || config.ZOLANA_RELIC_CRAFT_STATS.split(',')[0];
        const isCraftFail = (res) => res?.success === false || res?.crafted === false || /fail|refund/i.test(JSON.stringify(res));
        if (batch) {
          const tries = Math.min(25, Math.max(1, Number(batch[1])));
          await tg.notify(`🔨 Forging <b>${esc(rarity)}</b> ${esc(stat)} — up to <b>${tries}×</b> (stops on success, ${FORGE[rarity]?.odds ?? '?'}% each)…`);
          let ok = false; let used = 0;
          for (let i = 0; i < tries; i += 1) {
            const res = await client.craftCombatRelic(rarity, stat).catch((e) => ({ error: e.message }));
            used += 1;
            if (res?.error) return tg.notify(`🔨 Stopped after ${used}× — <code>${esc(res.error)}</code> (out of materials/gold?).`, menuMarkup);
            if (!isCraftFail(res)) { ok = true; break; }
          }
          return tg.notify(ok
            ? `🔨 <b>Forged ${esc(rarity)} ${esc(stat)} relic!</b> ✅ (succeeded on try ${used}/${tries}) — auto-equipped next cycle.`
            : `🔨 <b>${esc(rarity)} ${esc(stat)}</b> — ❌ ${tries}/${tries} tries all failed (${FORGE[rarity]?.odds ?? '?'}% each, tough luck). 50% mats refunded each. Tap again to keep trying.`, menuMarkup);
        }
        const res = await client.craftCombatRelic(rarity, stat).catch((e) => ({ error: e.message }));
        if (res?.error) return tg.notify(`🔨 Forge <b>${esc(rarity)}</b> failed: <code>${esc(res.error)}</code>`, menuMarkup);
        return tg.notify(isCraftFail(res)
          ? `🔨 Forge <b>${esc(rarity)}</b> ${esc(stat)} — <b>❌ failed</b> (rolled ${FORGE[rarity]?.odds ?? '?'}%), 50% materials refunded. Try again.`
          : `🔨 <b>Forged ${esc(rarity)} ${esc(stat)} relic!</b> ✅ It'll be auto-equipped to a Legendary pet's slot next cycle.`, menuMarkup);
      }
      const have = Object.fromEntries((player.materials || []).map((m) => [m.material_id, Number(m.quantity || 0)]));
      const gold = Number((player.player || {}).gold || 0);
      const rank = { Common: 1, Uncommon: 2, Rare: 3, Epic: 4, Legendary: 5, Mythical: 6 };
      const goodN = (player.relics || []).filter((r) => (rank[r.rarity] || 0) >= 4).length;
      const legPets = (player.creatures || []).filter((c) => (rank[c.rarity] || 0) >= 5).length;
      const lines = [
        '🔨 <b>Relic Forge</b> — craft a combat relic of your chosen rarity + stat.',
        '',
        `💠 Have: ${have.glimmer_dust || 0} glimmer · ${have.mana_shard || 0} mana · ${have.astral_core || 0} astral · ${have.gem_catalyst || 0} catalyst`,
        `🪙 Gold: <b>${esc(String(gold))}</b> · Epic+ relics: <b>${goodN}</b> (need ${legPets * 3} for ${legPets} Legend pets ×3 slots)`,
        '',
        ...Object.entries(FORGE).map(([r, f]) => `• <b>${r}</b> — ${f.odds}% success · ${f.cost}`),
        '',
        `Default stat: <code>${esc(config.ZOLANA_RELIC_CRAFT_STATS.split(',')[0])}</code> · custom: <code>/relicforge Epic hp_pct</code>`,
        '×N = try up to N times, stops on the first success (max 25).',
      ];
      return tg.notify(lines.join('\n'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔨 Rare', callback_data: '/relicforge Rare' }, { text: '🔨 Epic', callback_data: '/relicforge Epic' }, { text: '🔨 Legendary', callback_data: '/relicforge Legendary' }],
            [{ text: '🔨 Rare ×5', callback_data: '/relicforge Rare x5' }, { text: '🔨 Epic ×5', callback_data: '/relicforge Epic x5' }, { text: '🔨 Legend ×5', callback_data: '/relicforge Legendary x5' }],
            [{ text: 'Epic ×10', callback_data: '/relicforge Epic x10' }, { text: 'Epic ×25', callback_data: '/relicforge Epic x25' }],
            [{ text: 'Legend ×10', callback_data: '/relicforge Legendary x10' }, { text: 'Legend ×25', callback_data: '/relicforge Legendary x25' }],
            [{ text: '⬅️ Relic menu', callback_data: '/relicmenu' }],
          ],
        },
      });
    }

    case '/relicenchant': {
      const player = await client.loadPlayer().catch(() => null);
      if (!player) return tg.notify('❌ Could not load (game offline?). Try again.', menuMarkup);
      const rank = { Common: 1, Uncommon: 2, Rare: 3, Epic: 4, Legendary: 5, Mythical: 6 };
      // Enhance the best equipped relic (rarest, then least-enhanced) with relic_shard.
      const best = (player.relics || [])
        .filter((r) => r.equipped_on)
        .sort((a, b) => (rank[b.rarity] || 0) - (rank[a.rarity] || 0)
          || (Number(a.enhance_level) || 0) - (Number(b.enhance_level) || 0))[0];
      const shards = Number((player.materials || []).find((m) => m.material_id === 'relic_shard')?.quantity || 0);
      if (!best) return tg.notify('⚒️ No equipped relic to enchant yet. Forge + equip one first (/relicforge).', menuMarkup);
      if (args[0] === 'GO') {
        const id = best.id || best.relic_id;
        const res = await client.relicEnhance(id).catch((e) => ({ error: e.message }));
        if (res?.error) return tg.notify(`⚒️ Enchant failed: <code>${esc(res.error)}</code>`, menuMarkup);
        return tg.notify(`⚒️ <b>Enchanted!</b> ${esc(best.rarity)} relic → enhance level up (party power ↑).`, menuMarkup);
      }
      return tg.notify([
        '⚒️ <b>Relic Enchant</b> — spend relic_shard to enhance the best equipped relic.',
        '',
        `🎯 Target: <b>${esc(best.rarity)}</b> ${esc(best.slot || '')} (enhance lvl ${best.enhance_level || 0})`,
        `🔩 relic_shard: <b>${shards}</b>`,
        '',
        'Enhancing boosts the relic\'s stat (server-validated cost + cap).',
      ].join('\n'), {
        reply_markup: { inline_keyboard: [[{ text: '⚒️ Enchant now', callback_data: '/relicenchant GO' }], [{ text: '⬅️ Relic menu', callback_data: '/relicmenu' }]] },
      });
    }

    case '/relicrecycle': {
      const player = await client.loadPlayer().catch(() => null);
      if (!player) return tg.notify('❌ Could not load (game offline?). Try again.', menuMarkup);
      const rank = { Common: 1, Uncommon: 2, Rare: 3, Epic: 4, Legendary: 5, Mythical: 6 };
      // Recyclable = Rare and BELOW, unequipped, not listed/stored/bound. Epic+ protected.
      const recyclable = (player.relics || []).filter((r) => (rank[r.rarity] || 0) <= 3
        && !r.equipped_on && !r.listed && !r.stored && !r.bound && !r.soulbound);
      if (!recyclable.length) return tg.notify('♻️ Nothing to recycle — no spare Rare-or-below relics (Epic+ are protected).', menuMarkup);
      const ids = recyclable.map((r) => r.id || r.relic_id).filter(Boolean);
      if (args[0] === 'GO') {
        const res = await client.relicRecycle(ids).catch((e) => ({ error: e.message }));
        if (res?.error) return tg.notify(`♻️ Recycle failed: <code>${esc(res.error)}</code>`, menuMarkup);
        const got = Number(res?.relic_shard || res?.shards || res?.gained?.relic_shard || 0);
        return tg.notify(`♻️ <b>Recycled ${ids.length} relic${ids.length > 1 ? 's' : ''}!</b>${got ? ` → +${got} relic_shard` : ' → relic_shard added'} (free, Epic+ kept).`, menuMarkup);
      }
      const byR = {};
      recyclable.forEach((r) => { byR[r.rarity] = (byR[r.rarity] || 0) + 1; });
      const lo = ids.length * 2; const hi = ids.length * 4; // 2-4 shards each (Uncommon/Rare)
      return tg.notify([
        '♻️ <b>Relic Recycle</b> — bulk-sacrifice spare relics into relic_shard.',
        '',
        `Recyclable (Rare & below, unequipped): <b>${ids.length}</b>`,
        `   ${Object.entries(byR).map(([r, n]) => `${r} ×${n}`).join(' · ')}`,
        `Est. yield: <b>~${lo}–${hi}</b> relic_shard · Cost: <b>FREE</b>`,
        '',
        '🛡️ Epic / Legendary / Mythical + equipped/listed relics are <b>protected</b>.',
      ].join('\n'), {
        reply_markup: { inline_keyboard: [[{ text: `♻️ Recycle ${ids.length} now`, callback_data: '/relicrecycle GO' }], [{ text: '⬅️ Relic menu', callback_data: '/relicmenu' }]] },
      });
    }

    case '/reliccombine': {
      // v0.19: fuse 5 same-class/rarity relics up a tier (bulk up to 50 = 10 fuses).
      const player = await client.loadPlayer().catch(() => null);
      if (!player) return tg.notify('❌ Could not load (game offline?). Try again.', menuMarkup);
      const ODDS = { Common: 70, Uncommon: 50, Rare: 20, Epic: 10, Legendary: 3 };
      const NEXT = { Common: 'Uncommon', Uncommon: 'Rare', Rare: 'Epic', Epic: 'Legendary', Legendary: 'Mythical' };
      const rank = { Common: 1, Uncommon: 2, Rare: 3, Epic: 4, Legendary: 5, Mythical: 6 };
      // Free relics grouped by class+rarity (fusable = groups of 5 of the same).
      const free = (player.relics || []).filter((r) => !r.equipped_on && !r.listed && !r.stored && !r.bound && ODDS[r.rarity]);
      const groups = {}; // `${class}|${rarity}` → relics[]
      for (const r of free) { const k = `${r.class || 'combat'}|${r.rarity}`; (groups[k] ||= []).push(r); }
      const rarityArg = args[0] === 'GO' ? args[1] : null;

      if (args[0] === 'GO' && rarityArg) {
        // Fuse the biggest same-class group of this rarity, up to 50 relics (10 fuses).
        const cls = Object.keys(groups).filter((k) => k.endsWith(`|${rarityArg}`))
          .sort((a, b) => groups[b].length - groups[a].length)[0];
        const pool = cls ? groups[cls] : [];
        const fuses = Math.min(10, Math.floor(pool.length / 5));
        if (fuses < 1) return tg.notify(`💠 Need 5+ unequipped <b>${esc(rarityArg)}</b> relics of one class (have ${pool.length}).`, menuMarkup);
        const ids = pool.slice(0, fuses * 5).map((r) => r.id || r.relic_id);
        await tg.notify(`💠 Fusing <b>${fuses}× ${esc(rarityArg)}→${esc(NEXT[rarityArg])}</b> (${ODDS[rarityArg]}% each, ${ids.length} relics)…`);
        const res = await client.relicCombine(ids).catch((e) => ({ error: e.message }));
        if (res?.error) return tg.notify(`💠 Combine failed: <code>${esc(res.error)}</code>`, menuMarkup);
        return tg.notify(`💠 <b>Combine done!</b> Fused ${ids.length} ${esc(rarityArg)} relics (${fuses} attempts @ ${ODDS[rarityArg]}%). Check /relicforge — any ${esc(NEXT[rarityArg])}+ get auto-equipped to Legendary pets. Fails returned 2 each.`, menuMarkup);
      }

      // Overview: which rarities have a fusable group of 5+.
      const rows = [];
      const lines = ['💠 <b>RELIC COMBINE</b> — fuse 5 same-class/rarity → 1 next tier', '━━━━━━━━━━━━━━━━━━━━'];
      let any = false;
      for (const rar of ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common']) {
        const best = Object.keys(groups).filter((k) => k.endsWith(`|${rar}`)).map((k) => groups[k].length).sort((a, b) => b - a)[0] || 0;
        const fuses = Math.min(10, Math.floor(best / 5));
        if (best >= 5) {
          any = true;
          lines.push(`• <b>${rar}</b> ×${best} → <b>${fuses}</b> fuse${fuses > 1 ? 's' : ''} @ ${ODDS[rar]}% → ${NEXT[rar]}`);
          rows.push([{ text: `💠 Fuse ${fuses}× ${rar}→${NEXT[rar]} (${ODDS[rar]}%)`, callback_data: `/reliccombine GO ${rar}` }]);
        }
      }
      if (!any) lines.push('', 'No fusable group yet — need <b>5+</b> unequipped relics of the same class + rarity.');
      lines.push('', '💡 Legendary→<b>Mythical</b> is the relic path to Tier 5. Fails return 2 relics.');
      rows.push([{ text: '⬅️ Relic menu', callback_data: '/relicmenu' }]);
      return tg.notify(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    case '/ritual': {
      // Mythic Altar — sacrifice Elder Legendaries for a shot at a Mythic Egg.
      // Config RE'd from live: minOffer 3, maxOffer 10, 2%/elder, pity 50, 10 gems + 100k gold.
      const A = { minOffer: 3, maxOffer: 10, perElderPct: 0.02, survivors: 2, pity: 50, gemCost: 10, goldCost: 100000 };
      const player = await client.loadPlayer().catch(() => null);
      if (!player) return tg.notify('❌ Could not load (game offline?). Try again.', menuMarkup);
      const cr = player.creatures || [];
      // Eligible = Legendary + Elder + not raiding/listed/stored/companion.
      const companionId = (player.player || player.account || {}).equipped_creature;
      const elders = cr.filter((c) => c.rarity === 'Legendary' && c.stage === 'Elder'
        && !c.run_id && !c.listed && !c.stored && c.id !== companionId);
      const gold = Number((player.player || {}).gold || 0);
      const gems = Number((player.player || {}).gems || 0);
      const offerN = Math.min(elders.length, A.maxOffer);
      const chance = Math.round(offerN * A.perElderPct * 100);

      if (args[0] === 'GO') {
        if (elders.length < A.minOffer) return tg.notify(`🔮 Need at least <b>${A.minOffer}</b> Elder Legendaries — you have <b>${elders.length}</b>.`, menuMarkup);
        if (gems < A.gemCost || gold < A.goldCost) return tg.notify(`🔮 Can't afford: need <b>${A.gemCost}</b>💎 + <b>${A.goldCost.toLocaleString()}</b>🪙 (have ${gems}💎 / ${gold.toLocaleString()}🪙).`, menuMarkup);
        const offered = elders.slice(0, A.maxOffer).map((c) => c.id);
        await tg.notify(`🔮 Beginning the ritual — sacrificing <b>${offered.length}</b> Elder Legendaries (${chance}% Mythic)…`);
        const res = await client.altarRitual(offered).catch((e) => ({ error: e.message }));
        if (res?.error) return tg.notify(`🔮 Ritual failed to start: <code>${esc(res.error)}</code>`, menuMarkup);
        const won = res?.success === true || /ascension|mythic egg|success/i.test(JSON.stringify(res));
        state.count('ritual'); state.save();
        return tg.notify(won
          ? `🔮✨ <b>ASCENSION!</b> A <b>Mythic Egg</b> forms! ${A.survivors} survived. Hatch it (~4h) → your first Mythical (Tier 5)! 🐉`
          : `🔮💀 <b>THE RITUAL FAILS</b> — no Mythic this time, all ${offered.length} offered are lost. Pity increased. Breed + evolve more Elder Legendaries and try again.`, menuMarkup);
      }

      const gate = [];
      if (elders.length < A.minOffer) gate.push(`⚠️ <b>Need ${A.minOffer}+ Elder Legendaries</b> — you have <b>${elders.length}</b> (breed Epics → Legendary → evolve to Elder).`);
      if (gems < A.gemCost) gate.push(`⚠️ Need ${A.gemCost}💎 (have ${gems}).`);
      if (gold < A.goldCost) gate.push(`⚠️ Need ${A.goldCost.toLocaleString()}🪙 (have ${gold.toLocaleString()}).`);
      const canDo = elders.length >= A.minOffer && gems >= A.gemCost && gold >= A.goldCost;
      const lines = [
        '🔮 <b>THE RITUAL — Mythic Altar</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        'Sacrifice Elder Legendaries for a shot at a <b>Mythic Egg</b> (Tier 5, the only path to Mythical).',
        '',
        `🐉 Eligible Elder Legendaries: <b>${elders.length}</b>${elders.length ? ' — ' + esc(elders.slice(0, A.maxOffer).map((c) => `${c.creature_id} L${c.level}`).join(', ')) : ''}`,
        `📊 Offer <b>${A.minOffer}–${A.maxOffer}</b> · this run would offer <b>${offerN}</b> → <b>${chance}% Mythic</b> (2%/elder)`,
        `💰 Cost: <b>${A.gemCost}</b>💎 + <b>${A.goldCost.toLocaleString()}</b>🪙 per ritual`,
        `🎯 Pity ${A.pity} (accumulate → guaranteed) · On win: <b>${A.survivors} survive</b>`,
        '',
        '⚠️ <b>WARNING — PERMANENT:</b> Win = 2 survive, rest die. <b>Lose = ALL offered die forever.</b>',
        ...(gate.length ? ['', ...gate] : ['', '✅ Ready to attempt.']),
      ];
      return tg.notify(lines.join('\n'), {
        reply_markup: { inline_keyboard: [
          ...(canDo ? [[{ text: `🔮 SACRIFICE ${offerN} & BEGIN RITUAL`, callback_data: '/ritual GO' }]] : []),
          [{ text: '🔄 Refresh', callback_data: '/ritual' }, { text: '🏠 Home', callback_data: '/start' }],
        ] },
      });
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
      if (!player) return tg.notify('❌ Could not load (game offline?). Try again.', menuMarkup);
      const have = Object.fromEntries((player.materials || []).map((m) => [m.material_id, Number(m.quantity || 0)]));
      have.gold = Number((player.player || {}).gold || 0);
      const gems = Number((player.player || {}).gems || 0);
      // v0.18: gem-making is tier-gated by $ZOLANA held — Newcomer 3 / Holder 10 / Patron 100 / Whale ∞ per period.
      let tierLine = '';
      try {
        const t = (await client.epoch())?.claimTier;
        if (t) {
          const capStr = t.cap == null ? '∞ (unlimited)' : String(t.cap);
          tierLine = `🏅 Tier: <b>${esc(t.label)}</b> — limit <b>${capStr}</b> · holding ${Number(t.zenko || 0).toLocaleString('en-US')} $ZOLANA`;
        }
      } catch { /* best-effort */ }
      const LABEL = { gem_catalyst: '💠 Gem Catalyst', glimmer_dust: '✨ Glimmer Dust', mana_shard: '🔷 Mana Shard', astral_core: '🌟 Astral Core', gold: '🪙 Gold' };
      const lines = ['<b>💠 GEM CRAFT</b> → makes <b>1</b> 💎 gem', '━━━━━━━━━━━━━━━━━━━━'];
      if (tierLine) lines.push(tierLine, '');
      lines.push('<b>Requirements:</b>');
      let allOk = true;
      for (const [k, need] of Object.entries(GEMCRAFT_REQ)) {
        const has = have[k] || 0; const ok = has >= need; if (!ok) allOk = false;
        lines.push(`${ok ? '✅' : '❌'} ${LABEL[k]}: <b>${has.toLocaleString('en-US')}</b> / ${need.toLocaleString('en-US')}`);
      }

      if (args[0] === 'GO') {
        if (!allOk) return tg.notify([...lines, '', '❌ <b>Not enough materials</b> — craft blocked.'].join('\n'), menuMarkup);
        state.data.cooldowns.gemcraft = 0;
        const res = await client.gemCraft().catch((e) => ({ error: e.message }));
        if (res?.error) return tg.notify([...lines, '', `❌ <b>Craft failed:</b> <code>${esc(res.error)}</code>`].join('\n'), menuMarkup);
        logHistory(state, '💠 Crafted 1 gem (manual)');
        return tg.notify(`💠 <b>GEM CRAFTED!</b> ✅\n+1 💎 → now <b>${gems + 1}</b> gems.`, menuMarkup);
      }

      lines.push('', allOk
        ? '✅ <b>All set — ready to craft!</b>'
        : '❌ <b>Missing materials.</b> 💠 gem_catalyst only drops from raiding <b>dungeon floor 2+</b>.');
      const rows = [];
      if (allOk) rows.push([{ text: '💠 Craft Now (1 gem)', callback_data: '/gemcraft GO' }]);
      rows.push([{ text: '🔄 Refresh', callback_data: '/gemcraft' }, { text: '⬅️ Back', callback_data: '/start' }]);
      return tg.notify(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
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

    case '/gems': {
      // Gems hub: choose Buy (pay $ZOLANA) or Sell (list your spare gems on the market).
      let gems = null; let bound = 0;
      try { const acc = (await client.loadPlayer())?.player; gems = Number(acc?.gems); bound = Number(acc?.bound_gems || 0); } catch { /* best-effort */ }
      const sellable = gems != null ? Math.max(0, gems - bound) : null;
      return tg.notify([
        '<b>💎 GEMS</b>',
        '━━━━━━━━━━━━━━━━━━━━',
        gems != null ? `Your balance: <b>${esc(gems)}</b> gems` : '',
        gems != null && bound > 0 ? `🔓 Tradeable: <b>${sellable}</b>  ·  🔒 Soulbound: <b>${bound}</b> <i>(stipend/starter — spend-only, can't sell)</i>` : '',
        bound > 0 ? '<i>💡 Soulbound gems: spend on gacha/cosmetics. Items pulled with them can be made tradeable for 10k $ZOLANA each.</i>' : '',
        'Buy gems with $ZOLANA, or sell your spare gems on the market.',
      ].filter(Boolean).join('\n'), {
        reply_markup: { inline_keyboard: [
          [{ text: '🛒 Buy Gems', callback_data: '/buygems' }, { text: '🏷️ Sell Gems', callback_data: '/sp x all' }],
          [{ text: '⬅️ Back', callback_data: '/market' }],
        ] },
      });
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

    case '/mbuy': {
      // Generic marketplace BUY: category filter → live listings (max 20, cheapest
      // first) → tap to buy. Pay in USD; the server quote auto-converts to $ZOLANA
      // (95% direct to seller wallet + 5% treasury fee). Buying is NOT level-gated.
      const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
      const fmtUsd = (n) => `$${Number(n || 0).toFixed(Number(n) < 0.001 ? 6 : 2)}`;
      // Material sub-filters (replace the generic "material" category): each maps to a
      // specific resource so buyers can grab exactly what the forge/craft needs.
      const MAT_SUB = { relic_shard: 'relic_shard', gem_catalyst: 'gem_catalyst', dust: 'glimmer_dust' };
      const KINDS = ['gold', 'gem', 'creature', 'egg', 'relic', 'cosmetic', 'relic_shard', 'gem_catalyst', 'dust'];
      const EMO = { gold: '💰', gem: '💎', creature: '🐾', egg: '🥚', relic: '💍', cosmetic: '🎀', relic_shard: '🔩', gem_catalyst: '💠', dust: '✨' };
      const kind = args[0];
      const fetchKind = MAT_SUB[kind] ? 'material' : kind; // server kind (materials share one)
      const wantResource = MAT_SUB[kind] || null; // sub-filter by resource within materials

      // No/invalid category → show the category picker.
      if (!kind || !KINDS.includes(kind)) {
        const rows = [];
        for (let i = 0; i < KINDS.length; i += 2) {
          rows.push(KINDS.slice(i, i + 2).map((k) => ({ text: `${EMO[k]} ${k}`, callback_data: `/mbuy ${k}` })));
        }
        rows.push([{ text: '⬅️ Back', callback_data: '/market' }]);
        return tg.notify([
          '<b>🛒 BUY FROM MARKET</b>',
          '━━━━━━━━━━━━━━━━━━━━',
          'Pick a category — you pay in <b>USD</b>, auto-converted to $ZOLANA',
          'from your wallet (95% → seller, 5% fee). No level needed.',
        ].join('\n'), { reply_markup: { inline_keyboard: rows } });
      }

      // Fetch live listings for the chosen kind.
      const gm = await client.market(fetchKind).catch((e) => ({ error: e.message }));
      if (gm?.error) return tg.notify(`🛒 Market fetch failed: <code>${esc(gm.error)}</code>`, menuMarkup);
      const price = Number(gm.zolanaPriceUsd || 0);
      const resOf = (l) => l.resource || l.item?.resource || l.material_id || l.item?.material_id;
      const listings = (Array.isArray(gm.listings) ? gm.listings : [])
        .filter((l) => l.status === 'active' && l.item_kind === fetchKind
          && (!wantResource || resOf(l) === wantResource)
          && l.seller !== client.wallet.publicKey && Number(l.price_usd) > 0)
        .map((l) => {
          const qty = Math.max(1, Number(l.quantity) || 1);
          const usd = Number(l.price_usd);
          return { id: l.id, qty, usd, unit: usd / qty, name: marketName(l) };
        })
        .sort((a, b) => a.unit - b.unit)
        .slice(0, 20);

      // Buy execution: /mbuy <kind> <listingId> GO
      if (args[2] === 'GO' && args[1]) {
        const chosen = listings.find((l) => l.id === args[1]);
        if (!chosen) {
          return tg.notify('🛒 That listing is gone (sold/expired). Reload to refresh.', {
            reply_markup: { inline_keyboard: [[{ text: `🔄 Reload ${kind}`, callback_data: `/mbuy ${kind}` }]] },
          });
        }
        const quote = await client.marketQuote(args[1]).catch((e) => ({ error: e.message }));
        if (quote?.error) return tg.notify(`🛒 Quote failed: <code>${esc(quote.error)}</code>`, menuMarkup);
        const dec = Number(quote.decimals || 6);
        const costZ = Number(BigInt(quote.zolanaTotal)) / 10 ** dec;
        const bal = await client.wallet.tokenBalance().catch(() => null);
        if (bal && bal.uiAmount - costZ < config.ZOLANA_MARKET_ZOLANA_RESERVE) {
          return tg.notify(`🛒 Not enough $ZOLANA: need <b>${esc(fmtN(Math.ceil(costZ)))}</b> + reserve <b>${esc(fmtN(config.ZOLANA_MARKET_ZOLANA_RESERVE))}</b>, balance <b>${esc(fmtN(Math.floor(bal.uiAmount)))}</b>.`, menuMarkup);
        }
        const qStr = chosen.qty > 1 ? ` ×${fmtN(chosen.qty)}` : '';
        await tg.notify(`🛒 Buying <b>${esc(chosen.name)}</b>${esc(qStr)} for <b>${esc(fmtN(Math.round(costZ)))}</b> $ZOLANA (${esc(fmtUsd(chosen.usd))})…`);
        const res = await client.marketBuyWithQuote(quote).catch((e) => ({ error: e.message }));
        if (res?.error) return tg.notify(`🛒 Buy failed: <code>${esc(res.error)}</code>`, menuMarkup);
        state.count('marketBuy'); state.save();
        logHistory(state, `🛒 Bought ${chosen.name}${qStr} — ${fmtN(Math.round(costZ))} $ZOLANA (${fmtUsd(chosen.usd)})`);
        logger.info({ listing: chosen.id, kind, name: chosen.name, qty: chosen.qty, spentZolana: Math.round(costZ) }, 'item bought on market');
        return tg.notify([
          `${EMO[kind]} <b>PURCHASED!</b>`,
          '━━━━━━━━━━━━━━━━━━━━',
          `${esc(chosen.name)}${esc(qStr)} — <b>${esc(fmtN(Math.round(costZ)))}</b> $ZOLANA (${esc(fmtUsd(chosen.usd))})`,
        ].join('\n'), {
          reply_markup: { inline_keyboard: [
            [{ text: `🔄 Buy more ${kind}`, callback_data: `/mbuy ${kind}` }],
            [{ text: '⬅️ Market', callback_data: '/market' }],
          ] },
        });
      }

      // List view: up to 20 live listings, cheapest first, tap to buy.
      if (!listings.length) {
        return tg.notify(`${EMO[kind]} No <b>${kind}</b> listings right now — try another category or later.`, {
          reply_markup: { inline_keyboard: [[{ text: '⬅️ Categories', callback_data: '/mbuy' }]] },
        });
      }
      const bal = await client.wallet.tokenBalance().catch(() => null);
      const lines = [
        `${EMO[kind]} <b>BUY ${kind.toUpperCase()}</b> — cheapest first (max 20)`,
        '━━━━━━━━━━━━━━━━━━━━',
        bal ? `🪙 Your $ZOLANA: <b>${esc(fmtN(Math.floor(bal.uiAmount)))}</b>` : '',
        price ? `💵 $ZOLANA ${esc(fmtUsd(price))} · pay USD → auto-convert` : '',
        '<i>Tap a row to buy it instantly.</i>',
        '',
      ];
      const rows = [];
      for (const l of listings) {
        const costZ = price ? l.usd / price : 0;
        const q = l.qty > 1 ? ` ×${fmtN(l.qty)}` : '';
        lines.push(`• <b>${esc(l.name)}</b>${esc(q)} — <b>${esc(fmtUsd(l.usd))}</b> ≈ ${esc(fmtN(Math.round(costZ)))} $Z`);
        rows.push([{ text: `${EMO[kind]} ${l.name}${q} · ${fmtUsd(l.usd)}`.slice(0, 60), callback_data: `/mbuy ${kind} ${l.id} GO` }]);
      }
      rows.push([{ text: '⬅️ Categories', callback_data: '/mbuy' }, { text: '🏪 Market', callback_data: '/market' }]);
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
      if (res?.error) return tg.notify(`📄 Failed: <code>${esc(res.error)}</code>`, menuMarkup);
      const items = (Array.isArray(res?.listings) ? res.listings : []).filter((it) => !it.status || it.status === 'active');
      if (!items.length) return tg.notify('📄 <b>No active listings.</b>\nList something with the 🏷️ Sell menu — /sell.', menuMarkup);
      const lines = ['<b>📄 MY LISTINGS</b>', '━━━━━━━━━━━━━━━━━━━━', '<i>Tap ❌ below to cancel one.</i>', ''];
      const rows = [];
      for (const it of items.slice(0, 12)) {
        const name = marketName(it);
        const p = it.price_usd != null ? `$${it.price_usd}` : (it.price_gems != null ? `${it.price_gems}💎` : '?');
        const qty = it.quantity ? ` ×${Number(it.quantity).toLocaleString('en-US')}` : '';
        lines.push(`• ${esc(name)}${qty} — <b>${p}</b>`);
        rows.push([{ text: `❌ ${name}${qty} · ${p}`.slice(0, 45), callback_data: `/cancel ${it.id}` }]);
      }
      rows.push([{ text: '🏷️ Sell more', callback_data: '/sell' }, { text: '⬅️ Back', callback_data: '/market' }]);
      return tg.notify(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    case '/hatch': {
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load eggs (game offline?). Try again.', menuMarkup); }
      const eggs = (player.eggs || []).filter((e) => e.status !== 'hatched' && !e.hatched && !e.creature_id && !e.listed);
      if (!eggs.length) return tg.notify('🥚 <b>No eggs.</b>\nGet eggs from breeding, gacha, or the /store.', menuMarkup);
      const now = Date.now();
      const withState = eggs.map((e) => ({ e, s: eggState(e, now) }));
      const ready = withState.filter((x) => x.s.ready);
      const cooking = withState.filter((x) => !x.s.ready && !x.s.idle);
      const idle = withState.filter((x) => x.s.idle);
      const incUsed = eggs.filter((e) => e.status === 'incubating').length;
      const INCUBATOR_SLOTS = 6;
      const freeSlots = Math.max(0, INCUBATOR_SLOTS - incUsed);

      const lines = ['<b>🥚 HATCHERY</b>', '━━━━━━━━━━━━━━━━━━━━', `🔧 Incubator: <b>${incUsed}/${INCUBATOR_SLOTS}</b> slots busy`];
      if (ready.length) lines.push(`⏳ <b>${ready.length} ready</b> to hatch now`);
      for (const { s } of cooking.slice(0, 6)) lines.push(`${s.emoji} ${s.type} — ${s.label} · <i>${s.potential}</i>`);
      if (idle.length) lines.push(freeSlots ? `💤 ${idle.length} idle — tap Incubate to start` : `💤 ${idle.length} idle — incubator full, wait for one to hatch`);
      lines.push('', '<i>Hatch needs roster room. If "Squad full", sell a creature via /sell first.</i>');

      const rows = [];
      if (ready.length) rows.push([{ text: `🐣 Hatch ALL ready (${ready.length})`, callback_data: '/hx all' }]);
      for (const { e, s } of ready.slice(0, 6)) rows.push([{ text: `🐣 ${s.emoji} ${s.type} → ${s.potential}`.slice(0, 45), callback_data: `/hx ${e.id}` }]);
      for (const { e, s } of idle.slice(0, freeSlots).slice(0, 6)) rows.push([{ text: `🥚 Incubate ${s.emoji} ${s.type}`.slice(0, 45), callback_data: `/ic ${e.id}` }]);
      rows.push([{ text: '🎒 Inventory', callback_data: '/inventory' }, { text: '⬅️ Back', callback_data: '/start' }]);
      return tg.notify(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    // Hatch a ready egg (or all ready eggs).
    case '/hx': {
      const target = args[0];
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load eggs. Try again.', menuMarkup); }
      const now = Date.now();
      const ready = (player.eggs || []).filter((e) => e.status !== 'hatched' && !e.hatched && !e.creature_id && eggState(e, now).ready);
      const targets = target === 'all' ? ready : ready.filter((e) => e.id === target);
      if (!targets.length) return tg.notify("🥚 That egg isn't ready (or already hatched). Open /hatch.", menuMarkup);
      const results = [];
      for (const e of targets.slice(0, 6)) {
        const res = await client.hatch(e.id).catch((err) => ({ error: err.message }));
        if (res?.error) {
          const full = /squad full|make room/i.test(res.error);
          results.push(`❌ ${esc(e.egg_type)}: ${full ? 'roster full — sell one via /sell first' : esc(res.error)}`);
          if (full) break;
        } else {
          const cr = res?.creature || res?.card || res || {};
          results.push(`🐣 <b>${esc(cr.rarity || '')} ${esc(cr.creature_id || cr.name || e.egg_type)}</b> hatched!`);
          logHistory(state, `🐣 Hatched ${cr.rarity || ''} ${cr.creature_id || e.egg_type}`.trim());
        }
      }
      return tg.notify(['<b>🐣 HATCH RESULT</b>', '━━━━━━━━━━━━━━━━━━━━', ...results, '', 'See it in /creatures.'].join('\n'), menuMarkup);
    }

    // Start incubating an idle egg.
    case '/ic': {
      const id = args[0];
      if (!id) return tg.notify('❌ No egg selected. Open /hatch.', menuMarkup);
      const res = await client.incubate(id).catch((err) => ({ error: err.message }));
      if (res?.error) {
        const full = /incubator.*busy|slots are busy/i.test(res.error);
        return tg.notify(full ? '❌ All incubator slots are busy — wait for one to hatch.' : `❌ Incubate failed: <code>${esc(res.error)}</code>`, menuMarkup);
      }
      return tg.notify('🥚 <b>Incubation started!</b>\nCheck the timer with /hatch.', menuMarkup);
    }

    // 🗄️ Vault — move creatures to/from storage to free active-roster room (kept safe).
    case '/vault': {
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load creatures. Try again.', menuMarkup); }
      const cr = player.creatures || [];
      const vaulted = (player.stored?.creatures) || [];
      const cap = Number((player.player || {}).storage_cap || 100);
      const active = cr.filter((c) => !c.stored && !isPlacedC(c) && !c.run_id && !c.listed).sort((a, b) => creatureValue(a) - creatureValue(b));
      const lines = [
        '<b>🗄️ VAULT</b>', '━━━━━━━━━━━━━━━━━━━━',
        `📦 Stored: <b>${vaulted.length}/${cap}</b>  ·  🐾 Active roster: <b>${cr.filter((c) => !c.stored).length}</b>`,
        '<i>Vaulting frees roster room without losing the creature. Tap one to vault it; tap a stored one to pull it back.</i>', '',
      ];
      const rows = [];
      for (const c of active.slice(0, 8)) rows.push([{ text: `🗄️ ${c.rarity} ${c.creature_id} L${c.level}`.slice(0, 45), callback_data: `/vm ${c.id}` }]);
      for (const c of vaulted.slice(0, 6)) rows.push([{ text: `↩️ Unvault ${c.rarity} ${c.creature_id}`.slice(0, 45), callback_data: `/vm ${c.id} u` }]);
      if (!rows.length) return tg.notify('🗄️ Nothing free to vault (all creatures are placed/raiding/listed).', menuMarkup);
      rows.push([{ text: '🐣 Hatch', callback_data: '/hatch' }, { text: '⬅️ Back', callback_data: '/start' }]);
      return tg.notify(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    case '/vm': {
      const id = args[0];
      const store = args[1] !== 'u';
      if (!id) return tg.notify('❌ No creature selected. Open /vault.', menuMarkup);
      const res = await client.storageMove('creature', id, store).catch((e) => ({ error: e.message }));
      if (res?.error) return tg.notify(`❌ ${store ? 'Vault' : 'Unvault'} failed: <code>${esc(res.error)}</code>`, menuMarkup);
      return tg.notify(store ? '🗄️ <b>Vaulted</b> — roster slot freed. Open /vault or /hatch.' : '↩️ <b>Pulled back</b> from vault into your roster.', { reply_markup: { inline_keyboard: [[{ text: '🗄️ Vault', callback_data: '/vault' }, { text: '🐣 Hatch', callback_data: '/hatch' }]] } });
    }

    // ⚔️ Sacrifice — feed spare Common/Uncommon creatures into a chosen target (XP + frees roster).
    case '/sacrifice': {
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load creatures. Try again.', menuMarkup); }
      const cr = player.creatures || [];
      const all = cr.filter((c) => !c.stored);
      // Target = the one passed by the picker, else the strongest creature.
      const target = (args[0] && all.find((c) => c.id === args[0])) || [...all].sort((a, b) => creatureValue(b) - creatureValue(a))[0];
      if (!target) return tg.notify('⚔️ No creatures to sacrifice into.', menuMarkup);
      const spare = (rar) => cr.filter((c) => c.rarity === rar && !isPlacedC(c) && !c.run_id && !c.listed && !c.stored && c.id !== target.id);
      const commonN = spare('Common').length;
      const uncommonN = spare('Uncommon').length;
      if (!commonN && !uncommonN) return tg.notify('⚔️ No spare Common/Uncommon to sacrifice (placed/raiding ones are protected).', menuMarkup);
      const lines = [
        '<b>⚔️ SACRIFICE</b>', '━━━━━━━━━━━━━━━━━━━━',
        `🎯 Target (gets XP): <b>${RARITY_EMOJI2[target.rarity] || ''}${esc(target.creature_id)}</b> ${target.rarity}/${target.stage} L${target.level}`,
        '', 'Spare fodder <i>(placed/raiding ones are protected)</i>:',
        `   ⚪ Common: <b>${commonN}</b>   🟢 Uncommon: <b>${uncommonN}</b>`,
        '', '<i>Fodder is consumed (max 10/tap); target gains XP + roster frees up. Pick which to feed:</i>',
      ];
      const rows = [];
      if (commonN) rows.push([{ text: `⚔️ ${Math.min(commonN, 10)} Common → ${target.creature_id}`.slice(0, 45), callback_data: `/sac ${target.id} C` }]);
      if (uncommonN) rows.push([{ text: `⚔️ ${Math.min(uncommonN, 10)} Uncommon → ${target.creature_id}`.slice(0, 45), callback_data: `/sac ${target.id} U` }]);
      rows.push([{ text: '🎯 Change target', callback_data: '/sactgt' }, { text: '✖️ Cancel', callback_data: '/start' }]);
      return tg.notify(lines.join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    // Pick which creature receives the sacrifice XP.
    case '/sactgt': {
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load creatures. Try again.', menuMarkup); }
      const cr = (player.creatures || []).filter((c) => !c.stored).sort((a, b) => creatureValue(b) - creatureValue(a)).slice(0, 8);
      if (!cr.length) return tg.notify('⚔️ No creatures found.', menuMarkup);
      const rows = cr.map((c) => [{ text: `🎯 ${RARITY_EMOJI2[c.rarity] || ''} ${c.creature_id} ${c.rarity} L${c.level}`.slice(0, 45), callback_data: `/sacrifice ${c.id}` }]);
      rows.push([{ text: '⬅️ Back', callback_data: '/sacrifice' }]);
      return tg.notify(['<b>🎯 PICK SACRIFICE TARGET</b>', '━━━━━━━━━━━━━━━━━━━━', 'Tap the creature that should receive the XP:'].join('\n'), { reply_markup: { inline_keyboard: rows } });
    }

    case '/sac': {
      const targetId = args[0];
      const rarity = (args[1] || 'C').toUpperCase() === 'U' ? 'Uncommon' : 'Common';
      if (!targetId) return tg.notify('❌ Bad selection. Open /sacrifice.', menuMarkup);
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load creatures. Try again.', menuMarkup); }
      const target = (player.creatures || []).find((c) => c.id === targetId);
      if (!target) return tg.notify('❌ Target creature not found. Open /sacrifice.', menuMarkup);
      const fodder = (player.creatures || []).filter((c) => c.rarity === rarity && !isPlacedC(c) && !c.run_id && !c.listed && !c.stored && c.id !== targetId).slice(0, 10);
      if (!fodder.length) return tg.notify(`⚔️ No spare ${rarity} creatures left.`, menuMarkup);
      const res = await client.sacrifice(targetId, fodder.map((c) => c.id)).catch((e) => ({ error: e.message }));
      if (res?.error) return tg.notify(`❌ Sacrifice failed: <code>${esc(res.error)}</code>`, menuMarkup);
      logHistory(state, `⚔️ Sacrificed ${fodder.length} ${rarity} → ${target.creature_id}`);
      return tg.notify([
        '<b>⚔️ SACRIFICED!</b>',
        `🔥 ${fodder.length} ${rarity} → 🎯 <b>${esc(target.creature_id)}</b>`,
        `Roster freed by ${fodder.length}. Target gained XP.`,
      ].join('\n'), { reply_markup: { inline_keyboard: [[{ text: '⚔️ Again', callback_data: `/sacrifice ${target.id}` }, { text: '🐣 Hatch', callback_data: '/hatch' }]] } });
    }

    // ⬆️ Buy a storage capacity upgrade (server deducts the cost, usually gold).
    case '/upgrade': {
      let player;
      try { player = await client.loadPlayer(); }
      catch { return tg.notify('❌ Could not load account. Try again.', menuMarkup); }
      const acct = player.player || {};
      const cap = Number(acct.storage_cap || 100);
      if (args[0] !== 'CONFIRM') {
        return tg.notify([
          '<b>⬆️ UPGRADE STORAGE</b>', '━━━━━━━━━━━━━━━━━━━━',
          `📦 Current capacity: <b>${cap}</b>`,
          `🪙 Your gold: <b>${Number(acct.gold || 0).toLocaleString('en-US')}</b>`,
          '', '<i>Buys +capacity (cost scales, paid in gold — server-enforced). Confirm to buy.</i>',
        ].join('\n'), { reply_markup: { inline_keyboard: [[{ text: '✅ Buy upgrade', callback_data: '/upgrade CONFIRM' }], [{ text: '✖️ Cancel', callback_data: '/start' }]] } });
      }
      const res = await client.storageUpgrade().catch((e) => ({ error: e.message }));
      if (res?.error) return tg.notify(`❌ Upgrade failed: <code>${esc(res.error)}</code>`, menuMarkup);
      const newCap = res?.player?.storage_cap ?? res?.storage_cap ?? (cap + '?');
      return tg.notify(`⬆️ <b>Storage upgraded!</b>\n📦 New capacity: <b>${esc(newCap)}</b>`, menuMarkup);
    }

    case '/cancel': {
      const id = args[0];
      if (!id) return tg.notify('Format: <code>/cancel &lt;listingId&gt;</code>');
      const res = await client.marketCancel(id).catch((e) => ({ error: e.message }));
      if (!res?.error) engine.noteCancelled(id); // so it isn't later misreported as a sale
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
      const map = { g: 'gold', m: 'material', k: 'cosmetic', r: 'relic', c: 'creature', e: 'egg', x: 'gem' };
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
      } else if (kind === 'gem') {
        const gems = Number(acct.gems || 0);
        const bound = Number(acct.bound_gems || 0);
        const sellable = Math.max(0, gems - bound); // bound gems (holder stipend) can't be listed
        if (sellable <= 0) return tg.notify(bound > 0
          ? `❌ All ${gems} gems are 🔒bound (holder stipend) — none sellable.`
          : '❌ You have no gems to sell.', menuMarkup);
        needsQty = true; maxQty = sellable; qtyDefault = sellable;
        unit = sellUnitFloor(summary, 'gem') * 0.97;
        name = bound > 0 ? `Gems (${sellable} of ${gems} sellable · ${bound} 🔒bound)` : 'Gems';
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
      return performList(client, tg, sellPayload(ps, total, ps.qtyDefault), engine);
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

// Creature value ranking (for choosing weakest to vault/sacrifice, strongest as target).
const RARITY_BASE = { Common: 10, Uncommon: 40, Rare: 200, Epic: 1200, Legendary: 5000, Mythical: 25000 };
const VARIANT_MULT = { Normal: 1, Shiny: 2, Golden: 5, Shadow: 7, Rainbow: 15 };
const RARITY_EMOJI2 = { Common: '⚪', Uncommon: '🟢', Rare: '🔵', Epic: '🟣', Legendary: '🟡', Mythical: '🔴' };
// Gem-craft recipe for the /gemcraft checklist — v0.18 values (RE'd from live chunk 5268,
// confirmed live: 10 catalyst + 200k gold). The manual Craft button still surfaces the exact
// server response, so this stays correct even if amounts change again.
const GEMCRAFT_REQ = { gem_catalyst: 10, glimmer_dust: 100, mana_shard: 50, astral_core: 20, gold: 200000 };
function creatureValue(c) {
  return (RARITY_BASE[c.rarity] || 10) * (VARIANT_MULT[c.variant] || 1) * (1 + 0.015 * ((c.level || 1) - 1));
}
function isPlacedC(c) {
  return c.placed || (c.plot_x !== null && c.plot_x !== undefined);
}

// --- Breed mechanics (RE'd from the game bundle) ---
// parentTier = MIN of both parents' rarity tier; offspring tier = parentTier+1 (capped
// at Legendary). Success/cost/time come from this table (keyed by parentTier 0..3).
// Two Legendaries can't breed up (no Mythical from breeding). Different species → hybrid.
const BREED_TIER = { Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Legendary: 4, Mythical: 5 };
const BREED_TABLE = [
  { result: 'Uncommon', success: 1.0, cost: 3000, timeSec: 1800 },
  { result: 'Rare', success: 0.85, cost: 10000, timeSec: 3600 },
  { result: 'Epic', success: 0.6, cost: 30000, timeSec: 7200 },
  { result: 'Legendary', success: 0.25, cost: 80000, timeSec: 14400 },
];
const BREED_COOLDOWN_MS_UI = 25 * 60 * 1000; // eC.cooldownSec = 1500s (RE'd) — was wrongly 60m
const BREED_MIN_HAPPINESS = 50; // eC.minHappiness — a creature below this can't breed
const BREED_MAX_COUNT = 8; // v0.18: a creature maxes at 8 breeds, then needs Renew (gems)
const RENEW_GEM_COST = { Common: 2, Uncommon: 3, Rare: 5, Epic: 8, Legendary: 12, Mythical: 20 };
const isBredOut = (c) => Number(c.breed_count || 0) >= BREED_MAX_COUNT;
// Species → Element (from the game catalog `en(id,Name,Element,…)`). Breeding is gated by
// element compatibility AND rarity: Legendary-tier (or higher) creatures can't breed at all.
const CREATURE_ELEMENT = { abyssling:'Aqua',aquarine:'Aqua',aurelia:'Lux',blazecub:'Ignis',bloomara:'Flora',boulderon:'Terra',brambark:'Flora',breezekit:'Aero',chronovex:'Lux',cindermane:'Ignis',cindle:'Ignis',clovy:'Flora',cobble:'Terra',coralbite:'Aqua',coralisk:'Aqua',cosmium:'Lux',craggle:'Terra',cragroot:'Terra',crystara:'Terra',cyclonix:'Aero',darkspecter:'Void',deltarcha:'Flora',dimble:'Void',divinium:'Lux',dualuxe:'Void',duskee:'Void',eclipsyn:'Lux',elderbark:'Flora',emberle:'Ignis',emberwing:'Ignis',flicky:'Ignis',florix:'Flora',fortaran:'Terra',fuzzrock:'Terra',gaialith:'Terra',gaiamir:'Terra',galestrike:'Aero',geargrove:'Terra',geowarden:'Terra',gleamguard:'Lux',glimra:'Lux',gloopy:'Aqua',gustaria:'Aero',gusty:'Aero',hurricana:'Aero',infernohound:'Ignis',leviath:'Aqua',lotuseer:'Flora',lucentia:'Lux',lumen:'Lux',luminara:'Lux',magmarok:'Ignis',marlance:'Aqua',marshling:'Aqua',megalith:'Terra',mistweaver:'Aero',nightstrider:'Void',nihilarch:'Void',nimbu:'Aero',noctilume:'Void',novaburst:'Ignis',petalbud:'Flora',petrabloom:'Flora',poseidax:'Aqua',prismark:'Lux',pyrewing:'Ignis',pyrexis:'Ignis',pyroglide:'Aero',quartzpup:'Terra',quarzon:'Terra',scorchstorm:'Ignis',seedlup:'Flora',skydrift:'Aero',smoldra:'Ignis',solarknight:'Lux',solivanna:'Lux',solphoenix:'Ignis',splisho:'Aqua',stormray:'Aqua',stratoguard:'Aero',stratosking:'Aero',swampire:'Aqua',sylvorn:'Flora',tectodon:'Terra',tempestus:'Aqua',terragod:'Terra',terraquill:'Terra',terravine:'Flora',thornhelm:'Flora',thornmaw:'Flora',tidalord:'Aqua',tidalserp:'Aqua',tiddles:'Aqua',twilara:'Void',umbraluxis:'Void',umbrance:'Void',umbraxis:'Void',umbrite:'Void',verdania:'Flora',verdantia:'Flora',voidlord:'Void',wishling:'Lux',yggdrasoul:'Flora',zephyrion:'Aero',zephyron:'Aero' };
// eS: elements each element can breed with (symmetric, includes itself).
const ELEMENT_COMPAT = {
  Terra: ['Terra', 'Flora'], Aqua: ['Aqua', 'Aero', 'Flora'], Flora: ['Flora', 'Terra', 'Aqua'],
  Ignis: ['Ignis', 'Aero'], Aero: ['Aero', 'Aqua', 'Ignis'], Void: ['Void', 'Lux'], Lux: ['Lux', 'Void'],
};
const elementOf = (c) => CREATURE_ELEMENT[c?.creature_id] || null;
function elementsCompatible(a, b) {
  const ea = elementOf(a); const eb = elementOf(b);
  if (!ea || !eb) return true; // unknown species → let the server decide, don't block
  return (ELEMENT_COMPAT[ea] || []).includes(eb);
}
// Is a creature eligible to breed right now? (Adult/Elder, NOT Legendary+, off cooldown.)
// NOTE: PLACED (farming) creatures ARE breedable — the server allows it (verified live);
// only creatures actively RAIDING (run_id), listed, or stored are locked out.
function isBreedable(c, now = Date.now()) {
  if (!['Adult', 'Elder'].includes(c.stage)) return false;
  if ((BREED_TIER[c.rarity] ?? 0) >= 4) return false; // Legendary+ can't breed
  if (isBredOut(c)) return false; // v0.18: 8/8 breeds → bred-out, needs Renew first
  if (c.listed || c.stored || c.run_id) return false;
  if (Number(c.happiness ?? 100) < BREED_MIN_HAPPINESS) return false; // needs happiness ≥ 50
  const last = Date.parse(c.last_breed_time || '');
  return !Number.isFinite(last) || (now - last) >= BREED_COOLDOWN_MS_UI;
}
// Breed outcome plan for a pair, or null if it can't breed (Legendary+ parent, or the
// two elements aren't compatible). Offspring tier = min(parent tier)+1.
function breedPlan(a, b) {
  if ((BREED_TIER[a.rarity] ?? 0) >= 4 || (BREED_TIER[b.rarity] ?? 0) >= 4) return null;
  if (!elementsCompatible(a, b)) return null;
  const parentTier = Math.min(BREED_TIER[a.rarity] ?? 0, BREED_TIER[b.rarity] ?? 0);
  if (parentTier > 3) return null;
  const row = BREED_TABLE[parentTier];
  return { ...row, parentTier, hybrid: a.creature_id !== b.creature_id };
}
// Short reason a pair can't breed (for the picker); '' if it can.
function breedReason(a, b) {
  if ((BREED_TIER[a.rarity] ?? 0) >= 4 || (BREED_TIER[b.rarity] ?? 0) >= 4) return 'Legendary can\'t breed';
  if (!elementsCompatible(a, b)) return `${elementOf(a) || '?'}✖${elementOf(b) || '?'}`;
  return '';
}
// Rank all breedable pairs: highest offspring tier first, then success, then lowest cost.
function bestBreedPairs(breedables) {
  const pairs = [];
  for (let i = 0; i < breedables.length; i++) {
    for (let j = i + 1; j < breedables.length; j++) {
      const plan = breedPlan(breedables[i], breedables[j]);
      if (plan) pairs.push({ a: breedables[i], b: breedables[j], plan });
    }
  }
  return pairs.sort((x, y) =>
    (BREED_TIER[y.plan.result] - BREED_TIER[x.plan.result])
    || (y.plan.success - x.plan.success)
    || (x.plan.cost - y.plan.cost));
}
// Telegram callback_data caps at 64 bytes — two full UUIDs (77+) overflow it and the
// whole message is rejected (BUTTON_DATA_INVALID). Breed callbacks carry 8-char id
// prefixes instead and resolve back to the full creature here (collision-safe for a
// per-account roster of a few dozen).
const bShort = (id) => String(id).slice(0, 8);
function findByShort(player, shortId) {
  return (player.creatures || []).find((c) => bShort(c.id) === shortId);
}

// --- Evolve status (mirrors strategy.js STAGE_CFG + rarity gate) ---
const EVOLVE_STAGES = ['Baby', 'Juvenile', 'Adult', 'Elder'];
const EVOLVE_CFG = {
  Baby: { durationSec: 7200, cost: 5000, skipXp: 100 },
  Juvenile: { durationSec: 21600, cost: 25000, skipXp: 250 },
  Adult: { durationSec: 43200, cost: 125000, skipXp: 500 },
};
// Same rule the autopilot uses: Common never evolves; Adult→Elder = Epic/Legendary+ only.
function evolveAllowedUI(stage, rarity) {
  const tier = BREED_TIER[rarity] ?? 0;
  if (stage === 'Adult') return tier >= 3;
  return tier >= 1;
}
// Human-readable countdown: 5400 -> "1h 30m".
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}
// Evolve state for one creature (stage, gold cost, seconds until timer, xp-skip readiness),
// or null if Elder/terminal.
function evolveStatus(c, now = Date.now()) {
  const stage = EVOLVE_STAGES.includes(c.stage) ? c.stage : 'Baby';
  if (stage === 'Elder') return null;
  const cfg = EVOLVE_CFG[stage];
  const startedAt = Date.parse(c.stage_started_at || c.created_at || '');
  const elapsed = Number.isFinite(startedAt) ? (now - startedAt) / 1000 : 0;
  const remainSec = Math.max(0, cfg.durationSec - elapsed);
  const xp = Number(c.creature_xp ?? c.xp ?? 0);
  return {
    stage, next: EVOLVE_STAGES[EVOLVE_STAGES.indexOf(stage) + 1], cost: cfg.cost,
    remainSec, timeReady: remainSec <= 0, xp, skipXp: cfg.skipXp, xpReady: xp >= cfg.skipXp,
  };
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

// Append a one-line event to the rolling activity history (shown by /history).
function logHistory(state, text) {
  const h = Array.isArray(state.data.history) ? state.data.history : [];
  h.push({ t: Date.now(), text });
  state.data.history = h.slice(-60);
  state.save();
}

// Human name for a market listing row (from its embedded item, per kind).
function marketName(it) {
  const i = it.item || {};
  return i.creature_id || (i.egg_type ? `${i.egg_type} egg` : null)
    || i.base_id || i.cosmetic_id || it.resource || it.item_kind || 'item';
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
async function performList(client, tg, payload, engine) {
  const menuMarkup = { reply_markup: tg.mainKeyboard() };
  const res = await client.marketList(payload).catch((e) => ({ error: e.message }));
  if (res?.error) return tg.notify(`❌ List failed: <code>${esc(res.error)}</code>`, menuMarkup);
  // Track the new listing immediately so its sale is never missed (even if it sells fast).
  if (engine) await engine.recordActiveListings().catch(() => {});
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
