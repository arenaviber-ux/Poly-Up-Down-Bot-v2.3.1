'use strict';
/**
 * Redeemer — the sweeper that turns resolved winning shares back into
 * tradeable collateral.
 *
 * This is the safety net behind `exitManager.js`. The pre-expiry sell recycles
 * capital in the same tick and is the primary path, but it can only act on a
 * position the model rates as decided, with a bid to sell into, inside a time
 * band. Everything it misses — partial fills, windows the bot was offline for,
 * positions that never reached the conviction threshold, markets that resolved
 * the other way after a late reversal — still ends up as an ERC-1155 token
 * that `GET /balance-allowance` cannot see. This module collects those.
 *
 * Flow:
 *   1. Ask the Data API which positions are still redeemable
 *      (`/positions?user=<account wallet>&redeemable=true&sizeThreshold=0`).
 *      `sizeThreshold=0` matters: the API's default hides small remainders, and
 *      dust from partial exits is exactly what we are sweeping.
 *   2. Verify resolution. The API's `redeemable` flag is the fast path; the CTF
 *      contract's `payoutDenominator > 0` is authoritative and is used for the
 *      bot's own queued wins, which the Data API may not have indexed yet.
 *   3. Encode `redeemPositions` and submit it through the gasless relayer,
 *      signed for this account's wallet type (see relayerClient.js).
 *   4. Poll to a terminal state, then force-refresh the CLOB balance cache so
 *      the *next* order sizing sees the recovered pUSD.
 *
 * Step 4 is the one that actually closes the capital loop. Without it the
 * redemption lands on-chain and the bot keeps reading a stale collateral
 * balance for up to a minute.
 */
const { getJson } = require('./clobClient');
const { RelayerClient, encodeRedeem, TOKENS } = require('./relayerClient');

/** Collapse a Data API position row into the fields the sweeper needs. */
function normalisePosition(raw) {
  if (!raw) return null;
  const size = Number(raw.size ?? raw.amount ?? 0);
  if (!(size > 0)) return null;
  let cid = String(raw.conditionId || raw.condition_id || '');
  if (cid && !cid.startsWith('0x')) cid = '0x' + cid;
  return {
    conditionId: cid || null,
    asset: raw.asset || raw.tokenId || null,
    size,
    outcome: raw.outcome || null,
    outcomeIndex: raw.outcomeIndex !== undefined ? Number(raw.outcomeIndex) : null,
    negativeRisk: raw.negativeRisk === undefined ? false : !!raw.negativeRisk,
    title: raw.title || raw.market || cid,
    slug: raw.slug || raw.eventSlug || null,
    redeemable: raw.redeemable === undefined ? null : !!raw.redeemable,
    curPrice: raw.curPrice !== undefined ? Number(raw.curPrice) : null,
    currentValue: raw.currentValue !== undefined ? Number(raw.currentValue) : null,
    cashPnl: raw.cashPnl !== undefined ? Number(raw.cashPnl) : null,
    mergeable: raw.mergeable === undefined ? null : !!raw.mergeable,
  };
}

/** Group positions by condition so one redeem call covers both outcomes. */
function groupByCondition(positions) {
  const out = new Map();
  for (const p of positions || []) {
    if (!p || !p.conditionId) continue;
    const key = p.conditionId.toLowerCase();
    if (!out.has(key)) {
      out.set(key, {
        conditionId: p.conditionId,
        negativeRisk: !!p.negativeRisk,
        title: p.title,
        positions: [],
        totalSize: 0,
        tokenIds: [],
      });
    }
    const g = out.get(key);
    g.positions.push(p);
    g.totalSize += p.size;
    if (p.asset) {
      g.tokenIds = g.tokenIds || [];
      if (!g.tokenIds.includes(String(p.asset))) g.tokenIds.push(String(p.asset));
    }
    // Any row asserting neg-risk wins: a mixed reading would redeem wrongly.
    if (p.negativeRisk) g.negativeRisk = true;
  }
  return out;
}

