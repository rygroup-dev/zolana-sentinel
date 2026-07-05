import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { logger } from './logger.js';
import { loginMessageCandidates } from './wallet.js';

export class ZolanaClient {
  constructor(wallet) {
    this.wallet = wallet;
    this.base = config.ZOLANA_API_BASE.replace(/\/$/, '');
    this.token = null;
    this.tokenExpiresAt = 0;
    this.lastRequestAt = 0;
  }

  async request(method, path, body = undefined, { auth = true, query = undefined } = {}) {
    const url = new URL(path, this.base);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
    }

    // Human-like pacing: fixed gap + random jitter so requests never fire on a robotic
    // fixed cadence.
    const gap = config.ZOLANA_MIN_ACTION_GAP_MS + Math.floor(Math.random() * config.ZOLANA_ACTION_JITTER_MS);
    const wait = Math.max(0, gap - (Date.now() - this.lastRequestAt));
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    // Present as a real Chrome browser (not "ZolanaBot") to avoid trivial bot flags.
    const headers = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': config.ZOLANA_USER_AGENT,
      'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      referer: `${this.base}/`,
      origin: this.base,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.token) headers['x-zenko-session'] = this.token;

    const payload = body === undefined ? undefined : JSON.stringify(body);
    const maxRetries = config.ZOLANA_HTTP_RETRIES;

    for (let attempt = 0; ; attempt += 1) {
      // Per-request timeout so a hung connection can never freeze the bot.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.ZOLANA_HTTP_TIMEOUT_MS);
      let response;
      let text;
      try {
        response = await fetch(url, { method, headers, body: payload, signal: controller.signal });
        text = await response.text();
      } catch (error) {
        // Network error / timeout → retry with exponential backoff.
        if (attempt < maxRetries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        throw Object.assign(new Error(`network: ${error.message}`), { retryable: true, cause: error });
      } finally {
        clearTimeout(timer);
      }

      // Cloudflare bot challenge (rare on the wallet-signed API) → surface distinctly.
      if ((response.status === 403 || response.status === 503)
        && /captcha|challenge|cf-chl|turnstile|just a moment/i.test(text || '')) {
        throw Object.assign(new Error('cloudflare challenge'), {
          status: response.status, challenge: true, retryable: true,
        });
      }

      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

      // Rate limited or transient server error → back off and retry.
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          const retryAfter = Number(response.headers.get('retry-after')) * 1000;
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : this.backoff(attempt));
          continue;
        }
        throw Object.assign(new Error(data?.error || `${method} ${url.pathname} ${response.status}`), {
          status: response.status, data, retryable: true,
        });
      }

      // Token expired/invalidated → transparently re-authenticate and retry once.
      if (response.status === 401 && auth && this.token && attempt < maxRetries) {
        this.token = null;
        this.tokenExpiresAt = 0;
        await this.login().catch(() => {});
        if (this.token) headers['x-zenko-session'] = this.token;
        await sleep(this.backoff(attempt));
        continue;
      }

      if (!response.ok) {
        throw Object.assign(new Error(data?.error || data?.message || `${method} ${url.pathname} failed`), {
          status: response.status, data,
        });
      }
      return data;
    }
  }

  // Exponential backoff with full jitter (decorrelated) so retries don't thundering-herd.
  backoff(attempt) {
    const base = config.ZOLANA_HTTP_BACKOFF_MS * (2 ** attempt);
    return Math.floor(base / 2 + Math.random() * base / 2);
  }

  get(path, options) {
    return this.request('GET', path, undefined, options);
  }

  post(path, body = {}, options) {
    return this.request('POST', path, body, options);
  }

  async login() {
    if (this.token && Date.now() < this.tokenExpiresAt - 120_000) return this.token;

    const nonceData = await this.get('/api/auth/nonce', { auth: false });
    const issuedAt = Date.now();
    const candidates = loginMessageCandidates({
      wallet: this.wallet.publicKey,
      nonce: nonceData.nonce,
      issuedAt,
      template: config.ZOLANA_LOGIN_MESSAGE_TEMPLATE,
    });
    let login = null;
    let lastError = null;
    for (const message of candidates) {
      const signature = this.wallet.signMessage(message);
      try {
        login = await this.post('/api/auth/login', {
          wallet: this.wallet.publicKey,
          issuedAt,
          nonce: nonceData.nonce,
          signature,
        }, { auth: false });
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!login) {
      throw lastError || new Error('Unable to authenticate with available login message templates.');
    }

    this.token = login.token;
    this.tokenExpiresAt = Number(login.expiresAt || Date.now() + 3_600_000);
    logger.info({ wallet: this.wallet.publicKey, expiresAt: this.tokenExpiresAt }, 'authenticated');

    return this.token;
  }

  async ensureLogin() {
    await this.login();
  }

  async loadPlayer() {
    return this.get('/api/player/load');
  }

  async createPlayer(username) {
    return this.post('/api/player/create', { username });
  }

  async servers() {
    return this.get('/api/servers');
  }

  async setServer(serverId) {
    return this.post('/api/player/setserver', { server_id: serverId });
  }

  async claimDaily() {
    return this.post('/api/daily/claim');
  }

  async claimIdle() {
    return this.post('/api/idle/claim');
  }

  async buyEgg(eggType = 'basic') {
    return this.post('/api/egg/buy', { eggType });
  }

  async claimQuest(questId) {
    return this.post('/api/quests/claim', { questId });
  }

  async tutorial(step, done = false) {
    return this.post('/api/tutorial/progress', { step, done });
  }

  async incubate(eggId, boost = false) {
    return this.post('/api/egg/incubate', { eggId, boost });
  }

  async hatch(eggId) {
    return this.post('/api/egg/hatch', { eggId });
  }

  async feed(creatureId) {
    return this.post('/api/creature/feed', { creatureId });
  }

  async place(creatureId, x = 8.1, y = 8.0) {
    return this.post('/api/creature/place', { creatureId, x, y });
  }

  async placeAuto(count = undefined) {
    return this.post('/api/creature/place-auto', count ? { count } : {});
  }

  async buyPlaceSlot() {
    return this.post('/api/slots/buy', {});
  }

  async grantStarter() {
    return this.post('/api/egg/grant-starter', {});
  }

  async sacrifice(targetId, fodderIds) {
    return this.post('/api/creature/sacrifice', { targetId, fodderIds });
  }

  // Move an item to/from storage (vault). store=true vaults it (frees active roster);
  // store=false pulls it back out. itemKind: creature|egg|cosmetic|relic.
  async storageMove(itemKind, itemId, store = true) {
    return this.post('/api/storage/move', { itemKind, itemId, store });
  }

  // Buy a storage capacity upgrade (server-side cost deduction; no signature needed).
  async storageUpgrade() {
    return this.post('/api/storage/upgrade', {});
  }

  async pvp() {
    return this.get('/api/pvp');
  }

  async pvpMatch() {
    return this.post('/api/pvp/match', {});
  }

  async market(kind, extra = {}) {
    return this.get('/api/market/browse', { query: { kind, sort: 'recent', ...extra } });
  }

  async marketMine() {
    return this.get('/api/market/browse', { query: { mine: 1 } });
  }

  async recentSales() {
    return this.get('/api/market/recent-sales');
  }

  async marketQuote(listingId) {
    return this.post('/api/market/quote', { listingId });
  }

  async marketBuyGems(listingId) {
    return this.post('/api/market/buy-gems', { listingId });
  }

  async marketBuyWithQuote(quote) {
    if (!quote?.quoteId) throw new Error('marketBuyWithQuote: missing quoteId.');
    const mint = quote.mint || config.ZOLANA_TOKEN_MINT;
    const signature = await this.wallet.transferTokenSplit([
      { toOwner: quote.sellerWallet, rawAmount: BigInt(quote.sellerRaw) },
      { toOwner: quote.treasury, rawAmount: BigInt(quote.feeRaw) },
    ], mint, Number(quote.decimals));
    return this.post('/api/market/buy', { quoteId: quote.quoteId, signature });
  }

  async marketList(payload) {
    return this.post('/api/market/list', payload);
  }

  async marketCancel(listingId) {
    return this.post('/api/market/cancel', { listingId });
  }

  // --- Idle / AFK farming ---
  async afkStart() {
    return this.post('/api/afk/start', {});
  }

  async afkCollect(stop = false) {
    return this.post('/api/afk/collect', { stop });
  }

  // --- Free / passive claims ---
  async holdClaim() {
    return this.post('/api/gems/hold-claim', {});
  }

  async epoch() {
    return this.get('/api/epoch');
  }

  async epochClaim() {
    return this.post('/api/epoch/claim', {});
  }

  async epochDonate(payload) {
    return this.post('/api/epoch/donate', payload);
  }

  async dexClaim(milestoneId) {
    return this.post('/api/dex/claim', { milestoneId });
  }

  // --- Creature growth ---
  async evolve(creatureId, useXp = true) {
    return this.post('/api/creature/evolve', { creatureId, useXp });
  }

  async breed(parentA, parentB) {
    return this.post('/api/breed', { parentA, parentB });
  }

  // v0.18: reset a bred-out creature's breed_count (8/8) back to 0, costs gems by rarity.
  async breedRenew(creatureId) {
    return this.post('/api/breed/renew', { creatureId });
  }

  async companion(creatureId) {
    return this.post('/api/creature/companion', { creatureId });
  }

  async unplace(creatureId) {
    return this.post('/api/creature/place', { creatureId, unplace: true });
  }

  // --- Combat ---
  async pvpTeam(team) {
    return this.post('/api/pvp/team', { team });
  }

  async dungeonStart(dungeonId, party) {
    return this.post('/api/dungeon/start', { dungeonId, party });
  }

  async dungeonClaim(runId, silent = false) {
    return this.post('/api/dungeon/claim', silent ? { runId, silent: true } : { runId });
  }

  async dungeonCancel(runId) {
    return this.post('/api/dungeon/cancel', { runId });
  }

  // --- Shop / gacha ---
  async storeState() {
    return this.get('/api/store/state');
  }

  async storeBuy(offerId) {
    return this.post('/api/store/buy', { offerId });
  }

  async gachaPull(tier, currency = 'gems') {
    return this.post('/api/gacha/pull', { tier, currency });
  }

  // Full gacha flow. Gems currency completes directly. Token currency (zenko/zolana)
  // returns a payment quote → transfer costZenko WHOLE $ZOLANA tokens to the treasury,
  // then resubmit with the signature. Returns the final pull result (with .gacha.cards).
  async gachaPayAndPull(tier, currency = 'gems') {
    const quote = await this.gachaPull(tier, currency);
    if (!quote?.needsPayment) return quote; // gems path: already resolved
    if (!quote.costZenko || !quote.treasury) {
      throw Object.assign(new Error('gacha: incomplete payment quote'), { data: quote });
    }
    const mint = config.ZOLANA_TOKEN_MINT;
    const decimals = 6; // $ZOLANA mint decimals
    // Reserve guard: never spend token below the configured reserve.
    const balance = await this.wallet.tokenBalance().catch(() => null);
    if (balance && balance.uiAmount - Number(quote.costZenko) < config.ZOLANA_MARKET_ZOLANA_RESERVE) {
      throw Object.assign(
        new Error(`gacha: butuh ${quote.costZenko} $ZOLANA + reserve ${config.ZOLANA_MARKET_ZOLANA_RESERVE}, saldo ${Math.round(balance.uiAmount)}`),
        { data: quote },
      );
    }
    const rawAmount = BigInt(quote.costZenko) * (10n ** BigInt(decimals));
    const signature = await this.wallet.transferTokenSplit(
      [{ toOwner: quote.treasury, rawAmount }],
      mint,
      decimals,
    );
    return this.post('/api/gacha/pull', {
      tier,
      currency,
      signature,
      costZenko: quote.costZenko,
      exp: quote.exp,
      quoteSig: quote.quoteSig,
    });
  }

  // Buy stamina with $ZOLANA (on-chain). Unlike gacha/market there is NO server quote —
  // /api/stamina/restore 400s ("Missing transaction signature") without a signature — so
  // the cost (50 $ZOLANA → full 180) and treasury are known client-side. Transfer the
  // tokens to the canonical treasury, then submit {pack, signature}. Reserve-guarded.
  async staminaRestore(pack = 'full') {
    const cost = config.ZOLANA_STAMINA_ZENKO_COST;
    const decimals = 6; // $ZOLANA mint decimals
    const balance = await this.wallet.tokenBalance().catch(() => null);
    if (balance && balance.uiAmount - cost < config.ZOLANA_MARKET_ZOLANA_RESERVE) {
      throw Object.assign(
        new Error(`stamina: butuh ${cost} $ZOLANA + reserve ${config.ZOLANA_MARKET_ZOLANA_RESERVE}, saldo ${Math.round(balance?.uiAmount || 0)}`),
        { data: { cost } },
      );
    }
    const rawAmount = BigInt(cost) * (10n ** BigInt(decimals));
    const signature = await this.wallet.transferTokenSplit(
      [{ toOwner: config.ZOLANA_TREASURY, rawAmount }],
      config.ZOLANA_TOKEN_MINT,
      decimals,
    );
    return this.post('/api/stamina/restore', { pack, signature });
  }

  async gemCraft() {
    return this.post('/api/gem/craft');
  }

  // --- Relics (unlocks d_equip / w_relics quests + battle stats) ---
  async relicCraft(slot, relicClass = 'common') {
    return this.post('/api/relic/craft', { relicClass, slot });
  }

  // Forge a COMBAT relic of a chosen rarity + stat (Rare/Epic/Legendary…). Server
  // validates cost + success chance; on fail it refunds 50% of the materials.
  async craftCombatRelic(rarity, stat) {
    return this.post('/api/relic/craft-combat', { rarity, stat });
  }

  async relicEquip(relicId, target, slot) {
    return this.post('/api/relic/equip', { relicId, target, slot });
  }

  async relicUnequip(relicId) {
    return this.post('/api/relic/unequip', { relicId });
  }

  async relicEnhance(relicId) {
    return this.post('/api/relic/enhance', { relicId });
  }

  async relicReroll(relicId, mode = 'stat') {
    return this.post('/api/relic/reroll', { relicId, mode });
  }

  // Bulk-recycle many relics at once into relic_shard (permanent). Yields per rarity:
  // Uncommon/Rare 2-4, Epic 5-8 (+glimmer), Legendary 10-14 (+gem_catalyst), Mythical 0.
  async relicRecycle(relicIds) {
    return this.post('/api/relic/recycle', { relicIds });
  }

  // Break a relic into relic_shard (permanent) — fuel for enhancing the good ones.
  async relicDismantle(relicId) {
    return this.post('/api/relic/dismantle', { relicId });
  }

  // --- Info / read-only ---
  async price() {
    return this.get('/api/price');
  }

  async leaderboards() {
    return this.get('/api/leaderboards');
  }

  async friends() {
    return this.get('/api/social/friends');
  }
}
