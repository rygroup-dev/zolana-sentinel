import { config } from './config.js';
import { logger } from './logger.js';

const HR = '━━━━━━━━━━━━━━━━━━━━';

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function num(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US');
}

function usd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
}

function short(value) {
  if (!value) return '-';
  return `${String(value).slice(0, 5)}…${String(value).slice(-4)}`;
}

const RARITY_EMOJI = {
  Common: '⚪', Uncommon: '🟢', Rare: '🔵', Epic: '🟣', Legendary: '🟡', Mythical: '🔴',
};

// Format a gacha result's `cards` array (what was won) into HTML lines.
export function formatGachaCards(gacha) {
  const cards = Array.isArray(gacha?.cards) ? gacha.cards : [];
  if (!cards.length) return null;
  const lines = cards.map((card) => {
    const rar = card.rarity ? `${RARITY_EMOJI[card.rarity] || ''} ` : '';
    switch (card.kind) {
      case 'material': return `📦 <b>${num(card.amount)}×</b> ${esc(card.id)}`;
      case 'gold': return `🪙 <b>${num(card.amount)}</b> gold`;
      case 'gems': return `💎 <b>${num(card.amount)}</b> gems`;
      case 'shard': return `🔹 <b>${num(card.amount)}</b> shards`;
      case 'creature': return `${rar}🐉 <b>${esc(card.name || card.id)}</b>${card.rarity ? ` (${esc(card.rarity)})` : ''}`;
      case 'egg': return `${rar}🥚 <b>${esc(card.name || card.id)}</b>${card.rarity ? ` (${esc(card.rarity)})` : ''}`;
      case 'relic': return `${rar}💍 <b>${esc(card.name || card.id)}</b>${card.rarity ? ` (${esc(card.rarity)})` : ''}`;
      case 'cosmetic': return `${rar}👕 <b>${esc(card.name || card.id)}</b>`;
      default: return `• ${esc(card.kind)} ${esc(card.name || card.id || '')}`;
    }
  });
  return lines.join('\n');
}

export class TelegramBot {
  constructor(state) {
    this.state = state;
    this.token = config.ZOLANA_TELEGRAM_BOT_TOKEN;
    this.chatId = config.ZOLANA_TELEGRAM_CHAT_ID;
    this.offset = Number(state.data.telegramOffset || 0);
    this.enabled = Boolean(this.token && this.chatId);
  }

  async request(method, payload = undefined) {
    if (!this.token) return null;
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: payload ? 'POST' : 'GET',
      headers: payload ? { 'content-type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.description || `Telegram ${method} failed`);
    }
    return data?.result ?? data;
  }

  async notify(text, extra = {}) {
    if (!this.enabled) return;
    await this.request('sendMessage', {
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    }).catch((error) => logger.warn({ message: error.message }, 'telegram notify failed'));
  }