class Redeemer {
  /**
   * @param {object} config   CONFIG
   * @param {PolymarketAuth} auth
   * @param {{log?:Function, relayer?:RelayerClient}} [deps]  injectable for tests
   */
  constructor(config, auth, { log = () => {}, relayer = null } = {}) {
    this.cfg = config;
    this.auth = auth;
    this.log = log;
    this.relayer = relayer || new RelayerClient(config, auth, { log });

    this.enabled = !!(config.redeem && config.redeem.enabled);
    /** Mirrors BotCore.paperMode so readiness() can explain itself accurately. */
    this.paperMode = !!(config.runtime && config.runtime.paperMode);
    this.outputToken = String((config.redeem && config.redeem.outputToken) || 'pUSD');
    this.verifyOnChain = !!(config.redeem && config.redeem.verifyOnChain);
    this.minValueUsd = Number((config.redeem && config.redeem.minValueUsd) || 0);
    this.maxPerRun = Number((config.redeem && config.redeem.maxPerRun) || 25);
    this.pollMax = Number((config.redeem && config.redeem.pollMax) || 20);
    this.pollMs = Number((config.redeem && config.redeem.pollMs) || 2000);

    /** conditionIds the bot itself settled as wins, awaiting confirmation. */
    this.pending = new Set();
    /** conditionIds already redeemed this process — never re-submit. */
    this.done = new Set();
    /** conditionIds that failed, with a reason, so we can back off. */
    this.failed = new Map();

    this.stats = {
      runs: 0,
      redeemed: 0,
      failed: 0,
      skipped: 0,
      recoveredUsd: 0,
      lastRunAt: null,
      lastRunMs: null,
      lastResult: null,
      lastError: null,
    };
    this.history = [];
    this.busy = false;
    this.configWarningIssued = false;
  }

  /**
   * Queue a condition the bot just settled as a win, so it is swept even if the
   * Data API has not indexed it yet. `tokenIds` lets the on-chain balance check
   * confirm the tokens are still held before a submission is spent on them.
   */
  queueCondition(conditionId, { title = null, shares = null, tokenIds = null, negativeRisk = false } = {}) {
    if (!conditionId) return false;
    const key = String(conditionId).toLowerCase();
    if (this.done.has(key)) return false;
    this.pending.add(key);
    this.pendingMeta = Object.assign(this.pendingMeta || {}, {
      [key]: { title, shares, tokenIds: tokenIds || null, negativeRisk: !!negativeRisk },
    });
    return true;
  }

  /**
   * Do we still hold any outcome token for this condition? Used to avoid
   * spending a relayer submission on tokens that were already redeemed (in the
   * UI, or by a previous run). Returns null when it cannot be determined — the
   * caller must then proceed rather than block on an unavailable RPC.
   */
  async holdsAnyToken(tokenIds) {
    const ids = (tokenIds || []).filter(Boolean);
    if (!ids.length || !this.auth.funderAddress) return null;
    try {
      for (const id of ids) {
        const bal = await this.relayer.tokenBalance(id, this.auth.funderAddress);
        if (Number(bal) > 0) return true;
      }
      return false;
    } catch (_) {
      return null;
    }
  }

  /**
   * Is the sweeper usable right now? Returns a reason string when it is not,
   * so the caller can log *why* instead of silently doing nothing.
   */
  /** Kept in step with BotCore.paperMode, which the dashboard can flip live. */
  setPaperMode(isPaper) {
    this.paperMode = !!isPaper;
    return this;
  }

  readiness() {
    if (!this.enabled) {
      // `enabled` is the RUNTIME toggle (the dashboard writes it), so the reason
      // must describe the runtime state. Printing a hard-coded 'AUTO_REDEEM=false'
      // was wrong the moment the toggle was flipped from the UI, and made a
      // paper-mode diagnostic read as "ok: true — AUTO_REDEEM=false".
      return {
        ready: false,
        reason: this.paperMode
          ? 'sweeper is off — in paper mode wins are credited to the paper balance at settlement, so there is nothing to redeem'
          : 'sweeper is off (AUTO_REDEEM=false, or toggled off from the dashboard) — resolved wins must be redeemed by hand',
      };
    }
    if (Number(this.auth.signatureType) === 0) {
      // EOA: no relayer, but a direct call works (costs POL gas).
      if (!this.auth.wallet) return { ready: false, reason: 'EOA account has no signer key' };
      return { ready: true, mode: 'direct', reason: 'EOA account — redeeming by direct CTF call (uses POL gas)' };
    }
    if (!this.auth.wallet) return { ready: false, reason: 'no signer key (POLY_PRIVATE_KEY) — cannot authorise a redemption' };
    if (!this.auth.funderAddress) {
      return { ready: false, reason: `signature type ${this.auth.signatureType} needs POLY_FUNDER_ADDRESS (the account wallet that holds the tokens)` };
    }
    if (!this.relayer.isConfigured()) {
      return {
        ready: false,
        reason: 'no relayer credentials — set RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS '
          + '(polymarket.com → Settings → API Keys → Relayer API Keys)',
      };
    }
    return { ready: true, mode: this.relayer.txType(), reason: 'ok' };
  }

