import { config } from './config.js';
import { logger } from './logger.js';

const FEED_COOLDOWN_MS = 10 * 60 * 1000;
const DAILY_COOLDOWN_MS = 23 * 60 * 60 * 1000;
const IDLE_COOLDOWN_MS = 5 * 60 * 1000;
const MARKET_COOLDOWN_MS = 20 * 60 * 1000;
const AFK_COOLDOWN_MS = 15 * 60 * 1000;
const CLAIMS_COOLDOWN_MS = 30 * 60 * 1000;
const EVOLVE_COOLDOWN_MS = 20 * 60 * 1000;
const DUNGEON_COOLDOWN_MS = 10 * 60 * 1000;
const PVP_COOLDOWN_MS = 30 * 60 * 1000;
const SLOT_COOLDOWN_MS = 30 * 60 * 1000;
const PRICE_COOLDOWN_MS = 10 * 60 * 1000;
const QUESTS_COOLDOWN_MS = 15 * 60 * 1000;
const BREED_COOLDOWN_MS = 60 * 60 * 1000;
const GACHA_COOLDOWN_MS = 30 * 60 * 1000;
const BASIC_EGG_COST = 2500;
const MARKET_KINDS = ['creature', 'egg', 'relic', 'material', 'gem', 'gold', 'cosmetic'];
// Creatures the autopilot may auto-sell (below Rare). Rare+ are kept for manual /sell.
const AUTO_SELL_RARITIES = new Set(['Common', 'Uncommon']);
// Pacing between the ~8 marketIntel browse calls — firing them back-to-back gets
// rate-limited by Cloudflare and returns empty ("count:0") for the whole batch.
const MARKET_INTEL_DELAY_MS = 700;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Reverse-engineered game mechanics (see reference_zolana_mechanics memory) ---
// Stage ladder; only Elder can battle. Evolve ALWAYS costs evolveCost gold; useXp
// additionally burns creature_xp to skip the timer.
// Gold production per placed creature (mirrors server: coinsPerHour = baseValue ×
// variantMult × (1+0.015·(level-1))). Used to always farm the BEST producers.
const RARITY_BASE = { Common: 10, Uncommon: 50, Rare: 200, Epic: 1000, Legendary: 5000, Mythical: 25000 };
const VARIANT_MULT = { Normal: 1, Shiny: 2, Golden: 5, Shadow: 7, Rainbow: 15 };
// Battle power multipliers (for PvP/dungeon team ranking): rarity + variant.
const RARITY_BATTLE = { Common: 1, Uncommon: 1.2, Rare: 1.5, Epic: 2, Legendary: 2.8, Mythical: 4 };
const VARIANT_BATTLE = { Normal: 1, Shiny: 1.15, Golden: 1.35, Shadow: 1.5, Rainbow: 2 };
const STAGE_BATTLE = { Baby: 0.5, Juvenile: 0.75, Adult: 1, Elder: 1.5 };
// Proxy battle power (exact stats aren't in the payload) for ranking a battle team.
function battlePower(creature) {
  return (RARITY_BATTLE[creature?.rarity] || 1)
    * (VARIANT_BATTLE[creature?.variant] || 1)
    * (STAGE_BATTLE[creature?.stage] || 1)
    * (1 + 0.05 * (Math.max(1, Number(creature?.level) || 1) - 1));
}
function coinsPerHour(creature) {
  const base = RARITY_BASE[creature?.rarity] || 10;
  const variant = VARIANT_MULT[creature?.variant] || 1;
  const level = Math.max(1, Number(creature?.level) || 1);
  return base * variant * (1 + 0.015 * (level - 1));
}

// How much of each material to KEEP for the bot's own craft/build/epoch use before
// selling the surplus: gem_catalyst→gem craft (5/craft), relic_shard→relic enhance
// (~8/level), mana_shard/glimmer_dust/astral_core→epoch donate recipe (20/40/8 each).
// Buffered for several uses so crafting never gets starved by selling.
const MATERIAL_RESERVE = {
  gem_catalyst: 10,
  relic_shard: 40,
  mana_shard: 60,
  glimmer_dust: 200,
  astral_core: 40,
  default: 100,
};

const STAGES = ['Baby', 'Juvenile', 'Adult', 'Elder'];
const STAGE_CFG = {
  Baby: { durationSec: 7200, evolveCost: 5000, skipXp: 100 },
  Juvenile: { durationSec: 21600, evolveCost: 25000, skipXp: 250 },
  Adult: { durationSec: 43200, evolveCost: 125000, skipXp: 500 },
  Elder: { durationSec: 0, evolveCost: 0, skipXp: 0 },
};

// Dungeon catalog (client-side; only start/claim/cancel exist). dungeonId = FLOOR
// (1-25), grouped into 5 regions of 5 floors each. Higher floor = far more gold
// (goldMin=300·floor^1.4), +50% materials by floor 25, and gem_catalyst only at
// higher floors. Power-gated: reqPower(floor)=120·floor^1.85·(1+min(0.7,0.03·floor))
// → f1≈124, f2≈459, f3≈1002, f5≈2705, f10≈7534, f25≈36k (verified live). Drops
// glimmer_dust/mana_shard/astral_core/gem_catalyst + gold.
const GEMCRAFT_GOLD_COST = 90000; // server-validated cost of one gem_catalyst craft
const REGION_STAMINA = [6, 8, 10, 14, 18];
const REGION_NAMES = ['Meadow Hollows', 'Tidal Caverns', 'Ember Depths', 'Shadow Reach', 'Celestial Spire'];
const DUNGEONS = Array.from({ length: 25 }, (_, i) => {
  const id = i + 1;
  const regionIdx = Math.floor(i / 5);
  return {
    id,
    region: regionIdx + 1,
    name: REGION_NAMES[regionIdx],
    staminaCost: REGION_STAMINA[regionIdx],
    durationSec: Math.round(60 + ((id - 1) / 24) * 420),
    goldMin: Math.round(300 * (id ** 1.4)),
  };
});
const dungeonReqPower = (floor) =>
  Math.round(120 * (floor ** 1.85) * (1 + Math.min(0.7, 0.03 * floor)));

// --- Stamina-cycle raiding (pure, unit-tested) ---------------------------------
// The game has no `stamina_max`/regen field — stamina is a lazily-computed value on
// the account. We infer the cap from the highest value ever observed (it fully
// regenerates during idle, e.g. maintenance). Phase machine with hysteresis:
//   RAID  → keep raiding until stamina can't afford the cheapest floor → FARM
//   FARM  → place the strongest for gold until stamina refills past refillFrac → RAID
export function decideRaidPhase(prev, stamina, opts = {}) {
  const cheapest = opts.cheapest ?? 6;
  const refillFrac = opts.refillFrac ?? 0.9;
  const staminaMax = Math.max(Number(prev?.staminaMax || 0), Number(stamina || 0));
  let phase = prev?.phase || 'raid';
  if (phase === 'raid' && stamina < cheapest) phase = 'farm';
  else if (phase === 'farm' && stamina >= staminaMax * refillFrac) phase = 'raid';
  return { phase, staminaMax };
}

// Pick the highest floor a party of the detected `power` can clear, bounded by the
// stamina left this burst. `power == null` → highest affordable floor, so the very
// first (strongest) party reveals its real power from the server on start.
// `floors` must be pre-sorted highest-id-first; `reqPower(id)` = required power.
export function pickFloor(floors, power, remStamina, reqPower = dungeonReqPower) {
  const affordable = floors.filter((d) => d.staminaCost <= remStamina);
  if (!affordable.length) return null;
  if (power == null) return affordable[0];
  return affordable.find((d) => reqPower(d.id) <= power) || affordable[affordable.length - 1];
}

// Client-computed quest catalog. There is NO quest-list endpoint — the client
// evaluates completion from player metrics and POSTs /api/quests/claim {questId}.
// Each claim grants +150 account XP (the main lever for account level).
const QUESTS = [
  { id: 'd_place', period: 'daily', metric: 'placed', target: 1 },
  { id: 'd_own3', period: 'daily', metric: 'creatures_owned', target: 3 },
  { id: 'd_gold', period: 'daily', metric: 'gold', target: 30000 },
  { id: 'd_equip', period: 'daily', metric: 'relics_equipped', target: 1 },
  { id: 'w_species', period: 'weekly', metric: 'species_owned', target: 8 },
  { id: 'w_level', period: 'weekly', metric: 'account_level', target: 5 },
  { id: 'w_relics', period: 'weekly', metric: 'relics_owned', target: 3 },
  { id: 'o_place', period: 'once', metric: 'placed', target: 1 },
];

// Creature Dex milestones (client-computed like quests; claim via /api/dex/claim,
// deduped in player.quest_claims as "once"). Reward = gems (+ occasional forest eggs)
// for collecting distinct species.
const DEX_MILESTONES = [
  { id: 'dex_20', species: 20 },
  { id: 'dex_40', species: 40 },
  { id: 'dex_60', species: 60 },
  { id: 'dex_80', species: 80 },
  { id: 'dex_99', species: 99 },
];

function questStamp(period) {
  const day = Math.floor(Date.now() / 86_400_000);
  if (period === 'daily') return `d${day}`;
  if (period === 'weekly') return `w${Math.floor(day / 7)}`;
  return 'once';
}

function questMetrics(player) {
  const account = actor(player);
  const cs = creatures(player);
  const species = new Set(cs.map((c) => c.creature_id).filter(Boolean));
  return {
    placed: cs.filter(isPlaced).length,
    creatures_owned: cs.length,
    gold: Number(account.gold || 0),
    // A relic is equipped when it references a creature via `equipped_on` (the real
    // field in player/load) — the legacy `equipped`/`equipped_relic` flags never
    // exist, so counting them silently skipped the d_equip daily (+150 acct XP).
    relics_equipped: list(player?.relics)
      .filter((r) => r?.equipped_on || r?.equip_slot || r?.equipped).length,
    species_owned: species.size,
    account_level: Number(account.level || 1),
    relics_owned: list(player?.relics).length,
  };
}