  // Main dashboard keyboard shown under status/menu messages.
  mainKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: '📊 Status', callback_data: '/status' },
          { text: '🏪 Market', callback_data: '/market' },
          { text: '🏷️ Sell', callback_data: '/sell' },
          { text: '💰 Wallet', callback_data: '/wallet' },
        ],
        [
          { text: '⚔️ PvP', callback_data: '/pvp' },
          { text: '🏰 Dungeon', callback_data: '/dungeon' },
          { text: '🧬 Evolve', callback_data: '/evolve' },
        ],
        [
          { text: '🐾 Companion', callback_data: '/companion' },
          { text: '💍 Relic', callback_data: '/relic' },
          { text: '🌌 Epoch', callback_data: '/epoch' },
        ],
        [
          { text: '🎁 Claim All', callback_data: '/claim' },
          { text: '🎁 Daily', callback_data: '/daily' },
          { text: '💤 AFK', callback_data: '/afk' },
          { text: '📜 Quests', callback_data: '/quests' },
        ],
        [
          { text: '🧬 Breed', callback_data: '/breed' },
        ],
        [
          { text: '🎰 Gacha', callback_data: '/gacha' },
          { text: '💎 Buy Gems', callback_data: '/buygems' },
          { text: '🛒 Store', callback_data: '/store' },
        ],
        [
          { text: '💵 Fund', callback_data: '/fund' },
          { text: '🥚 Eggs', callback_data: '/eggs' },
          { text: '💠 Gem Craft', callback_data: '/gemcraft' },
        ],
        [
          { text: '🎒 Inventory', callback_data: '/inventory' },
          { text: '🐉 Creatures', callback_data: '/creature' },
          { text: '📈 Profit', callback_data: '/profit' },
        ],
        [
          { text: '▶️ Run Cycle', callback_data: '/once' },
          { text: '⚙️ Autopilot', callback_data: '/auto' },
          { text: '📋 Stats', callback_data: '/stats' },
        ],
        [
          { text: '⏸ Pause', callback_data: '/pause' },
          { text: '✅ Resume', callback_data: '/resume' },
          { text: '❔ Help', callback_data: '/help' },
        ],
        [
          { text: '🧾 Gen Wallet', callback_data: '/genwallet' },
          { text: '💸 Send Fee', callback_data: '/sendfee' },
          { text: '🪙 Send ZOLANA', callback_data: '/sendzolana' },
        ],
        [
          { text: '🧹 Sweep', callback_data: '/sweep' },
        ],
      ],
    };
  }

  autoKeyboard(engine) {
    const row = (label, key, def) => {
      const on = engine.toggle(key, def);
      return { text: `${on ? '🟢' : '🔴'} ${label}`, callback_data: `/toggle ${key}` };
    };
    return {
      inline_keyboard: [
        [
          row('AFK', 'afk', config.ZOLANA_AUTO_AFK),
          row('Claims', 'claims', config.ZOLANA_AUTO_CLAIMS),
          row('Quests', 'quests', config.ZOLANA_AUTO_QUESTS),
        ],
        [
          row('Dungeon', 'dungeon', config.ZOLANA_AUTO_DUNGEON),
          row('Evolve', 'evolve', config.ZOLANA_AUTO_EVOLVE),
          row('Breed', 'breed', config.ZOLANA_AUTO_BREED),
        ],
        [
          row('Gacha', 'gacha', config.ZOLANA_AUTO_GACHA),
          row('PremEgg', 'premiumEgg', config.ZOLANA_AUTO_PREMIUM_EGG),
          row('GemCraft', 'gemcraft', config.ZOLANA_AUTO_GEMCRAFT),
        ],
        [
          row('BuyEgg💰', 'buyegg', config.ZOLANA_AUTO_BUY_EGG),
          row('AutoStam⚡', 'autostamina', config.ZOLANA_AUTO_STAMINA),
        ],
        [
          row('Relic', 'relic', config.ZOLANA_AUTO_RELIC),
          row('RelicEnh', 'relicEnhance', config.ZOLANA_AUTO_RELIC_ENHANCE),
          row('Compan', 'companion', config.ZOLANA_AUTO_COMPANION),
        ],
        [
          row('Epoch', 'epoch', config.ZOLANA_AUTO_EPOCH),
        ],
        [
          row('PvP', 'pvp', config.ZOLANA_AUTO_PVP),
          row('Slots', 'slots', config.ZOLANA_AUTO_SLOTS),
        ],
        [
          row('Mkt Buy', 'marketBuy', config.ZOLANA_AUTO_MARKET_BUY),
          row('Mkt Sell', 'marketSell', config.ZOLANA_AUTO_MARKET_SELL),
        ],
        [{ text: '⬅️ Back', callback_data: '/start' }],
      ],
    };
  }

  async registerCommands() {
    if (!this.enabled) return;
    const commands = [
      { command: 'start', description: '🏠 Zolana Sentinel dashboard' },
      { command: 'status', description: '📊 Account status + autopilot' },
      { command: 'wallet', description: '💰 SOL + $ZOLANA balance' },
      { command: 'profit', description: '📈 Net worth & profit tracker' },
      { command: 'market', description: '🏪 Marketplace analysis' },
      { command: 'sell', description: '🏷️ Sell items manually (set price & qty)' },
      { command: 'store', description: '🛒 Gem store offers' },
      { command: 'pvp', description: '⚔️ Run a PvP match' },
      { command: 'dungeon', description: '🏰 Start/claim dungeon (raid)' },
      { command: 'evolve', description: '🧬 Evolve all eligible creatures' },
      { command: 'breed', description: '🧬 Breed Adult+ (higher rarity)' },
      { command: 'relic', description: '💍 Craft+equip relic' },
      { command: 'epoch', description: '🌌 Epoch donate → $ZOLANA rebate' },
      { command: 'inventory', description: '🎒 Bag: creatures/eggs/relics/materials' },
      { command: 'creature', description: '🐉 Creature list: name, rarity, gold/h' },
      { command: 'companion', description: '🐾 Set companion (party power buff)' },
      { command: 'fund', description: '💵 How to fund the account' },
      { command: 'eggs', description: '🥚 Egg catalog + rarity odds' },
      { command: 'gemcraft', description: '💠 Craft gems from gem_catalyst' },
      { command: 'quests', description: '📜 Claim all quests (+account XP)' },
      { command: 'daily', description: '🎁 Claim daily reward' },
      { command: 'claim', description: '🎁 Claim all free rewards' },
      { command: 'afk', description: '💤 Enter AFK zone before going offline' },
      { command: 'slot', description: '➕ Buy a new plot slot' },
      { command: 'buyegg', description: '🥚 Egg menu + auto-buy ON/OFF' },
      { command: 'gacha', description: '🎰 Gacha pull (tier currency)' },
      { command: 'buygems', description: '💎 Buy gems with $ZOLANA (shows prices)' },
      { command: 'buystamina', description: '⚡ Buy full stamina with $ZOLANA (on-chain)' },
      { command: 'listing', description: '📄 My market listings' },
      { command: 'listings', description: '📄 My market listings' },
      { command: 'cancel', description: '❌ Cancel a listing <id>' },
      { command: 'leaderboard', description: '🏆 Leaderboard' },
      { command: 'stats', description: '📋 Bot action stats' },
      { command: 'auto', description: '⚙️ Autopilot toggle panel' },
      { command: 'once', description: '▶️ Run one cycle now' },
      { command: 'pause', description: '⏸ Pause autopilot' },
      { command: 'resume', description: '✅ Resume autopilot' },
      { command: 'genwallet', description: '🧾 Generate sub-account wallet' },
      { command: 'sendfee', description: '💸 Send SOL fee to a wallet' },
      { command: 'sendzolana', description: '🪙 Send $ZOLANA token' },
      { command: 'sweep', description: '🧹 Sweep all $ZOLANA' },
      { command: 'deposit', description: '📥 SOL deposit address' },
      { command: 'withdrawal', description: '📤 Manual SOL withdraw' },
      { command: 'help', description: '❔ Command list' },
    ];
    await this.request('setMyCommands', {
      commands,
      scope: { type: 'chat', chat_id: this.chatId },
    }).catch((error) => logger.warn({ message: error.message }, 'telegram set commands failed'));
    await this.request('setChatMenuButton', {
      chat_id: this.chatId,
      menu_button: { type: 'commands' },
    }).catch((error) => logger.warn({ message: error.message }, 'telegram menu button failed'));
  }

  menuText() {
    const p = this.state.data.lastPlayer;
    const paused = this.state.data.paused;
    return [
      '<b>⚡ ZOLANA SENTINEL</b>',
      HR,
      p ? `👤 <b>${esc(p.username || '-')}</b> · Lv ${esc(p.level ?? '-')}` : '👤 No player snapshot yet',
      `🤖 Autopilot: ${paused ? '⏸ <b>PAUSED</b>' : '🟢 <b>RUNNING</b>'}`,
      HR,
      'Tap a button below or type a command:',
      '• <code>/status</code> · <code>/wallet</code> · <code>/profit</code>',
      '• <code>/market</code> · <code>/store</code> · <code>/listing</code> / <code>/listings</code>',
      '• <code>/pvp</code> · <code>/dungeon</code> · <code>/evolve</code> · <code>/claim</code>',
      '• <code>/slot</code> · <code>/buyegg</code> · <code>/gacha</code>',
      '• <code>/auto</code> (toggle) · <code>/once</code> · <code>/pause</code> · <code>/resume</code>',
      '• <code>/genwallet</code> · <code>/sendfee</code> · <code>/sendzolana</code> · <code>/sweep</code>',
      '• <code>/deposit</code> · <code>/withdrawal &lt;sol&gt; &lt;wallet&gt; CONFIRM</code>',
    ].join('\n');
  }

  // Long-polls Telegram so button taps / commands are handled within ~1s.
  // Returns true when a (long) poll actually ran, false when disabled.
  async poll(handler, longPollSeconds = 25) {
    if (!this.enabled || !config.ZOLANA_TELEGRAM_POLL) return false;
    const updates = await this.request('getUpdates', {
      offset: this.offset,
      timeout: longPollSeconds,
      allowed_updates: ['message', 'callback_query'],
    }).catch((error) => {
      logger.warn({ message: error.message }, 'telegram poll failed');
      return [];
    });

    for (const update of updates || []) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      this.state.data.telegramOffset = this.offset;

      let text = null;
      if (update.callback_query) {
        const cb = update.callback_query;
        if (String(cb.message?.chat?.id) !== String(this.chatId)) continue;
        await this.request('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
        text = cb.data?.trim() || null;
      } else if (update.message?.text) {
        if (String(update.message.chat?.id) !== String(this.chatId)) continue;
        text = update.message.text.trim();
      }
      if (!text) continue;

      try {
        await handler(text, this);
      } catch (error) {
        logger.warn({ command: text, message: error.message }, 'command failed');
        await this.notify(`⚠️ <code>${esc(text)}</code> failed: <code>${esc(error.message)}</code>`).catch(() => {});
      }
    }
    return true;
  }

  formatStatus(snapshot, market) {
    if (!snapshot) return '⏳ Zolana bot: no player snapshot yet. Wait for the first cycle.';
    const paused = this.state.data.paused;
    const lines = [
      '<b>📊 ZOLANA STATUS</b>',
      HR,
      `👤 <b>${esc(snapshot.username || '-')}</b>  ·  🔑 <code>${short(snapshot.wallet)}</code>`,
      `⭐ Level <b>${esc(snapshot.level ?? '-')}</b>  ·  XP ${num(snapshot.xp)}`,
      `🤖 Autopilot: ${paused ? '⏸ <b>PAUSED</b>' : '🟢 <b>RUNNING</b>'}`,
      HR,
      `🪙 Gold: <b>${num(snapshot.gold)}</b>`,
      `💎 Gems: <b>${num(snapshot.gems)}</b>   🔹 Shards: ${num(snapshot.shards)} <i>(currency, ≠ mana_shard)</i>`,
      `🟣 Zenko: <b>${num(snapshot.zenko_balance)}</b>`,
      `⚡ Stamina: <b>${num(snapshot.stamina)}</b> <i>(raid/dungeon fuel)</i>`,
      `🥚 Eggs: ${num(snapshot.eggs)}   🐉 Creatures: ${num(snapshot.creatures)}`,
    ];

    const profit = this.state.data.profit;
    if (profit) {
      lines.push(HR);
      lines.push(`💵 $ZOLANA: <b>${usd(profit.zolanaPriceUsd)}</b>` +
        (profit.tokenUsd != null ? `  ·  Hold: <b>${usd(profit.tokenUsd)}</b>` : ''));
    }

    if (market?.summary) {
      const floors = Object.entries(market.summary)
        .filter(([, v]) => v.floorUnitUsd !== null && v.floorUnitUsd !== undefined)
        .map(([kind, v]) => `${kind} ${usd(v.floorUnitUsd)}`);
      if (floors.length) {
        lines.push(HR);
        lines.push(`🏪 Floors: ${floors.join(' · ')}`);
      }
    }
    return lines.join('\n');
  }

  formatWallet(sol, token, price) {
    const lines = [
      '<b>💰 WALLET</b>',
      HR,
      `◎ SOL: <b>${Number(sol).toFixed(6)}</b>`,
    ];
    if (token) {
      lines.push(`🪙 $ZOLANA: <b>${num(token.uiAmount)}</b>`);
      if (price) lines.push(`💵 ≈ <b>${usd(token.uiAmount * price)}</b>  (@ ${usd(price)})`);
    }
    return lines.join('\n');
  }

  formatProfit() {
    const p = this.state.data.profit;
    if (!p) return '📈 Profit tracker has no data yet. Wait for the next cycle.';
    const hist = Array.isArray(this.state.data.profitHistory) ? this.state.data.profitHistory : [];
    const first = hist[0];
    const lines = [
      '<b>📈 PROFIT TRACKER</b>',
      HR,
      `💵 $ZOLANA price: <b>${usd(p.zolanaPriceUsd)}</b>`,
      `🪙 Hold token: <b>${num(p.tokenBalance)}</b>` + (p.tokenUsd != null ? `  ≈ <b>${usd(p.tokenUsd)}</b>` : ''),
      HR,
      `🪙 Gold: ${num(p.gold)}   💎 Gems: ${num(p.gems)}`,
      `🟣 Zenko: ${num(p.zenko)}   ⭐ Lv: ${p.level}`,
    ];
    if (first && first !== p) {
      const dGold = Number(p.gold) - Number(first.gold);
      const dZenko = Number(p.zenko) - Number(first.zenko);
      const span = new Date(p.at) - new Date(first.at);
      const hrs = Math.max(1, Math.round(span / 3.6e6));
      lines.push(HR);
      lines.push(`📊 Sejak ${hrs}h lalu: Gold ${dGold >= 0 ? '+' : ''}${num(dGold)} · Zenko ${dZenko >= 0 ? '+' : ''}${num(dZenko)}`);
    }
    return lines.join('\n');
  }

  formatInventory(data) {
    // data = { player, creatures, eggs, relics, materials, cosmetics }
    const acct = data?.player || {};
    const creatures = Array.isArray(data?.creatures) ? data.creatures : [];
    const eggs = (Array.isArray(data?.eggs) ? data.eggs : []).filter((e) => e.status !== 'hatched' && !e.hatched);
    const relics = Array.isArray(data?.relics) ? data.relics : [];
    const materials = Array.isArray(data?.materials) ? data.materials : [];
    const cosmetics = Array.isArray(data?.cosmetics) ? data.cosmetics : [];

    const byRarity = {};
    for (const c of creatures) byRarity[c.rarity || '?'] = (byRarity[c.rarity || '?'] || 0) + 1;
    const order = ['Mythical', 'Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];
    const rarityLine = order
      .filter((r) => byRarity[r])
      .map((r) => `${RARITY_EMOJI[r] || ''}${r} ${byRarity[r]}`)
      .join(' · ') || '-';

    const variants = {};
    for (const c of creatures) if (c.variant && c.variant !== 'Normal') variants[c.variant] = (variants[c.variant] || 0) + 1;
    const variantLine = Object.entries(variants).map(([v, n]) => `${v} ${n}`).join(' · ');

    const lines = [
      '<b>🎒 INVENTORY / BACKPACK</b>',
      HR,
      `💎 Gems: <b>${num(acct.gems)}</b>   🪙 Gold: <b>${num(acct.gold)}</b>`,
      `🔹 Shards: <b>${num(acct.shards)}</b> <i>(rare currency — different from mana_shard)</i>`,
      `🟣 Zenko ($ZOLANA): <b>${num(acct.zenko_balance)}</b>`,
      HR,
      `🐉 <b>Creatures (${creatures.length})</b>`,
      `   ${rarityLine}`,
    ];
    if (variantLine) lines.push(`   ✨ Variants: ${variantLine}`);
    lines.push(`🥚 Eggs aktif: <b>${eggs.length}</b>`);

    if (relics.length) {
      lines.push(HR, `💍 <b>Relics (${relics.length})</b>`);
      for (const r of relics.slice(0, 8)) {
        const eq = r.equipped_on ? ' ✅' : '';
        const enh = r.enhance_level ? ` +${r.enhance_level}` : '';
        lines.push(`   ${RARITY_EMOJI[r.rarity] || ''} ${esc(r.base_id || r.id)} (${esc(r.rarity || '?')})${enh}${eq}`);
      }
    }

    if (materials.length) {
      lines.push(HR, '📦 <b>Materials</b>');
      lines.push('   ' + materials.map((m) => `${esc(m.material_id)}: <b>${num(m.quantity)}</b>`).join(' · '));
    }
    if (cosmetics.length) lines.push(HR, `👕 Cosmetics: ${cosmetics.length}`);
    return lines.join('\n');
  }

  formatCreatures(data) {
    const creatures = Array.isArray(data?.creatures) ? data.creatures : [];
    if (!creatures.length) return '🐉 No creatures yet.';
    const BASE = { Common: 10, Uncommon: 50, Rare: 200, Epic: 1000, Legendary: 5000, Mythical: 25000 };
    const VAR = { Normal: 1, Shiny: 2, Golden: 5, Shadow: 7, Rainbow: 15 };
    const rank = { Mythical: 6, Legendary: 5, Epic: 4, Rare: 3, Uncommon: 2, Common: 1 };
    const cph = (c) => Math.round((BASE[c.rarity] || 10) * (VAR[c.variant] || 1) * (1 + 0.015 * ((c.level || 1) - 1)));
    const placed = (c) => c.plot_x !== null && c.plot_x !== undefined;
    const sorted = creatures.slice().sort((a, b) =>
      (rank[b.rarity] || 0) - (rank[a.rarity] || 0) || cph(b) - cph(a));

    const lines = [`<b>🐉 CREATURES (${creatures.length})</b>`, HR];
    for (const c of sorted.slice(0, 30)) {
      const rar = RARITY_EMOJI[c.rarity] || '';
      const varTag = c.variant && c.variant !== 'Normal' ? ` ✨${esc(c.variant)}` : '';
      const spot = placed(c) ? '🌱' : '💤';
      lines.push(`${spot} ${rar} <b>${esc(c.creature_id)}</b> · ${esc(c.rarity)}${varTag} · ${esc(c.stage)} L${esc(c.level ?? 1)} · ${num(cph(c))}/h`);
    }
    if (sorted.length > 30) lines.push(`… +${sorted.length - 30} lagi`);
    lines.push(HR, '🌱=farming · 💤=idle · /h = gold per hour');
    return lines.join('\n');
  }

  formatStats() {
    const c = this.state.data.counters || {};
    const entries = Object.entries(c).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '📋 No actions recorded yet.';
    const total = entries.reduce((s, [, v]) => s + v, 0);
    const lines = ['<b>📋 STATISTIK AKSI BOT</b>', HR, `Total aksi: <b>${num(total)}</b>`, HR];
    for (const [k, v] of entries.slice(0, 25)) lines.push(`• <code>${esc(k)}</code> — <b>${v}</b>`);
    return lines.join('\n');
  }
}