  /** Ask the Data API which of this account's positions are redeemable. */
  async fetchRedeemablePositions() {
    const user = this.auth.funderAddress;
    if (!user) return { ok: false, error: 'no account wallet address configured', positions: [] };
    const base = this.cfg.endpoints.dataApi;
    const qs = new URLSearchParams({ user, redeemable: 'true', sizeThreshold: '0', limit: '500' });
    try {
      const raw = await getJson(`${base}/positions?${qs.toString()}`, { timeoutMs: 15000 });
      const rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.positions) ? raw.positions : []);
      const positions = rows.map(normalisePosition).filter(Boolean);
      return { ok: true, positions, count: positions.length };
    } catch (e) {
      return { ok: false, error: e.message, positions: [] };
    }
  }

  /** Authoritative on-chain resolution check for one condition. */
  async confirmResolved(conditionId) {
    try {
      const r = await this.relayer.readCondition(conditionId);
      return { ok: true, resolved: !!r.resolved, winningIndexSets: r.winningIndexSets };
    } catch (e) {
      return { ok: false, resolved: false, error: e.message };
    }
  }

  /**
   * Redeem a single condition. Chooses the relayer or the direct EOA path.
   * @returns {{ok:boolean, conditionId:string, transactionHash?:string, error?:string, skipped?:boolean, reason?:string}}
   */
  async redeemCondition(conditionId, { negativeRisk = false, title = null, tokenIds = null, skipBalanceCheck = false } = {}) {
    const key = String(conditionId).toLowerCase();
    if (this.done.has(key)) return { ok: false, skipped: true, conditionId, reason: 'already redeemed this session' };

    const ready = this.readiness();
    if (!ready.ready) return { ok: false, skipped: true, conditionId, reason: ready.reason };

    // Confirm the market actually resolved before spending a submission on it.
    // A redeem on an unresolved condition reverts; worse, it burns the relayer
    // nonce slot and the failure is opaque.
    //
    // A definite "not resolved" always blocks. An *unavailable* check only
    // blocks when REDEEM_VERIFY_ONCHAIN is on: if the RPC is down and the bot
    // already settled this market as a win, refusing to try would strand the
    // capital indefinitely — which is the exact failure this module exists to
    // prevent. So it proceeds and lets the relayer be the authority.
    const fromQueue = this.pending.has(key);
    if (this.verifyOnChain || fromQueue) {
      const res = await this.confirmResolved(conditionId);
      if (res.ok && !res.resolved) {
        return {
          ok: false, skipped: true, conditionId,
          reason: 'not resolved on-chain yet (payoutDenominator = 0)',
        };
      }
      if (!res.ok) {
        if (this.verifyOnChain) {
          return { ok: false, skipped: true, conditionId, reason: `resolution check failed: ${res.error}` };
        }
        this.log('WARN', `[redeem] resolution check unavailable (${res.error}) — submitting anyway for a `
          + 'win this bot settled itself');
      }
    }

    // Don't spend a submission on tokens we no longer hold — that is what
    // "already redeemed in the UI" looks like, and it reverts. Only checked
    // when on-chain verification is enabled, and only blocking when the answer
    // is a definite "no": an unreachable RPC must not stop the sweep.
    if (!skipBalanceCheck && this.verifyOnChain) {
      const held = await this.holdsAnyToken(tokenIds);
      if (held === false) {
        return {
          ok: false, skipped: true, conditionId,
          reason: 'no outcome tokens held for this condition (already redeemed?)',
        };
      }
    }

    const enc = encodeRedeem({
      conditionId,
      negativeRisk,
      outputToken: this.outputToken,
    });

    let result;
    if (ready.mode === 'direct') {
      result = await this.relayer.redeemDirect({
        conditionId, negativeRisk, outputToken: this.outputToken,
      });
    } else {
      const submitted = await this.relayer.execute(
        [{ to: enc.to, data: enc.data, value: '0' }],
        `Redeem ${title || conditionId.slice(0, 14)}…`,
      );
      if (!submitted.ok) {
        this.failed.set(key, submitted.error);
        return { ok: false, conditionId, error: submitted.error };
      }
      result = await this.relayer.waitForTransaction(submitted.transactionID, {
        maxPolls: this.pollMax, pollMs: this.pollMs,
      });
      result.transactionID = submitted.transactionID;
    }

    if (result.ok) {
      this.done.add(key);
      this.pending.delete(key);
      this.failed.delete(key);
      this.stats.redeemed++;
      const entry = {
        at: new Date().toISOString(),
        conditionId,
        title: title || null,
        adapter: enc.adapter,
        mode: enc.mode,
        transactionHash: result.transactionHash || null,
        transactionID: result.transactionID || null,
        ok: true,
      };
      this.history.unshift(entry);
      if (this.history.length > 100) this.history.pop();
      this.log('SUCCESS', `[redeem] ${title || conditionId.slice(0, 14)}… → ${this.outputToken} via ${enc.adapter}`
        + (result.transactionHash ? ` (tx ${String(result.transactionHash).slice(0, 16)}…)` : ''));
      return { ok: true, conditionId, transactionHash: result.transactionHash, mode: enc.mode };
    }

    this.failed.set(key, result.error || result.state);
    this.stats.failed++;
    const entry = {
      at: new Date().toISOString(),
      conditionId,
      title: title || null,
      ok: false,
      error: result.error || `state ${result.state}`,
      transactionHash: result.transactionHash || null,
    };
    this.history.unshift(entry);
    if (this.history.length > 100) this.history.pop();
    this.log('ERROR', `[redeem] ${title || conditionId.slice(0, 14)}… failed: ${entry.error}`);
    return { ok: false, conditionId, error: entry.error };
  }

  /**
   * Full sweep: Data API positions + the bot's own queued wins.
   *
   * @param {{force?:boolean}} [opts]
   * @returns {{ok:boolean, ran:boolean, found:number, redeemed:number, failed:number,
   *            skipped:number, recoveredUsdEstimate:number, results:object[], reason?:string}}
   */
  async sweep({ force = false } = {}) {
    const summary = {
      ok: false, ran: false, found: 0, redeemed: 0, failed: 0, skipped: 0,
      recoveredUsdEstimate: 0, results: [], reason: null,
    };
    if (this.busy) { summary.reason = 'a sweep is already running'; return summary; }

    const ready = this.readiness();
    if (!ready.ready) {
      summary.reason = ready.reason;
      this.stats.lastError = ready.reason;
      // Say it once, loudly, then stop repeating it every five minutes.
      if (!this.configWarningIssued) {
        this.configWarningIssued = true;
        this.log('WARN', `[redeem] auto-redemption is ON but not usable: ${ready.reason}. `
          + 'Wins will stay locked as tokens and will NOT count toward your tradeable balance — '
          + 'the pre-expiry exit is then the only thing recycling capital.');
      }
      return summary;
    }

    this.busy = true;
    const started = Date.now();
    this.stats.runs++;
    try {
      // ---- candidates
      const fromApi = await this.fetchRedeemablePositions();
      if (!fromApi.ok) {
        this.log('WARN', `[redeem] Data API position lookup failed: ${fromApi.error} — sweeping queued wins only`);
      }
      const groups = groupByCondition(fromApi.positions);

      // The bot's own settled wins are swept even if the Data API has not
      // indexed them yet; on-chain resolution is checked for those.
      for (const key of [...this.pending]) {
        if (this.done.has(key)) { this.pending.delete(key); continue; }
        if (!groups.has(key)) {
          const meta = (this.pendingMeta && this.pendingMeta[key]) || {};
          groups.set(key, {
            conditionId: key.startsWith('0x') ? key : `0x${key}`,
            negativeRisk: !!meta.negativeRisk,
            title: meta.title || 'queued win',
            positions: [],
            totalSize: Number(meta.shares || 0),
            tokenIds: meta.tokenIds || null,
            fromQueue: true,
          });
        } else {
          const g = groups.get(key);
          g.fromQueue = true;
          if (meta.negativeRisk) g.negativeRisk = true;
          if (!g.tokenIds && meta.tokenIds) g.tokenIds = meta.tokenIds;
        }
      }

      const candidates = [...groups.values()]
        .filter(g => g.conditionId && !this.done.has(g.conditionId.toLowerCase()))
        // A redemption below the floor is not worth a relayer round trip; it
        // stays queued and gets swept with the next batch.
        .filter(g => {
          const value = g.positions.reduce((a, p) => a + (Number(p.currentValue) || p.size), 0) || g.totalSize;
          return !(this.minValueUsd > 0 && value < this.minValueUsd);
        })
        .sort((a, b) => b.totalSize - a.totalSize)
        .slice(0, Math.max(1, this.maxPerRun));

      summary.found = candidates.length;
      if (!candidates.length) {
        summary.ok = true;
        summary.ran = true;
        summary.reason = 'nothing redeemable';
        this.stats.lastRunAt = new Date().toISOString();
        this.stats.lastRunMs = Date.now() - started;
        this.stats.lastResult = summary;
        return summary;
      }

      // ---- execute
      for (const g of candidates) {
        const r = await this.redeemCondition(g.conditionId, {
          negativeRisk: g.negativeRisk,
          title: g.title,
          tokenIds: g.tokenIds,
        });
        summary.results.push({ conditionId: g.conditionId, title: g.title, size: g.totalSize, ...r });
        if (r.ok) {
          summary.redeemed++;
          // $1.00 per winning share is the ceiling; the API's currentValue is
          // the better estimate when it is present.
          const est = g.positions.reduce((a, p) => a + (Number(p.currentValue) || 0), 0)
            || (g.totalSize * 1);
          summary.recoveredUsdEstimate += est;
        } else if (r.skipped) {
          summary.skipped++;
        } else {
          summary.failed++;
        }
      }

      // ---- close the loop: make the recovered collateral visible to sizing.
      // Without this the next order still reads the pre-redemption balance.
      if (summary.redeemed > 0) {
        this.stats.recoveredUsd += summary.recoveredUsdEstimate;
        try {
          if (typeof this.auth.syncBalanceAllowance === 'function') {
            await this.auth.syncBalanceAllowance({ force: true });
          }
          const bal = await this.auth.checkBalanceAllowance({ refresh: false });
          if (bal && bal.ok) {
            this.log('INFO', `[redeem] collateral balance is now $${bal.balance.toFixed(2)} (allowance $${bal.allowance.toFixed(2)})`);
            summary.balanceAfter = bal.balance;
          }
        } catch (e) {
          this.log('WARN', `[redeem] redeemed but the balance refresh failed: ${e.message}`);
        }
      }

      summary.ok = summary.failed === 0;
      summary.ran = true;
      summary.reason = summary.ok
        ? `redeemed ${summary.redeemed} condition(s), ~$${summary.recoveredUsdEstimate.toFixed(2)} back into collateral`
        : `${summary.failed} redemption(s) failed`;
      this.stats.lastRunAt = new Date().toISOString();
      this.stats.lastRunMs = Date.now() - started;
      this.stats.lastResult = summary;
      this.stats.lastError = summary.ok ? null : summary.reason;
      this.log(summary.ok ? 'SUCCESS' : 'WARN', `[redeem] sweep: ${summary.reason}`);
      return summary;
    } catch (e) {
      summary.reason = `sweep error: ${e.message}`;
      this.stats.lastError = e.message;
      this.log('ERROR', `[redeem] ${summary.reason}`);
      return summary;
    } finally {
      this.busy = false;
      this.stats.lastRunAt = this.stats.lastRunAt || new Date().toISOString();
      this.stats.lastRunMs = Date.now() - started;
    }
  }

  /** True when enough time has passed to run another sweep. */
  due(now = Date.now()) {
    if (!this.enabled) return false;
    const every = Number(this.cfg.redeem.everyMs || 300000);
    const last = this.stats.lastRunAt ? Date.parse(this.stats.lastRunAt) : 0;
    return !last || (now - last) >= every;
  }

  getState() {
    const ready = this.readiness();
    return {
      enabled: this.enabled,
      ready: ready.ready,
      mode: ready.mode || null,
      reason: ready.reason,
      outputToken: this.outputToken,
      verifyOnChain: this.verifyOnChain,
      everyMs: Number(this.cfg.redeem.everyMs || 300000),
      pending: this.pending.size,
      redeemedThisSession: this.done.size,
      failedThisSession: this.failed.size,
      relayer: this.relayer.getStatus(),
      stats: { ...this.stats, lastResult: undefined },
      lastResult: this.stats.lastResult,
      history: this.history.slice(0, 20),
    };
  }
}

module.exports = {
  Redeemer,
  groupByCondition,
  normalisePosition,
  TOKENS,
};