function creatureStage(creature) {
  const stage = creature?.stage;
  return STAGES.includes(stage) ? stage : 'Baby';
}

// Returns evolve eligibility + cost info, or null if terminal/ineligible.
function evolveInfo(creature) {
  const stage = creatureStage(creature);
  if (stage === 'Elder') return null;
  const cfg = STAGE_CFG[stage];
  const startedAt = Date.parse(creature.stage_started_at || creature.created_at || '');
  const elapsedSec = Number.isFinite(startedAt) ? (Date.now() - startedAt) / 1000 : 0;
  const xp = Number(creature.creature_xp ?? creature.xp ?? 0);
  const timeReady = elapsedSec >= cfg.durationSec;
  const xpReady = xp >= cfg.skipXp;
  if (!timeReady && !xpReady) return null;
  return { stage, cfg, timeReady, xpReady };
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function playerFrom(payload) {
  return payload || null;
}

function actor(state) {
  return state?.player || state || {};
}

function eggs(state) {
  return list(state?.eggs || state?.inventory?.eggs || state?.player?.eggs);
}

function activeEggs(state) {
  return eggs(state).filter((egg) =>
    egg
    && egg.status !== 'hatched'
    && !egg.hatched
    && !egg.creature_id
    && !egg.creatureId
    && !egg.listed);
}

function creatures(state) {
  return list(state?.creatures || state?.inventory?.creatures || state?.player?.creatures);
}

function dungeonRuns(state) {
  return list(state?.dungeonRuns || state?.dungeon?.runs || state?.player?.dungeonRuns);
}

function staminaNow(state) {
  const account = actor(state);
  return Number(account.stamina ?? account.stamina_current ?? state?.stamina ?? 0);
}

function afkState(state) {
  const account = actor(state);
  return account.afk || state?.afk || null;
}

function isPlaced(creature) {
  return creature?.placed || creature?.plot_x !== null && creature?.plot_x !== undefined;
}

function isReadyEgg(egg) {
  if (!egg) return false;
  if (egg.status === 'hatched') return false;
  if (egg.ready === true || egg.status === 'ready') return true;
  const hatchAt = Date.parse(egg.hatch_at || egg.hatchAt || egg.ready_at || egg.readyAt || egg.hatch_ready_at || '');
  return Number.isFinite(hatchAt) && hatchAt <= Date.now();
}

function unincubatedEgg(egg) {
  return egg
    && (egg.status === 'inventory' || egg.status === undefined && !egg.incubating)
    && !egg.hatched
    && !egg.creature_id
    && !egg.creatureId
    && !egg.listed;
}

function strongestCreature(player) {
  return creatures(player)
    .slice()
    .sort((a, b) => Number(b.power || b.level || b.xp || 0) - Number(a.power || a.level || a.xp || 0))[0];
}

function median(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function unitPriceUsd(listing) {
  if (listing?.currency !== 'zenko') return null;
  const price = Number(listing.price_usd);
  if (!Number.isFinite(price) || price <= 0) return null;
  const quantity = Math.max(1, Number(listing.quantity || 1));
  return price / quantity;
}

function saleKey(item) {
  if (!item) return 'unknown';
  if (item.item_kind === 'material') return `${item.item_kind}:${item.resource || 'unknown'}`;
  if (item.item_kind === 'creature') {
    return [
      item.item_kind,
      item.item?.creature_id || 'unknown',
      item.item?.rarity || 'unknown',
      item.item?.variant || 'unknown',
    ].join(':');
  }
  if (item.item_kind === 'egg') return `${item.item_kind}:${item.item?.egg_type || 'unknown'}`;
  if (item.item_kind === 'relic') return `${item.item_kind}:${item.item?.base_id || item.item?.rarity || 'unknown'}`;
  if (item.item_kind === 'cosmetic') return `${item.item_kind}:${item.item?.cosmetic_id || item.item?.rarity || 'unknown'}`;
  return item.item_kind || 'unknown';
}

function byWeakestCreature(a, b) {
  const rarityScore = { Common: 1, Uncommon: 2, Rare: 3, Epic: 4, Legendary: 5, Mythical: 6 };
  return Number(rarityScore[a.rarity] || 0) - Number(rarityScore[b.rarity] || 0)
    || Number(a.level || 0) - Number(b.level || 0)
    || Number(a.creature_xp || 0) - Number(b.creature_xp || 0);
}

export class StrategyEngine {
  constructor(client, state) {
    this.client = client;
    this.state = state;
    this.actionsThisCycle = 0;
    this.state.data.toggles ||= {};
  }

  toggle(key, configDefault) {
    const stored = this.state.data.toggles?.[key];
    return stored === undefined ? configDefault : Boolean(stored);
  }

  setToggle(key, value) {
    this.state.data.toggles ||= {};
    this.state.data.toggles[key] = value;
    this.state.save();
  }

  targetPlaced() {
    return config.ZOLANA_TARGET_PLACED;
  }

  async cycle() {
    this.actionsThisCycle = 0;
    await this.client.ensureLogin();
    let player = await this.ensurePlayer();
    player = await this.runOnboarding(player);
    player = await this.progressEconomy(player);
    await this.marketIntel();
    await this.trackProfit(player);
    this.watchOps(player);
    this.detectNewEggs(player);
    this.state.data.lastPlayer = this.snapshotPlayer(player);
    this.state.save();
  }

  // Append a one-line event to the rolling activity history (shown by /history).
  logHistory(text) {
    const h = list(this.state.data.history);
    h.push({ t: Date.now(), text });
    this.state.data.history = h.slice(-40);
  }

  // Notify + log when a NEW egg shows up in the bag (from gacha, breeding, drops, or
  // rewards) — highlights mystery/premium/golden so a surprise Legendary egg is obvious.
  detectNewEggs(player) {
    const eggs = list(player?.eggs).filter((e) => e && !e.hatched && e.status !== 'hatched' && !e.creature_id);
    const ids = eggs.map((e) => e.id).filter(Boolean);
    const known = this.state.data.knownEggs;
    if (Array.isArray(known)) {
      const knownSet = new Set(known);
      const LABEL = { mystery: '🌟 Mystery', premium: '💠 Premium', golden: '🥇 Golden', breeding: '🧬 Breeding', forest: '🌲 Forest', basic: '🥚 Basic' };
      const POT = { mystery: 'Legendary', premium: 'Rare–Legendary', golden: 'Epic–Legendary', forest: 'up to Rare', breeding: 'inherited from parents', basic: 'Common' };
      for (const e of eggs.filter((x) => x.id && !knownSet.has(x.id))) {
        const type = e.egg_type || 'egg';
        const label = LABEL[type] || `🥚 ${type}`;
        const pot = POT[type] || '?';
        const special = /mystery|premium|golden/i.test(type);
        this.queueNotify({ text: `${special ? '✨ ' : ''}<b>New ${label} egg obtained!</b>\nCan hatch → <b>${pot}</b>. Hatch it with /hatch.` });
        this.logHistory(`${label} egg obtained (${pot})`);
      }
    }
    this.state.data.knownEggs = ids;
  }

  // Future-proofing: the game is actively updated (new `titles`, ZUMMER event,
  // `witch_trial` flag). Alert on Telegram the moment a new event/flag activates so
  // we can add support for any new reward mechanic instead of silently missing it.
  watchOps(player) {
    const ops = player?.ops || {};
    const events = list(ops.events).map((e) => e.id || e.name || JSON.stringify(e));
    const flags = Object.entries(ops.flags || {}).filter(([, v]) => v).map(([k]) => k);
    const seen = this.state.data.opsSeen || { events: [], flags: [] };
    const newEvents = events.filter((e) => !seen.events.includes(e));
    const newFlags = flags.filter((f) => !seen.flags.includes(f));
    if ((newEvents.length || newFlags.length) && this.state.data.opsSeen) {
      this.queueNotify({
        text: `🆕 <b>Game update detected!</b>\n`
          + `New event: <b>${newEvents.join(', ') || '-'}</b>\n`
          + `Active flag: <b>${newFlags.join(', ') || '-'}</b>\n`
          + `Check in-game — there may be a new reward/mechanic.`,
      });
      logger.info({ newEvents, newFlags }, 'new game event/flag detected');
    }
    this.state.data.opsSeen = { events, flags };
  }

  async ensurePlayer() {
    try {
      const loaded = await this.client.loadPlayer();
      return playerFrom(loaded);
    } catch (error) {
      if (error.status !== 404) throw error;
      logger.info('player missing, creating profile');
      const created = await this.act('createPlayer', () => this.client.createPlayer(config.ZOLANA_USERNAME));
      const player = playerFrom(created);
      await this.safeAct('setServer', () => this.client.setServer(config.ZOLANA_SERVER));
      return player || playerFrom(await this.client.loadPlayer());
    }
  }

  async runOnboarding(player) {
    if (!player) return player;
    const account = actor(player);
    if (account.server_id !== config.ZOLANA_SERVER && config.ZOLANA_SERVER) {
      await this.safeAct('setServer', () => this.client.setServer(config.ZOLANA_SERVER));
    }

    const tutorialDone = account.tutorial_progress?.completed_at || Number(account.tutorial_progress?.step || 0) >= 6;
    if (!tutorialDone) {
      for (const step of [1, 2, 3, 4, 6]) {
        await this.safeAct(`tutorial:${step}`, () => this.client.tutorial(step, step === 6));
      }
    }

    if (eggs(player).length === 0 && this.state.ready('starterEgg')) {
      await this.safeAct('grantStarter', () => this.client.grantStarter());
      this.state.cooldown('starterEgg', 60 * 60 * 1000);
    }

    return playerFrom(await this.client.loadPlayer());
  }

  async progressEconomy(player) {
    if (!player) return player;

    // --- Guaranteed daily/idle income ---
    if (this.state.ready('daily')) {
      await this.safeAct('daily', () => this.client.claimDaily());
      this.state.cooldown('daily', DAILY_COOLDOWN_MS);
    }
    if (this.state.ready('idle')) {
      await this.safeAct('idleClaim', () => this.client.claimIdle());
      this.state.cooldown('idle', IDLE_COOLDOWN_MS);
    }

    // --- Free passive claims (hold gems, epoch, dex milestones) ---
    await this.freeClaims(player);

    // --- AFK farming loop ---
    await this.afkFarm(player);

    // --- Egg lifecycle: hatch ready, incubate idle ---
    for (const egg of eggs(player)) {
      const eggId = egg.id || egg.eggId;
      if (!eggId) continue;
      if (isReadyEgg(egg)) await this.safeAct(`hatch:${eggId}`, () => this.client.hatch(eggId));
      else if (unincubatedEgg(egg)) await this.safeAct(`incubate:${eggId}`, () => this.client.incubate(eggId, false));
    }

    // --- Fill empty slots, then make sure the BEST gold-producers are the placed ones ---
    // In the RAID phase the strongest are drafted OUT of the farm into dungeons, so don't
    // re-place them here; farming/placement runs in the FARM phase (and when the
    // stamina-cycle is disabled, always — legacy behavior).
    const account = actor(player);
    const farming = !config.ZOLANA_RAID_STAMINA_CYCLE || this.raidPhaseNow(player) === 'farm';
    if (farming) {
      const slots = Number(account.place_slots || this.targetPlaced());
      const placedCount = creatures(player).filter(isPlaced).length;
      const unplaced = creatures(player).filter((c) => !isPlaced(c)).length;
      if (unplaced > 0 && placedCount < slots) {
        await this.safeAct('placeAuto', () => this.client.placeAuto(slots - placedCount));
      }
      await this.optimizePlacement(player);
    }

    // --- Claim every completed quest (client-computed; +150 acct XP each) ---
    await this.claimQuests(player);

    // --- Feed every placed creature that is off cooldown ---
    for (const creature of creatures(player).filter(isPlaced)) {
      if (!creature?.id) continue;
      if (!this.state.ready(`feed:${creature.id}`)) continue;
      await this.safeAct(`feed:${creature.id}`, () => this.client.feed(creature.id));
      this.state.cooldown(`feed:${creature.id}`, FEED_COOLDOWN_MS);
    }

    // --- Growth + combat autopilot ---
    await this.evolveBest(player);
    await this.breedForRarity(player);
    await this.gemCraftAuto(player);
    await this.spendGemsWisely(player);
    await this.relicAutopilot(player);
    await this.companionAutopilot(player);
    await this.epochAutopilot(player);
    await this.dungeonRun(player);
    await this.pvpRun(player);
    await this.applyProfitRules(player);

    return playerFrom(await this.client.loadPlayer());
  }

  async freeClaims(player) {
    if (!this.toggle('claims', config.ZOLANA_AUTO_CLAIMS)) return;
    if (this.state.ready('holdClaim')) {
      await this.safeAct('holdClaim', () => this.client.holdClaim());
      this.state.cooldown('holdClaim', CLAIMS_COOLDOWN_MS);
    }
    if (this.state.ready('epochClaim')) {
      await this.safeAct('epochClaim', () => this.client.epochClaim());
      this.state.cooldown('epochClaim', CLAIMS_COOLDOWN_MS);
    }
    // Dex milestones are client-computed from distinct species owned (not in the
    // player payload) → claim any whose species threshold is met and unclaimed.
    const species = new Set(creatures(player).map((c) => c.creature_id).filter(Boolean)).size;
    const claims = actor(player).quest_claims || {};
    for (const milestone of DEX_MILESTONES) {
      if (claims[milestone.id]) continue; // dex marks "once" in quest_claims
      if (species < milestone.species) continue;
      await this.safeAct(`dex:${milestone.id}`, () => this.client.dexClaim(milestone.id));
    }
  }

  async claimQuests(player) {
    if (!this.toggle('quests', config.ZOLANA_AUTO_QUESTS)) return;
    if (!this.state.ready('quests')) return;
    const claims = actor(player).quest_claims || {};
    const metrics = questMetrics(player);
    let claimed = 0;
    for (const quest of QUESTS) {
      const stamp = questStamp(quest.period);
      if (claims[quest.id] === stamp) continue; // already claimed this period
      if (Number(metrics[quest.metric] ?? 0) < quest.target) continue; // not complete
      const result = await this.safeAct(`quest:${quest.id}`, () => this.client.claimQuest(quest.id));
      if (result) {
        claimed += 1;
        logger.info({ quest: quest.id, metric: quest.metric }, 'quest claimed (+150 acct xp)');
      }
    }
    this.state.cooldown('quests', claimed > 0 ? 5 * 60 * 1000 : QUESTS_COOLDOWN_MS);
  }

  async afkFarm(player) {
    if (!this.toggle('afk', config.ZOLANA_AUTO_AFK)) return;
    if (!this.state.ready('afk')) return;
    const afk = afkState(player);
    // Collect accumulated rewards without stopping the run, then (re)start if idle.
    if (afk && (afk.afk_started_at || afk.active || afk.zone || afk.afk_zone)) {
      await this.safeAct('afkCollect', () => this.client.afkCollect(false));
    } else {
      await this.safeAct('afkStart', () => this.client.afkStart());
    }
    this.state.cooldown('afk', AFK_COOLDOWN_MS);
  }

  // Ensure the highest gold-per-hour creatures occupy the farm slots. Rarity/variant
  // dominate output (a Legendary = 500× a Common), so evict the weakest placed
  // creatures and place the strongest unplaced ones into the freed plots.
  async optimizePlacement(preloaded = null) {
    const player = preloaded || await this.client.loadPlayer().catch(() => null);
    if (!player) return;
    const slots = Number(actor(player).place_slots || this.targetPlaced());
    const pool = creatures(player).filter((c) => c.id && !c.stored && !c.listed && !c.run_id);
    if (!pool.length) { this.state.cooldown('placement', 15 * 60 * 1000); return; }

    const ranked = pool.slice().sort((a, b) => coinsPerHour(b) - coinsPerHour(a));
    const wantIds = new Set(ranked.slice(0, slots).map((c) => c.id));
    const wantUnplaced = ranked.slice(0, slots).filter((c) => !isPlaced(c));
    if (!wantUnplaced.length) { this.state.cooldown('placement', 15 * 60 * 1000); return; } // already optimal

    // Evict the weakest placed creatures that don't belong in the top-N, reusing
    // their plot coords for the better creatures.
    const evictable = pool
      .filter((c) => isPlaced(c) && !wantIds.has(c.id))
      .sort((a, b) => coinsPerHour(a) - coinsPerHour(b));

    // A BIG upgrade — a strong creature sitting idle (e.g. a just-hatched Legendary/Rare)
    // — bypasses the 15-min anti-churn cooldown so it starts farming IMMEDIATELY. Marginal
    // swaps (Uncommon/Common shuffles) still wait for the cooldown to avoid place/unplace spam.
    const bestIdle = coinsPerHour(wantUnplaced[0]);
    const weakestPlaced = evictable.length ? coinsPerHour(evictable[0]) : 0;
    const bigUpgrade = bestIdle >= 200 || bestIdle >= weakestPlaced * 2;
    if (!this.state.ready('placement') && !bigUpgrade) return;
    const spots = [];
    for (const weak of evictable) {
      if (spots.length >= wantUnplaced.length) break;
      const r = await this.safeAct(`unplace:${weak.id}`, () => this.client.unplace(weak.id));
      if (r) spots.push({ x: weak.plot_x, y: weak.plot_y });
    }
    for (let i = 0; i < Math.min(spots.length, wantUnplaced.length); i += 1) {
      const c = wantUnplaced[i];
      await this.safeAct(`place:${c.id}`, () => this.client.place(c.id, spots[i].x, spots[i].y));
      logger.info({ creature: c.id, rarity: c.rarity, coinsPerHour: Math.round(coinsPerHour(c)) }, 'placed top producer');
    }
    this.state.cooldown('placement', 15 * 60 * 1000);
  }

  async evolveBest(player) {
    if (!this.toggle('evolve', config.ZOLANA_AUTO_EVOLVE)) return;
    if (!this.state.ready('evolve')) return;

    let gold = Number(actor(player).gold || 0);
    let budget = config.ZOLANA_EVOLVE_CYCLE_BUDGET;

    // Push the most-advanced creatures first so a few reach Elder (battle-capable)
    // instead of spreading gold thin. Only spend surplus above the gold reserve.
    const targets = creatures(player)
      .map((c) => ({ c, info: evolveInfo(c) }))
      .filter((x) => x.info)
      .sort((a, b) =>
        STAGES.indexOf(b.info.stage) - STAGES.indexOf(a.info.stage)
        || Number(b.c.creature_xp || 0) - Number(a.c.creature_xp || 0));

    let evolved = 0;
    for (const { c, info } of targets) {
      const cost = info.cfg.evolveCost;
      if (gold - cost < config.ZOLANA_EVOLVE_GOLD_RESERVE) continue;
      if (cost > budget) continue;
      // Only burn creature_xp to skip the timer when the timer isn't already up.
      const useXp = info.xpReady && !info.timeReady;
      const result = await this.safeAct(`evolve:${c.id}`, () => this.client.evolve(c.id, useXp));
      if (result) {
        gold -= cost;
        budget -= cost;
        evolved += 1;
        logger.info({ creature: c.id, from: info.stage, cost }, 'creature evolved');
      }
    }
    this.state.cooldown('evolve', evolved > 0 ? EVOLVE_COOLDOWN_MS : 5 * 60 * 1000);
  }

  // Breeding is the rarity-upgrade path: BOTH parents must be Adult/Elder → offspring
  // egg has a chance at higher rarity (Legendary/Mythical). Keep placed battle-ready
  // creatures; breed surplus Adults.
  async breedForRarity(player) {
    if (!this.toggle('breed', config.ZOLANA_AUTO_BREED)) return;
    if (!this.state.ready('breed')) return;

    const adults = creatures(player)
      .filter((c) => ['Adult', 'Elder'].includes(creatureStage(c)) && !c.listed && !c.stored && !c.run_id)
      .filter((c) => {
        const last = Date.parse(c.last_breed_time || '');
        return !Number.isFinite(last) || Date.now() - last >= BREED_COOLDOWN_MS;
      })
      .sort((a, b) => Number(b.creature_xp || 0) - Number(a.creature_xp || 0));

    if (adults.length < 2) return;
    const [parentA, parentB] = adults;
    const result = await this.safeAct('breed', () => this.client.breed(parentA.id, parentB.id));
    this.state.cooldown('breed', result ? BREED_COOLDOWN_MS : 15 * 60 * 1000);
    if (result) logger.info({ parentA: parentA.id, parentB: parentB.id }, 'bred for rarity upgrade');
  }

  // Gacha is a gems-funded rarity source (standard=8 / deluxe=15 gems). Never touches
  // the SPL token (gems currency only) → zero token risk. Pulls only above keep-floor.
  async gachaAutopilot(player) {
    if (!this.toggle('gacha', config.ZOLANA_AUTO_GACHA)) return;
    if (!this.state.ready('gacha')) return;
    const gems = Number(actor(player).gems || 0);
    const tierCost = config.ZOLANA_GACHA_TIER === 'deluxe' ? 15 : 8;
    if (gems - tierCost < config.ZOLANA_GACHA_KEEP_GEMS) return;
    const result = await this.safeAct('gacha', () => this.client.gachaPull(config.ZOLANA_GACHA_TIER, 'gems'));
    this.state.cooldown('gacha', GACHA_COOLDOWN_MS);
    if (result) {
      logger.info({ tier: config.ZOLANA_GACHA_TIER, cards: result?.gacha?.cards }, 'gacha pull');
      this.state.data.lastGacha = { at: new Date().toISOString(), tier: config.ZOLANA_GACHA_TIER, cards: result?.gacha?.cards };
      // Surface the drop to Telegram (drained by the main loop after the cycle).
      if (result?.gacha) this.queueNotify({ type: 'gacha', gacha: result.gacha });
    }
  }

  // Queue a Telegram message for the main loop to send after the cycle (engine has
  // no telegram handle). Capped so it can't grow unbounded.
  queueNotify(payload) {
    const q = list(this.state.data.notify);
    q.push(payload);
    this.state.data.notify = q.slice(-10);
  }

  // Companion: equip the strongest creature to buff the whole party's raid/PvP
  // power (its abilities like party_power apply team-wide). Free — helps clear higher
  // dungeon regions → more gold/materials. Abilities aren't exposed in the payload,
  // so strongest-by-rarity/stage is the proxy.
  async companionAutopilot(player) {
    if (!this.toggle('companion', config.ZOLANA_AUTO_COMPANION)) return;
    if (!this.state.ready('companion')) return;
    const strongest = creatures(player)
      .filter((c) => c.id && !c.stored && !c.listed)
      .sort((a, b) => byWeakestCreature(b, a))[0]; // strongest first
    if (!strongest?.id) return;
    if (actor(player).equipped_creature === strongest.id) {
      this.state.cooldown('companion', 6 * 60 * 60 * 1000);
      return;
    }
    const res = await this.safeAct('companion', () => this.client.companion(strongest.id));
    this.state.cooldown('companion', res ? 6 * 60 * 60 * 1000 : 30 * 60 * 1000);
    if (res) logger.info({ companion: strongest.id }, 'companion set (party power buff)');
  }

  // Spend gems on the best creature source. Premium egg (50 gems) guarantees
  // Rare/Epic/Legendary — far better value than a gacha pull — so buy it first when
  // unlocked; otherwise fall back to gacha. Phase-locked eggs 402/400 → back off.
  async spendGemsWisely(player) {
    const gems = Number(actor(player).gems || 0);
    if (
      this.toggle('premiumEgg', config.ZOLANA_AUTO_PREMIUM_EGG)
      && gems >= 50
      && this.state.ready('premiumEgg')
    ) {
      const res = await this.safeAct('buyEgg:premium', () => this.client.buyEgg('premium'));
      if (res) {
        this.state.cooldown('premiumEgg', 10 * 60 * 1000);
        logger.info('bought premium egg (Rare/Epic/Legendary)');
        return;
      }
      // Not unlocked yet (Phase-gated) — don't hammer it.
      this.state.cooldown('premiumEgg', 6 * 60 * 60 * 1000);
    }
    await this.gachaAutopilot(player);
  }

  // Forest egg (50k gold) has better odds than basic (up to Rare) — pick it when
  // gold is comfortably above the floor, otherwise the cheap basic.
  growthEggType(gold) {
    if (config.ZOLANA_EGG_PREFER_FOREST && Number(gold) >= config.ZOLANA_FOREST_EGG_GOLD_FLOOR) {
      return 'forest';
    }
    return 'basic';
  }

  // Craft gems for free from dungeon-dropped gem_catalyst (needs 5).
  async gemCraftAuto(player) {
    if (!this.toggle('gemcraft', config.ZOLANA_AUTO_GEMCRAFT)) return;
    if (!this.state.ready('gemcraft')) return;
    const catalyst = list(player?.materials).find((m) => m.material_id === 'gem_catalyst');
    if (!catalyst || Number(catalyst.quantity || 0) < 5) {
      this.state.cooldown('gemcraft', 30 * 60 * 1000);
      return;
    }
    // gemCraft costs 90k gold (server-validated). Never spend it below the d_gold
    // reserve, or the +150 acct-XP/day "hold 30k gold" quest breaks next reset.
    const gold = Number(actor(player).gold || 0);
    if (gold - GEMCRAFT_GOLD_COST < config.ZOLANA_EVOLVE_GOLD_RESERVE) {
      this.state.cooldown('gemcraft', 30 * 60 * 1000);
      return;
    }
    const res = await this.safeAct('gemCraft', () => this.client.gemCraft());
    this.state.cooldown('gemcraft', res ? 10 * 60 * 1000 : 60 * 60 * 1000);
    if (res) logger.info('crafted gems from gem_catalyst');
  }

  // Relics: craft + equip to unlock the d_equip (+150 acct XP/day, recurring) and
  // w_relics quests. Craft costs gold (server-validated) → only when gold is above
  // the floor so it doesn't starve the evolve reserve / d_gold quest.
  async relicAutopilot(player) {
    if (!this.toggle('relic', config.ZOLANA_AUTO_RELIC)) return;
    if (!this.state.ready('relic')) return;

    const owned = list(player?.relics);
    // Always keep at least one relic equipped so d_equip stays claimable.
    if (owned.length > 0) await this.ensureRelicEquipped(player, owned);

    if (owned.length >= config.ZOLANA_RELIC_TARGET) {
      this.state.cooldown('relic', 6 * 60 * 60 * 1000);
      return;
    }
    const gold = Number(actor(player).gold || 0);
    if (gold < config.ZOLANA_RELIC_CRAFT_GOLD_FLOOR) {
      this.state.cooldown('relic', 30 * 60 * 1000);
      return;
    }

    // Build a set across the three relic slots.
    const slots = ['amulet', 'ring', 'idol'];
    const slot = slots[owned.length % slots.length];
    const crafted = await this.safeAct(`relicCraft:${slot}`, () => this.client.relicCraft(slot, 'common'));
    this.state.cooldown('relic', crafted ? 30 * 60 * 1000 : 60 * 60 * 1000);
    if (crafted) {
      logger.info({ slot }, 'relic crafted');
      const fresh = playerFrom(await this.client.loadPlayer().catch(() => null));
      if (fresh) await this.ensureRelicEquipped(fresh, list(fresh?.relics));
    }
  }

  async ensureRelicEquipped(player, relics) {
    // Relics buff the creature they're equipped on (equipped_on). Equip EVERY
    // unequipped relic onto a party creature — rarest first — so party power grows.
    const party = creatures(player)
      .filter((c) => c.id && !c.stored && !c.listed)
      .sort((a, b) => byWeakestCreature(b, a)); // strongest first
    const rank = { Common: 1, Uncommon: 2, Rare: 3, Epic: 4, Legendary: 5, Mythical: 6 };
    const combat = (r) => (r.class === 'combat' ? 1 : 0);
    // Equip the best relics first: COMBAT-class (raw party power, enhanceable ×3) before
    // utility, then by rarity. Skip anything listed/stored so we never equip a for-sale relic.
    const unequipped = relics
      .filter((r) => !r.equipped_on && !r.listed && !r.stored)
      .sort((a, b) => combat(b) - combat(a) || (rank[b.rarity] || 0) - (rank[a.rarity] || 0));

    for (const relic of unequipped) {
      const relicId = relic.id || relic.relic_id;
      if (!relicId) continue;
      const slot = relic.slot || relic.equip_slot || 'power_pct';
      let equipped = false;
      // A relic slot can only hold one relic per creature → fall back across the party.
      for (const target of party.slice(0, 6)) {
        const res = await this.safeAct(`relicEquip:${relicId}`, () => this.client.relicEquip(relicId, target.id, slot));
        if (res) { logger.info({ relicId, target: target.id, slot }, 'relic equipped'); equipped = true; break; }
      }
      if (!equipped) break; // action budget hit or nowhere to place — try next cycle
    }

    // Enhance the BEST equipped relic with surplus relic_shard → most party power per
    // shard. Post-rework, COMBAT-class relics stack power above the cap (up to ×3), so
    // prioritise those; then rarest, then least-enhanced.
    const erank = { Common: 1, Uncommon: 2, Rare: 3, Epic: 4, Legendary: 5, Mythical: 6 };
    const isCombat = (r) => (r.class === 'combat' ? 1 : 0);
    const toEnhance = relics
      .filter((r) => r.equipped_on)
      .sort((a, b) => isCombat(b) - isCombat(a)
        || (erank[b.rarity] || 0) - (erank[a.rarity] || 0)
        || (Number(a.enhance_level) || 0) - (Number(b.enhance_level) || 0))[0];
    if (toEnhance) await this.enhanceRelic(player, toEnhance);
  }

  // Spend surplus relic_shard (dungeon drop) to enhance the equipped relic → more
  // party power. Server validates cost/cap; safeAct swallows "maxed"/"not enough".
  async enhanceRelic(player, relic) {
    if (!this.toggle('relicEnhance', config.ZOLANA_AUTO_RELIC_ENHANCE)) return;
    if (!this.state.ready('relicEnhance')) return;
    const relicId = relic?.id || relic?.relic_id;
    if (!relicId) return;
    const shards = list(player?.materials).find((m) => m.material_id === 'relic_shard');
    if (!shards || Number(shards.quantity || 0) <= config.ZOLANA_RELIC_SHARD_KEEP) {
      this.state.cooldown('relicEnhance', 60 * 60 * 1000);
      return;
    }
    // Post-rework the enhance is a deep GOLD sink — only spend when gold is above the
    // floor so it never drains into the d_gold quest reserve.
    if (Number(actor(player).gold || 0) < config.ZOLANA_RELIC_ENHANCE_GOLD_FLOOR) {
      this.state.cooldown('relicEnhance', 60 * 60 * 1000);
      return;
    }
    const res = await this.safeAct(`relicEnhance:${relicId}`, () => this.client.relicEnhance(relicId));
    this.state.cooldown('relicEnhance', res ? 20 * 60 * 1000 : 60 * 60 * 1000);
    if (res) logger.info({ relicId }, 'relic enhanced (party power up)');
  }

  // Epoch: donate a full recipe of surplus gold + materials during a funding window
  // for a $ZOLANA rebate (NOT level-gated). No-ops once the epoch is "open" (then you
  // claim gems instead, handled in freeClaims). Only donates when we have everything
  // AND stay above the gold floor — never spends into the leveling reserve.
  async epochAutopilot(player) {
    if (!this.toggle('epoch', config.ZOLANA_AUTO_EPOCH)) return;
    if (!this.state.ready('epoch')) return;
    this.state.cooldown('epoch', 60 * 60 * 1000);

    const data = await this.safeAct('epoch:read', () => this.client.epoch());
    const epoch = data?.epoch;
    if (!epoch || ['open', 'closed', 'settled'].includes(epoch.status)) return;
    if (data.donation) return; // already donated this epoch

    const recipe = data.recipe || {};
    const needGold = Number(recipe.gold || 0);
    if (!needGold) return;
    const gold = Number(actor(player).gold || 0);
    if (gold - needGold < config.ZOLANA_EPOCH_DONATE_GOLD_FLOOR) return;

    const have = Object.fromEntries(list(player?.materials).map((m) => [m.material_id, Number(m.quantity || 0)]));
    for (const [key, qty] of Object.entries(recipe)) {
      if (key === 'gold') continue;
      if ((have[key] || 0) < Number(qty)) return; // not enough materials
    }
    const res = await this.safeAct('epoch:donate', () => this.client.epochDonate(recipe));
    if (res) {
      logger.info({ recipe }, 'epoch donated for $ZOLANA rebate');
      this.state.data.lastEpochDonate = { at: new Date().toISOString(), recipe };
    }
  }

  // Opt-in ($ZOLANA spend, default OFF): when stamina is drained, buy a full restore so
  // raiding resumes immediately instead of waiting ~22h for regen (1 stamina / 8.9 min).
  // Hard daily cap + reserve guard (inside staminaRestore) so it can never runaway-drain
  // the wallet. Real on-chain transfer — only fires with ZOLANA_REAL_RUN.
  async autoBuyStamina(player, stamina) {
    if (!this.toggle('autostamina', config.ZOLANA_AUTO_STAMINA)) return 0;
    if (!config.ZOLANA_REAL_RUN) return 0;
    if (this.actionsThisCycle >= config.ZOLANA_MAX_ACTIONS_PER_CYCLE) return 0;
    if (stamina >= Math.min(...REGION_STAMINA)) return 0; // only when truly drained
    const day = Math.floor(Date.now() / 86400000);
    const rec = this.state.data.autoStamina?.day === day
      ? this.state.data.autoStamina : { day, count: 0 };
    if (rec.count >= config.ZOLANA_AUTO_STAMINA_MAX_PER_DAY) { this.state.data.autoStamina = rec; return 0; }
    this.actionsThisCycle += 1;
    const res = await this.safeAct('autoStamina', () => this.client.staminaRestore('full'));
    let refilled = 0;
    if (res) {
      rec.count += 1;
      // Read the new (full) stamina from the response so the caller can raid THIS cycle
      // instead of idling until the next one; fall back to the observed max.
      refilled = staminaNow(res) || Number(this.state.data.raid?.staminaMax) || 180;
      logger.info({ buysToday: rec.count, stamina: refilled, cost: config.ZOLANA_STAMINA_ZENKO_COST }, 'auto-bought stamina');
      this.queueNotify({ text: `⚡ <b>Auto-bought full stamina</b> for ${config.ZOLANA_STAMINA_ZENKO_COST} $ZOLANA — raiding now. (${rec.count}/${config.ZOLANA_AUTO_STAMINA_MAX_PER_DAY} today)` });
      this.logHistory(`⚡ Auto-bought stamina (${config.ZOLANA_STAMINA_ZENKO_COST} $ZOLANA)`);
    }
    this.state.data.autoStamina = rec;
    this.state.save();
    return refilled;
  }

  // Read-only phase for this cycle (does not persist — dungeonRun owns the write). Lets
  // placement know whether the strongest are farming (FARM) or being drafted to raid.
  raidPhaseNow(player) {
    return decideRaidPhase(this.state.data.raid, staminaNow(player), {
      cheapest: Math.min(...REGION_STAMINA),
      refillFrac: config.ZOLANA_RAID_REFILL_FRAC,
    }).phase;
  }

  async dungeonRun(player) {
    if (!this.toggle('dungeon', config.ZOLANA_AUTO_DUNGEON)) return;

    // Claim finished runs. Real fields: status ('active'→'completed'/'claimable')
    // and ready_at (ISO). Only claim when actually ready to avoid wasted attempts.
    // Creatures on an unfinished run keep run_id set, so the party filter below
    // won't double-commit them (the server also caps concurrent runs).
    for (const run of dungeonRuns(player)) {
      const runId = run.id || run.runId;
      if (!runId) continue;
      const readyAt = Date.parse(run.ready_at || run.ends_at || '');
      const done = ['completed', 'claimable', 'ready', 'done'].includes(run.status)
        || run.completed || run.claimable
        || (Number.isFinite(readyAt) && readyAt <= Date.now());
      if (done) await this.safeAct(`dungeonClaim:${runId}`, () => this.client.dungeonClaim(runId));
    }

    // Stamina-cycle disabled → legacy "farm the strongest, raid with the rest".
    if (!config.ZOLANA_RAID_STAMINA_CYCLE) return this.dungeonRunLegacy(player);

    // --- Phase machine: RAID (drain stamina with the strongest) ⇄ FARM (regen) ---
    let stamina = staminaNow(player);
    const cheapest = Math.min(...REGION_STAMINA);
    const prev = this.state.data.raid;
    const phase = decideRaidPhase(prev, stamina, { cheapest, refillFrac: config.ZOLANA_RAID_REFILL_FRAC });
    if (!prev || prev.phase !== phase.phase) {
      logger.info({ from: prev?.phase || 'init', to: phase.phase, stamina, staminaMax: phase.staminaMax }, 'raid phase switch');
      // Notify on the TRANSITION only (never every cycle) so the activity feed isn't spammed.
      const pct = phase.staminaMax ? Math.round((stamina / phase.staminaMax) * 100) : 0;
      const msg = phase.phase === 'raid'
        ? `⚔️ <b>RAIDING</b> — stamina full (${stamina}/${phase.staminaMax}), storming dungeons with the strongest creatures.`
        : `🌾 <b>FARMING (AFK)</b> — stamina drained (${stamina}/${phase.staminaMax}, ${pct}%), farming gold while it regenerates.`;
      this.queueNotify({ text: msg });
    }
    this.state.data.raid = phase;
    this.state.save();

    // FARM phase → no raids; optimizePlacement already farms the strongest for gold.
    // Optionally auto-buy stamina ($ZOLANA) to resume raiding instead of waiting ~22h.
    // If it refills, DON'T return — raid this same cycle so there's no ~3-min idle gap.
    if (phase.phase === 'farm') {
      const refilled = await this.autoBuyStamina(player, stamina);
      if (!refilled) return;
      stamina = refilled;
      this.state.data.raid = { phase: 'raid', staminaMax: Math.max(Number(phase.staminaMax || 0), refilled) };
      this.state.save();
    }

    // RAID phase → fire the strongest creatures in PARALLEL bursts (server allows many
    // concurrent runs), each party climbing to the highest floor its DETECTED power can
    // clear, spending stamina until the account drains and flips to FARM. Power isn't on
    // the creature payload, so we learn it per party from dungeonStart's `party_power`
    // (success) or the "have N" reject (ceiling) and match the floor to it via pickFloor.
    const affordable = DUNGEONS.filter((d) => stamina >= d.staminaCost).sort((a, b) => b.id - a.id);
    if (!affordable.length) return;

    let pool = creatures(player)
      .filter((c) => c.id && !c.run_id && !c.listed && !c.stored && !c.bound)
      .sort((a, b) => byWeakestCreature(b, a)); // strongest first

    const startParty = async (target, trio) => {
      // A creature is placed XOR raiding — unplace any farmers we're drafting into a raid.
      for (const c of trio) {
        if (isPlaced(c)) await this.safeAct(`unplace:${c.id}`, () => this.client.unplace(c.id));
      }
      this.actionsThisCycle += 1;
      const ids = trio.map((c) => c.id);
      try {
        const result = await this.client.dungeonStart(target.id, ids);
        this.state.count(`dungeonStart:f${target.id}`);
        const run = dungeonRuns(result).find((r) => Array.isArray(r.party) && r.party.includes(ids[0]));
        const pw = Number(run?.party_power);
        if (Number.isFinite(pw) && pw > 0) {
          this.state.data.partyPower = pw;
          // Remember the strongest party ever fielded so next cycle's FIRST (strongest)
          // party is targeted at the high floors it can actually clear — not bonsai'd to
          // floor 1 by the previous cycle's weakest party.
          this.state.data.maxPartyPower = Math.max(Number(this.state.data.maxPartyPower || 0), pw);
          this.state.save();
        }
        logger.info({ floor: target.id, region: target.name, gold: target.goldMin, power: pw }, 'raid started');
        return { ok: true, power: pw };
      } catch (error) {
        const have = /have (\d+)/i.exec(error.message || '')?.[1];
        if (have) { this.state.data.partyPower = Number(have); this.state.save(); }
        logger.warn({ floor: target.id, message: error.message }, 'raid start skipped');
        return { ok: false, power: have ? Number(have) : null };
      }
    };

    let remStamina = stamina;
    // Parties are strongest-first, so each party's power ≤ the previous one's. Seed the
    // FIRST party at the highest power ever detected (climbs the deep floors), then step
    // the estimate DOWN to each party's real power as we go — never bonsai'd to floor 1.
    let est = this.state.data.maxPartyPower ?? this.state.data.partyPower ?? null;
    while (pool.length >= 3
      && this.actionsThisCycle < config.ZOLANA_MAX_ACTIONS_PER_CYCLE
      && config.ZOLANA_REAL_RUN) {
      const target = pickFloor(affordable, est, remStamina);
      if (!target) break; // can't afford even the cheapest floor → stamina is drained
      const trio = pool.slice(0, 3);
      pool = pool.slice(3);
      const res = await startParty(target, trio);
      if (res.ok) {
        remStamina -= target.staminaCost;
        if (res.power) est = res.power; // next (weaker) party is capped by this one
        continue;
      }
      // Rejected → we just learned this trio's real ceiling; retry IT at the right floor.
      if (res.power) est = res.power;
      const retry = pickFloor(affordable, est, remStamina);
      if (retry && retry.id !== target.id && this.actionsThisCycle < config.ZOLANA_MAX_ACTIONS_PER_CYCLE) {
        const r2 = await startParty(retry, trio);
        if (r2.ok) { remStamina -= retry.staminaCost; if (r2.power) est = r2.power; }
      }
    }
    // Keep the burst going next cycle while stamina remains (no long cooldown in RAID).
  }

  // Legacy dungeon strategy (pre stamina-cycle): reserve the top gold-producers as
  // farmers and raid with the strongest of the rest, one run per cooldown window.
  async dungeonRunLegacy(player) {
    if (!this.state.ready('dungeon')) return;

    const stamina = staminaNow(player);
    const affordable = DUNGEONS
      .filter((d) => stamina >= d.staminaCost)
      .sort((a, b) => b.id - a.id);
    if (!affordable.length) { this.state.cooldown('dungeon', DUNGEON_COOLDOWN_MS); return; }

    const slots = Number(actor(player).place_slots || this.targetPlaced());
    const farmers = new Set(
      creatures(player).filter((c) => c.id && !c.stored && !c.listed)
        .sort((a, b) => coinsPerHour(b) - coinsPerHour(a)).slice(0, slots).map((c) => c.id),
    );
    const party = creatures(player)
      .filter((c) => c.id && !c.run_id && !c.listed && !c.stored && !farmers.has(c.id))
      .sort((a, b) => byWeakestCreature(b, a))
      .slice(0, 3)
      .map((c) => c.id);
    if (party.length < 3) { this.state.cooldown('dungeon', DUNGEON_COOLDOWN_MS); return; }

    const floorFor = (p) => (p == null
      ? affordable[0]
      : (affordable.find((d) => dungeonReqPower(d.id) <= p) || affordable[affordable.length - 1]));

    const tryStart = async (target) => {
      if (this.actionsThisCycle >= config.ZOLANA_MAX_ACTIONS_PER_CYCLE || !config.ZOLANA_REAL_RUN) return 'skip';
      this.actionsThisCycle += 1;
      try {
        const result = await this.client.dungeonStart(target.id, party);
        this.state.count(`dungeonStart:f${target.id}`);
        const run = dungeonRuns(result).find((r) => Array.isArray(r.party) && r.party.includes(party[0]));
        const pw = Number(run?.party_power);
        if (Number.isFinite(pw) && pw > 0) { this.state.data.partyPower = pw; this.state.save(); }
        logger.info({ floor: target.id, region: target.name, gold: target.goldMin, power: pw }, 'dungeon started');
        return true;
      } catch (error) {
        const have = /have (\d+)/i.exec(error.message || '')?.[1];
        if (have) { this.state.data.partyPower = Number(have); this.state.save(); }
        logger.warn({ floor: target.id, message: error.message }, 'dungeon start skipped');
        return false;
      }
    };

    const target = floorFor(this.state.data.partyPower);
    const ok = await tryStart(target);
    if (ok === false && this.state.data.partyPower != null) {
      const retry = floorFor(this.state.data.partyPower);
      if (retry && retry.id !== target.id) await tryStart(retry);
    }
    this.state.cooldown('dungeon', DUNGEON_COOLDOWN_MS);
  }

  async pvpRun(player) {
    if (!this.toggle('pvp', config.ZOLANA_AUTO_PVP)) return;
    if (!this.state.ready('pvp')) return;
    this.state.cooldown('pvp', PVP_COOLDOWN_MS);

    // Only Elder creatures can battle — need 3 to field a team. Gate here so we don't
    // spam failed matches every cooldown until the account has Elders.
    const elders = creatures(player)
      .filter((c) => c.id && creatureStage(c) === 'Elder' && !c.listed && !c.stored)
      .sort((a, b) => battlePower(b) - battlePower(a));
    if (elders.length < 3) return;

    // PvP costs a ticket (regens ~1 / 2.4h). Read state to avoid burning a wasted call.
    const pvp = await this.safeAct('pvp:read', () => this.client.pvp());
    const tickets = Number(pvp?.me?.tickets ?? 1);

    // Strongest 3 Elders; PvP payload is [{rowId, formation}], middle = "front" tank.
    const top = elders.slice(0, 3).map((c) => c.id);
    const team = top.map((rowId, idx) => ({ rowId, formation: idx === 1 ? 'front' : 'back' }));

    // Set the team once (also serves as the DEFENSE team → passive points when
    // attackers lose to us).
    if (this.state.ready('pvpTeam')) {
      await this.safeAct('pvpTeam', () => this.client.pvpTeam(team));
      this.state.cooldown('pvpTeam', 6 * 60 * 60 * 1000);
    }

    // Attack only when a ticket is available.
    if (tickets >= 1) {
      const result = await this.safeAct('pvpMatch', () => this.client.pvpMatch());
      if (result) {
        const won = result?.pvp?.result === 'win' || result?.won === true;
        this.state.data.lastPvp = { at: new Date().toISOString(), won, result: result.pvp || result };
        this.queueNotify({ text: `⚔️ <b>PvP ${won ? '🏆 WON' : 'done'}</b> — tier ${pvp?.me?.tier || '-'} · rank ${pvp?.me?.rank ?? '-'}` });
      }
    }
  }

  async trackProfit(player) {
    if (!this.state.ready('price')) return;
    const priceData = await this.safeAct('price', () => this.client.price());
    const usd = Number(priceData?.zolanaPriceUsd);
    if (!Number.isFinite(usd) || usd <= 0) {
      this.state.cooldown('price', PRICE_COOLDOWN_MS);
      return;
    }
    let token = null;
    try {
      token = await this.client.wallet.tokenBalance();
    } catch { /* token account may not exist yet */ }
    const account = actor(player);
    const entry = {
      at: new Date().toISOString(),
      zolanaPriceUsd: usd,
      tokenBalance: token ? token.uiAmount : null,
      tokenUsd: token ? Number((token.uiAmount * usd).toFixed(4)) : null,
      gold: Number(account.gold || 0),
      gems: Number(account.gems || 0),
      zenko: Number(account.zenko_balance || 0),
      level: Number(account.level || 0),
    };
    this.state.data.profit = entry;
    const history = list(this.state.data.profitHistory);
    history.push(entry);
    this.state.data.profitHistory = history.slice(-96);
    this.state.cooldown('price', PRICE_COOLDOWN_MS);
  }

  async applyProfitRules(player) {
    const account = actor(player);
    const target = this.targetPlaced();
    const placedCount = creatures(player).filter(isPlaced).length;
    const creatureCount = creatures(player).length;
    const eggCount = activeEggs(player).length;
    const gold = Number(account.gold || 0);
    const growthStock = creatureCount + eggCount;
    // Don't re-place creatures while the RAID phase is drafting them into dungeons
    // (otherwise we'd fight dungeonRun's unplace and churn the action budget).
    const farming = !config.ZOLANA_RAID_STAMINA_CYCLE || this.raidPhaseNow(player) === 'farm';

    // Bootstrap growth: hatched eggs stay in the API response as history, so only
    // active eggs count toward filling farm slots.
    const buyEggOn = this.toggle('buyegg', config.ZOLANA_AUTO_BUY_EGG);
    if (
      buyEggOn
      && growthStock < target
      && gold >= BASIC_EGG_COST
      && this.state.ready('buyEgg:basic')
    ) {
      const type = this.growthEggType(gold);
      await this.safeAct(`buyEgg:${type}`, () => this.client.buyEgg(type));
      this.state.cooldown('buyEgg:basic', 60_000);
      return;
    }

    if (farming && creatureCount > placedCount && placedCount < target) {
      await this.safeAct('placeAuto', () => this.client.placeAuto(target - placedCount));
    }

    // Farm expansion pipeline: once the current plots are full, keep a tiny
    // reserve of active eggs so the account grows into new creatures over time.
    if (
      buyEggOn
      && placedCount >= target
      && eggCount < config.ZOLANA_EGG_RESERVE_TARGET
      && gold >= config.ZOLANA_EGG_BUY_GOLD_FLOOR
      && gold - BASIC_EGG_COST >= config.ZOLANA_EGG_BUY_GOLD_RESERVE
      && this.state.ready('buyEgg:reserve')
    ) {
      await this.safeAct('buyEgg:reserve', () => this.client.buyEgg('basic'));
      this.state.cooldown('buyEgg:reserve', 3 * 60_000);
      return;
    }

    // Slot expansion: every plot is placed and gold is piling up → buy another plot to grow income.
    if (
      this.toggle('slots', config.ZOLANA_AUTO_SLOTS)
      && placedCount >= target
      && creatureCount > placedCount
      && gold >= config.ZOLANA_SLOT_BUY_GOLD_FLOOR
      && this.state.ready('buySlot')
    ) {
      const bought = await this.safeAct('buySlot', () => this.client.buyPlaceSlot());
      this.state.cooldown('buySlot', SLOT_COOLDOWN_MS);
      if (bought && farming) await this.safeAct('placeAuto', () => this.client.placeAuto(1));
    }
  }

  // Notify when one of OUR listings sells. We snapshot our active listing IDs in
  // state.data.myListings; next cycle a listing that turned non-active (sold_at/buyer/
  // status) or vanished AND shows up in recentSales as our sale = SOLD. Pure
  // disappearance with no sale trace = expired/cancelled (stays silent).
  detectSoldListings(mineListings = [], recentSales = []) {
    const wallet = this.client.wallet.publicKey;
    const prev = this.state.data.myListings || {};
    const soldById = {};
    for (const s of list(recentSales)) {
      if (s?.id && s.seller === wallet) soldById[s.id] = s;
    }
    const notes = [];
    const active = {};
    const present = new Set();
    for (const l of list(mineListings)) {
      if (!l?.id) continue;
      present.add(l.id);
      const isSold = l.sold_at || l.buyer || (l.status && l.status !== 'active');
      if (isSold) {
        if (prev[l.id]) { notes.push(this.saleNote(l)); this.logHistory(`💰 Sold ${this.marketItemName(l)} $${l.price_usd ?? '?'}`); }
        continue;
      }
      active[l.id] = { kind: l.item_kind, price: l.price_usd, resource: l.resource, qty: l.quantity };
    }
    for (const id of Object.keys(prev)) {
      if (present.has(id)) continue; // already handled (sold in-place) above
      if (soldById[id]) { notes.push(this.saleNote(soldById[id])); this.logHistory(`💰 Sold ${this.marketItemName(soldById[id])} $${soldById[id].price_usd ?? '?'}`); }
    }
    this.state.data.myListings = active;
    return notes;
  }

  // Human name for a market row, per kind (creature_id/egg_type/base_id/cosmetic_id/resource).
  marketItemName(x) {
    const it = x.item || {};
    return it.creature_id || (it.egg_type ? `${it.egg_type} egg` : null)
      || it.base_id || it.cosmetic_id || x.resource || x.item_kind || 'item';
  }

  saleNote(x) {
    const name = this.marketItemName(x);
    const qty = x.quantity ? `×${Math.round(Number(x.quantity)).toLocaleString('en-US')} ` : '';
    const price = x.price_usd != null ? `$${x.price_usd}` : (x.price_gems != null ? `${x.price_gems}💎` : '?');
    const buyer = x.buyer ? `\n👤 buyer <code>${String(x.buyer).slice(0, 6)}…</code>` : '';
    return `💰 <b>SOLD!</b> ${qty}${name} — <b>${price}</b>${buyer}`;
  }

  // List an item AND fire a Telegram notification on success. Tracking of the new
  // listing ID happens on the next marketIntel via marketMine (detectSoldListings).
  async listOnMarket(actName, payload) {
    const res = await this.safeAct(actName, () => this.client.marketList(payload));
    if (res) {
      const name = payload.resource || payload.itemKind || 'item';
      const qty = payload.quantity ? `×${Math.round(Number(payload.quantity)).toLocaleString('en-US')} ` : '';
      this.queueNotify({ text: `🏷️ <b>Listed on market</b>\n${qty}${name} — <b>$${payload.priceUsd}</b>` });
      this.logHistory(`🏷️ Listed ${qty}${name} $${payload.priceUsd}`);
    }
    return res;
  }

  // Idempotent market browse that never throws and never touches the action budget.
  async browseMarket(kind) {
    try {
      return await this.client.market(kind, { sort: 'cheap', limit: 50 });
    } catch (error) {
      logger.warn({ kind, message: error.message }, 'market browse failed');
      return null;
    }
  }

  async marketIntel() {
    if (!this.state.ready('market')) return;
    const summary = {};
    const books = {};
    const recent = await this.safeAct('market:recent-sales', () => this.client.recentSales()) || {};
    const recentSales = list(recent.sales);
    const mine = await this.safeAct('market:mine:intel', () => this.client.marketMine());
    if (mine) {
      for (const note of this.detectSoldListings(list(mine.listings), recentSales)) {
        this.queueNotify({ text: note });
      }
    }

    for (const kind of MARKET_KINDS) {
      await sleep(MARKET_INTEL_DELAY_MS); // pace calls so Cloudflare doesn't rate-limit the batch → empty
      // Browse is an idempotent GET — call directly (NOT via safeAct) so these ~8 reads
      // don't burn the per-cycle write-action budget and starve raids/sells.
      let data = await this.browseMarket(kind);
      // Empty almost always means rate-limited (not truly 0 listings) — retry once after a pause.
      if (!list(data?.listings).length) {
        await sleep(MARKET_INTEL_DELAY_MS * 2);
        data = (await this.browseMarket(kind)) || data;
      }
      const listings = list(data?.listings);
      books[kind] = listings;
      const priced = listings
        .map((item) => ({ price: unitPriceUsd(item), item }))
        .filter((item) => Number.isFinite(item.price));
      priced.sort((a, b) => a.price - b.price);
      summary[kind] = {
        count: listings.length,
        floorUnitUsd: priced[0]?.price ?? null,
        medianUnitUsd: median(priced.map((item) => item.price)),
        bestListing: priced[0]?.item?.id ?? null,
        gemFloor: median(listings
          .filter((item) => item.currency === 'gems')
          .map((item) => Number(item.price_gems) / Math.max(1, Number(item.quantity || 1)))),
      };
    }

    const salesByKey = {};
    for (const sale of recentSales) {
      const price = unitPriceUsd(sale);
      if (!Number.isFinite(price)) continue;
      const key = saleKey(sale);
      salesByKey[key] ||= [];
      salesByKey[key].push(price);
    }
    for (const [key, values] of Object.entries(salesByKey)) {
      salesByKey[key] = median(values);
    }

    this.state.data.market = { checkedAt: new Date().toISOString(), summary };
    if (config.ZOLANA_AUTO_MARKET) {
      await this.marketAutopilot(books, salesByKey, summary);
    }
    this.state.cooldown('market', MARKET_COOLDOWN_MS);
    logger.info({ market: summary }, 'market intelligence updated');
  }

  async marketAutopilot(books, salesByKey, summary) {
    if (this.toggle('marketSell', config.ZOLANA_AUTO_MARKET_SELL)) await this.autoListInventory(summary, books);
    if (this.toggle('marketBuy', config.ZOLANA_AUTO_MARKET_BUY)) await this.autoBuyNeeded(books, salesByKey);
  }

  async autoBuyNeeded(books, salesByKey) {
    if (!this.state.ready('market:auto-buy')) return;

    // Needs gate: only buy growth items while the farm still has room. Once we
    // hold enough creatures+eggs to fill the target slots, stop buying entirely.
    const player = await this.client.loadPlayer().catch(() => null);
    const stock = player ? creatures(player).length + activeEggs(player).length : 0;
    const roomToGrow = stock < this.targetPlaced();
    if (!roomToGrow) {
      logger.info({ stock, target: this.targetPlaced() }, 'market auto-buy skipped: farm already stocked');
      this.state.cooldown('market:auto-buy', 60 * 60 * 1000);
      return;
    }

    const allowedKinds = new Set(
      String(config.ZOLANA_MARKET_BUY_KINDS).split(',').map((k) => k.trim()).filter(Boolean),
    );

    const token = await this.client.wallet.tokenBalance();
    const available = Number(token.uiAmount) - config.ZOLANA_MARKET_ZOLANA_RESERVE;
    if (available <= 0) {
      logger.info({ balance: token.uiAmount, reserve: config.ZOLANA_MARKET_ZOLANA_RESERVE }, 'market auto-buy skipped: reserve locked');
      return;
    }

    const candidates = [];
    for (const [kind, listings] of Object.entries(books)) {
      if (!allowedKinds.has(kind)) continue; // never speculate on non-growth kinds
      const activeUnits = listings.map(unitPriceUsd).filter(Number.isFinite);
      const activeMedian = median(activeUnits);
      for (const listing of listings) {
        const priceUsd = Number(listing.price_usd);
        const unit = unitPriceUsd(listing);
        if (!Number.isFinite(priceUsd) || !Number.isFinite(unit)) continue;
        if (priceUsd > config.ZOLANA_MARKET_MAX_BUY_USD) continue;
        if (listing.seller === this.client.wallet.publicKey) continue;
        const saleMedian = salesByKey[saleKey(listing)] ?? null;
        const reference = saleMedian && activeMedian ? Math.min(saleMedian, activeMedian) : saleMedian ?? activeMedian;
        if (!Number.isFinite(reference) || reference <= 0) continue;
        const edgeBps = Math.round((1 - unit / reference) * 10_000);
        if (edgeBps < config.ZOLANA_MARKET_MIN_EDGE_BPS) continue;
        candidates.push({ kind, listing, unit, reference, edgeBps, priceUsd });
      }
    }

    candidates.sort((a, b) => b.edgeBps - a.edgeBps || a.priceUsd - b.priceUsd);
    let spent = 0;
    let buys = 0;
    for (const candidate of candidates) {
      if (buys >= config.ZOLANA_MARKET_MAX_BUYS_PER_CYCLE) break;
      if (!this.state.ready(`market:buy:${candidate.listing.id}`)) continue;
      const quote = await this.safeAct(`market:quote:${candidate.listing.id}`, () => this.client.marketQuote(candidate.listing.id));
      if (!quote) continue;
      const total = Number(BigInt(quote.zolanaTotal)) / 10 ** Number(quote.decimals || token.decimals || 6);
      if (spent + total > config.ZOLANA_MARKET_CYCLE_BUDGET_ZOLANA) continue;
      if (token.uiAmount - spent - total < config.ZOLANA_MARKET_ZOLANA_RESERVE) continue;

      await this.safeAct(`market:buy:${candidate.listing.id}`, () => this.client.marketBuyWithQuote(quote));
      spent += total;
      buys += 1;
      this.state.cooldown(`market:buy:${candidate.listing.id}`, 24 * 60 * 60 * 1000);
      logger.info({
        listing: candidate.listing.id,
        kind: candidate.kind,
        edgeBps: candidate.edgeBps,
        spentZolana: total,
      }, 'market auto-buy executed');
    }

    this.state.cooldown('market:auto-buy', buys > 0 ? 10 * 60 * 1000 : 60 * 60 * 1000);
  }

  async autoListInventory(summary = {}, books = {}) {
    const player = await this.client.loadPlayer();
    const account = actor(player);
    if (Number(account.level || 1) < config.ZOLANA_MARKET_SELL_LEVEL) {
      logger.info({
        level: account.level,
        required: config.ZOLANA_MARKET_SELL_LEVEL,
      }, 'market auto-sell locked by game level');
      return;
    }

    const mine = await this.safeAct('market:mine', () => this.client.marketMine()) || {};
    const listedIds = new Set(list(mine.listings).map((item) => item.item_id).filter(Boolean));

    // --- Sell surplus LOW-rarity creatures at a market-driven price (undercut floor) ---
    // Auto-sell only Common + Uncommon (below Rare). Rare/Epic/Legendary/Mythical are
    // KEPT for the user to sell manually via /sell — they're worth far more as
    // producers/breeders than the tiny auto-price. Sell the weakest first, keep a
    // buffer, and never touch placed/bound/listed/on-run ones.
    const spareCreatures = creatures(player)
      .filter((item) => AUTO_SELL_RARITIES.has(item.rarity)
        && !item.bound && !item.stored && !item.listed
        && !isPlaced(item) && !item.run_id && !listedIds.has(item.id))
      .sort((a, b) => coinsPerHour(a) - coinsPerHour(b));

    if (
      spareCreatures.length > config.ZOLANA_MARKET_KEEP_CREATURES
      && this.state.ready('market:list:creature')
    ) {
      const creature = spareCreatures[0];
      const price = this.sellPriceUsd(summary.creature);
      if (price) {
        await this.listOnMarket(`market:list:${creature.id}`, {
          itemKind: 'creature',
          itemId: creature.id,
          currency: 'zenko',
          priceUsd: price,
        });
        this.state.cooldown('market:list:creature', 60 * 60 * 1000);
      }
    }

    // Sell surplus BASIC eggs only (never mystery/premium/golden/forest — those hatch
    // good creatures). Keep a couple for hatching into growth.
    const spareEggs = activeEggs(player)
      .filter((e) => (e.egg_type === 'basic') && !e.bound && !e.stored && !e.listed && !listedIds.has(e.id));
    if (spareEggs.length > 2 && this.state.ready('market:list:egg')) {
      const price = this.sellPriceUsd(summary.egg);
      if (price) {
        await this.listOnMarket(`market:list:${spareEggs[0].id}`, {
          itemKind: 'egg',
          itemId: spareEggs[0].id,
          currency: 'zenko',
          priceUsd: price,
        });
        this.state.cooldown('market:list:egg', 60 * 60 * 1000);
      }
    }

    // --- Sell surplus gold at the market gold floor (undercut so it sells) ---
    const gold = Number(account.gold || 0);
    if (gold > config.ZOLANA_MARKET_KEEP_GOLD * 2 && this.state.ready('market:list:gold')) {
      const quantity = Math.floor(Math.min(gold - config.ZOLANA_MARKET_KEEP_GOLD, 300_000));
      const goldFloor = Number(summary.gold?.floorUnitUsd);
      const unit = Number.isFinite(goldFloor) && goldFloor > 0
        ? goldFloor * config.ZOLANA_MARKET_SELL_UNDERCUT
        : 1 / 320_000; // fallback if no market data yet
      const priceUsd = Number((quantity * unit).toFixed(2));
      if (quantity > 0 && priceUsd > 0) {
        await this.listOnMarket('market:list:gold', {
          itemKind: 'gold',
          quantity,
          currency: 'zenko',
          priceUsd,
        });
        this.state.cooldown('market:list:gold', 2 * 60 * 60 * 1000);
      }
    }

    // --- Sell SURPLUS materials (kept above the craft/build/epoch reserves) ---
    await this.sellSurplusMaterials(player, books.material);
  }

  // Materials feed craft/build first (gem_catalyst→gems, relic_shard→relic enhance,
  // mana_shard/glimmer/astral→epoch donate); only the surplus ABOVE those reserves is
  // sold. Sells the highest-value surplus lot at that material's market floor×undercut.
  async sellSurplusMaterials(player, materialBook) {
    if (!this.state.ready('market:list:material')) return;
    const materials = list(player?.materials);
    if (!materials.length) return;

    // Per-material floor unit price (zenko listings only).
    const floors = {};
    for (const listing of list(materialBook)) {
      const res = listing.resource || listing.item?.resource;
      const unit = unitPriceUsd(listing);
      if (!res || !Number.isFinite(unit)) continue;
      floors[res] = Math.min(floors[res] ?? Infinity, unit);
    }

    const candidates = [];
    for (const m of materials) {
      const reserve = MATERIAL_RESERVE[m.material_id] ?? MATERIAL_RESERVE.default;
      const surplus = Number(m.quantity || 0) - reserve;
      if (surplus < 50) continue; // don't bother with tiny lots
      const floor = floors[m.material_id];
      if (!Number.isFinite(floor) || floor <= 0) continue;
      const qty = Math.min(surplus, 2000);
      candidates.push({ id: m.material_id, qty, unit: floor, value: qty * floor });
    }
    if (!candidates.length) return;

    candidates.sort((a, b) => b.value - a.value); // most valuable surplus first
    const best = candidates[0];
    const priceUsd = Number((best.qty * best.unit * config.ZOLANA_MARKET_SELL_UNDERCUT).toFixed(4));
    if (priceUsd <= 0) return;
    await this.listOnMarket(`market:list:material:${best.id}`, {
      itemKind: 'material',
      resource: best.id,
      quantity: best.qty,
      currency: 'zenko',
      priceUsd,
    });
    this.state.cooldown('market:list:material', 90 * 60 * 1000);
    logger.info({ material: best.id, qty: best.qty, priceUsd }, 'listed surplus material');
  }

  // Price = floor * undercut, clamped to the anti-dump minimum. Returns null if no
  // reliable floor exists yet (never list blind).
  sellPriceUsd(kindSummary) {
    const floor = Number(kindSummary?.floorUnitUsd);
    const ref = Number.isFinite(floor) && floor > 0 ? floor : null;
    if (!ref) return null;
    const price = Math.max(ref * config.ZOLANA_MARKET_SELL_UNDERCUT, config.ZOLANA_MARKET_MIN_SELL_USD);
    return Number(price.toFixed(4));
  }

  async safeAct(name, fn) {
    try {
      return await this.act(name, fn);
    } catch (error) {
      const wait = /cooldown \((\d+)s\)/i.exec(error.message || '')?.[1];
      if (wait) this.state.cooldown(name, Number(wait) * 1000);
      logger.warn({ action: name, status: error.status, message: error.message }, 'action skipped');
      return null;
    }
  }

  async act(name, fn) {
    if (this.actionsThisCycle >= config.ZOLANA_MAX_ACTIONS_PER_CYCLE) {
      logger.debug({ action: name }, 'cycle action cap reached');
      return null;
    }
    this.actionsThisCycle += 1;
    if (!config.ZOLANA_REAL_RUN) {
      logger.info({ action: name }, 'dry-run action');
      return null;
    }
    const result = await fn();
    this.state.count(name);
    logger.info({ action: name }, 'action ok');
    return result;
  }

  snapshotPlayer(player) {
    if (!player) return null;
    const account = actor(player);
    return {
      wallet: account.wallet_address || account.wallet,
      username: account.username,
      level: account.level,
      xp: account.xp,
      gold: account.gold,
      gems: account.gems,
      shards: account.shards,
      zenko_balance: account.zenko_balance,
      stamina: account.stamina,
      eggs: activeEggs(player).length,
      hatchedEggs: eggs(player).filter((egg) => egg?.status === 'hatched' || egg?.hatched).length,
      creatures: creatures(player).length,
      at: new Date().toISOString(),
    };
  }
}
