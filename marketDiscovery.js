'use strict';
/**
 * Market discovery for deterministic crypto Up/Down windows.
 *
 * Slug scheme (verified live): `${asset}-updown-${tf}-${epochSeconds}`
 * e.g. btc-updown-5m-1790861700  /  btc-updown-15m-1790861400
 *
 * Everything needed to trade is taken from Gamma and validated rather than
 * assumed:
 *  - outcome labels are matched by NAME (Up / Down), not by array position
 *  - conditionId, negRisk, tick size, minimum order size and the published fee
 *    schedule are all carried through to the order path
 *  - cryptoMarketConfig confirms the settlement basis
 *    (e.g. {id:"btc-5m-twap-60", twapEnabled:true, twapLookbackSeconds:60})
 */
const { getJson } = require('./clobClient');

function parseMaybeJson(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

class MarketDiscovery {
  constructor(config, { log = () => {} } = {}) {
    this.cfg = config;
    this.log = log;
    this.cache = new Map(); // slug -> {market, at}
    this.cacheMs = 5000;
  }

  epochFor(timeframe, nowSec = Math.floor(Date.now() / 1000)) {
    const step = this.cfg.market.windowSeconds[timeframe];
    if (!step) throw new Error(`unknown timeframe ${timeframe}`);
    return nowSec - (nowSec % step);
  }

  async fetchEvent(slug) {
    const cached = this.cache.get(slug);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.market;
    const url = `${this.cfg.endpoints.gamma}/events?slug=${encodeURIComponent(slug)}`;
    let events;
    try {
      events = await getJson(url);
    } catch (e) {
      this.log('WARN', `[discovery] ${slug}: ${e.message}`);
      return null;
    }
    if (!Array.isArray(events) || !events.length) return null;
    const market = this.parseEvent(events[0], slug);
    this.cache.set(slug, { market, at: Date.now() });
    return market;
  }

  parseEvent(ev, slug) {
    const m = (ev.markets && ev.markets[0]) || null;
    if (!m) return null;
    const labels = parseMaybeJson(m.outcomes, []).map(s => String(s).toLowerCase());
    const prices = parseMaybeJson(m.outcomePrices, []).map(Number);
    const tokenIds = parseMaybeJson(m.clobTokenIds, []).map(String);

    const upIdx = labels.findIndex(l => l === 'up');
    const downIdx = labels.findIndex(l => l === 'down');
    const mapped = upIdx >= 0 && downIdx >= 0 && tokenIds.length >= 2;

    // Which order book this market lives on. Gamma reports `version`; the CLOB
    // assetId for a Protocol-V2 market is a position ID on ExchangeV3, not a
    // CTF token ID. This bot signs CTF orders only, so a v2 market has to be
    // stood down explicitly rather than sent an asset ID it cannot match.
    // Absent field = a CTF market, which is the pre-V2 behaviour.
    const marketVersion = m.version === undefined || m.version === null
      ? null
      : String(m.version).toLowerCase();

    const step = m.cryptoMarketConfig && m.cryptoMarketConfig.duration
      ? null
      : null;
    void step;

    return {
      slug,
      eventId: ev.id,
      eventSlug: ev.slug,
      title: ev.title || m.question,
      question: m.question,
      description: m.description,
      resolutionSource: m.resolutionSource,
      conditionId: m.conditionId,
      marketId: m.id,
      active: !!m.active,
      closed: !!m.closed,
      acceptingOrders: !!m.acceptingOrders,
      archived: !!m.archived,
      restricted: !!m.restricted,
      negRisk: !!m.negRisk,
      enableOrderBook: !!m.enableOrderBook,
      startDate: m.startDate || m.eventStartTime,
      eventStartTime: m.eventStartTime,
      endDate: m.endDate,
      // trading constraints (book values are authoritative at order time)
      tickSize: m.orderPriceMinTickSize !== undefined ? Number(m.orderPriceMinTickSize) : null,
      minOrderSize: m.orderMinSize !== undefined ? Number(m.orderMinSize) : null,
      feeSchedule: m.feeSchedule ? {
        rate: Number(m.feeSchedule.rate),
        exponent: Number(m.feeSchedule.exponent || 1),
        takerOnly: !!m.feeSchedule.takerOnly,
        rebateRate: m.feeSchedule.rebateRate !== undefined ? Number(m.feeSchedule.rebateRate) : null,
        type: m.feeType || null,
        enabled: !!m.feesEnabled,
      } : null,
      cryptoMarketConfig: m.cryptoMarketConfig || null,
      bestBid: m.bestBid !== undefined ? Number(m.bestBid) : null,
      bestAsk: m.bestAsk !== undefined ? Number(m.bestAsk) : null,
      spread: m.spread !== undefined ? Number(m.spread) : null,
      liquidityUsd: Number(m.liquidityNum || m.liquidityClob || 0),
      volumeUsd: Number(m.volumeNum || 0),
      // strict token mapping
      outcomes: labels,
      tokensByIdx: tokenIds,
      upTokenId: mapped ? tokenIds[upIdx] : null,
      downTokenId: mapped ? tokenIds[downIdx] : null,
      priceUp: prices[upIdx] !== undefined && Number.isFinite(prices[upIdx]) ? prices[upIdx] : null,
      priceDown: prices[downIdx] !== undefined && Number.isFinite(prices[downIdx]) ? prices[downIdx] : null,
      tokenMappingOk: mapped,
      tokenMappingNote: mapped ? 'Up/Down resolved by outcome label' : `unexpected outcomes ${JSON.stringify(labels)}`,
      marketVersion,
      protocolV2: marketVersion === 'v2',
    };
  }

  /**
   * Discover the active window plus upcoming ones for each configured timeframe.
   * @param {{includeExpired?: boolean}} opts
   */
  async getMarkets({ includeExpired = false } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const tfs = this.cfg.market.timeframes.includes('all')
      ? this.cfg.market.timeframesAll
      : this.cfg.market.timeframes;

    const jobs = [];
    for (const tf of tfs) {
      const step = this.cfg.market.windowSeconds[tf];
      const currentStart = this.epochFor(tf, now);
      const offsets = new Set(includeExpired ? [-1, 0] : [0]);
      for (let i = 0; i <= this.cfg.market.lookaheadWindows; i++) offsets.add(i);
      for (const off of offsets) {
        const epoch = currentStart + off * step;
        const slug = `${this.cfg.market.asset}-updown-${tf}-${epoch}`;
        jobs.push({ tf, step, epoch, slug });
      }
    }

    const results = [];
    const settled = await Promise.allSettled(jobs.map(j => this.fetchEvent(j.slug)));

    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      const res = settled[i];
      if (res.status !== 'fulfilled' || !res.value) continue;
      const m = res.value;
      const endsAt = j.epoch + j.step;
      const remainingSec = endsAt - now;
      const started = now >= j.epoch;
      results.push({
        ...m,
        timeframe: j.tf,
        windowSeconds: j.step,
        epoch: j.epoch,
        startTime: new Date(j.epoch * 1000).toISOString(),
        endTime: new Date(endsAt * 1000).toISOString(),
        endsAtEpoch: endsAt,
        remainingSec: Math.max(0, remainingSec),
        secondsSinceOpen: Math.max(0, now - j.epoch),
        started,
        // A Protocol-V2 market is not tradeable by this bot: its CLOB assetId is
        // an ExchangeV3 position ID, not the CTF token ID we sign orders for.
        tradeable: started && remainingSec > 0 && !m.closed && m.acceptingOrders
          && m.tokenMappingOk && !m.protocolV2,
      });
    }

    results.sort((a, b) => a.endsAtEpoch - b.endsAtEpoch);
    return results;
  }

  /**
   * Settlement lookup. Resolves a position's outcome from the most reliable
   * source available:
   *   1. Gamma by SLUG (verified against the condition id) — the only source
   *      observed to publish the final `closed` flag and 1/0 outcome prices.
   *   2. Gamma `/markets?condition_ids=` (documented, but currently returns []
   *      in production, so it is only a fallback).
   *   3. CLOB `/markets/{conditionId}`, which exposes `tokens[].winner` and a
   *      final price snapshot.
   * Returns { winner: 'UP'|'DOWN'|null, source, closed }.
   */
  async resolveOutcome({ conditionId, slug }) {
    // 1) Gamma by slug
    if (slug) {
      const events = await getJson(`${this.cfg.endpoints.gamma}/events?slug=${encodeURIComponent(slug)}`).catch(() => null);
      const m = events && events[0] && events[0].markets && events[0].markets[0];
      if (m && (!conditionId || !m.conditionId || String(m.conditionId).toLowerCase() === String(conditionId).toLowerCase())) {
        const prices = parseMaybeJson(m.outcomePrices, []).map(Number);
        const labels = parseMaybeJson(m.outcomes, []).map(s => String(s).toLowerCase());
        if (m.closed) {
          const winner = labels[prices.findIndex(p => p >= 0.999)];
          if (winner === 'up' || winner === 'down') {
            return { winner: winner.toUpperCase(), source: 'gamma_slug', closed: true, prices, labels };
          }
        }
      }
    }
    // 2) Gamma by condition id (documented filter)
    if (conditionId) {
      const rows = await getJson(`${this.cfg.endpoints.gamma}/markets?condition_ids=${encodeURIComponent(conditionId)}`).catch(() => null);
      const m = Array.isArray(rows) ? rows[0] : null;
      if (m && m.closed) {
        const prices = parseMaybeJson(m.outcomePrices, []).map(Number);
        const labels = parseMaybeJson(m.outcomes, []).map(s => String(s).toLowerCase());
        const winner = labels[prices.findIndex(p => p >= 0.999)];
        if (winner === 'up' || winner === 'down') {
          return { winner: winner.toUpperCase(), source: 'gamma_condition', closed: true, prices, labels };
        }
      }
    }
    // 3) CLOB market record
    if (conditionId) {
      const cm = await getJson(`${this.cfg.endpoints.clob}/markets/${encodeURIComponent(conditionId)}`).catch(() => null);
      if (cm) {
        const tokens = cm.tokens || [];
        const flagged = tokens.find(t => t.winner === true);
        if (flagged) {
          const side = String(flagged.outcome || '').toLowerCase();
          if (side === 'up' || side === 'down') return { winner: side.toUpperCase(), source: 'clob_winner', closed: true };
        }
        if (cm.closed) {
          const top = tokens.slice().sort((a, b) => Number(b.price) - Number(a.price))[0];
          if (top && Number(top.price) >= 0.999) {
            const side = String(top.outcome || '').toLowerCase();
            if (side === 'up' || side === 'down') return { winner: side.toUpperCase(), source: 'clob_price', closed: true };
          }
        }
      }
    }
    return { winner: null, source: 'none', closed: false };
  }

  /**
   * Refresh a single market by condition id (kept for compatibility).
   */
  async getMarketByConditionId(conditionId) {
    const url = `${this.cfg.endpoints.gamma}/markets?condition_ids=${encodeURIComponent(conditionId)}`;
    const rows = await getJson(url).catch(() => null);
    if (!Array.isArray(rows) || !rows.length) return null;
    const m = rows[0];
    const labels = parseMaybeJson(m.outcomes, []).map(s => String(s).toLowerCase());
    const tokenIds = parseMaybeJson(m.clobTokenIds, []).map(String);
    const prices = parseMaybeJson(m.outcomePrices, []).map(Number);
    const upIdx = labels.indexOf('up');
    const downIdx = labels.indexOf('down');
    return {
      conditionId: m.conditionId,
      closed: !!m.closed,
      active: !!m.active,
      outcomes: labels,
      tokensByIdx: tokenIds,
      prices,
      priceUp: upIdx >= 0 ? prices[upIdx] : null,
      priceDown: downIdx >= 0 ? prices[downIdx] : null,
      upTokenId: upIdx >= 0 ? tokenIds[upIdx] : null,
      downTokenId: downIdx >= 0 ? tokenIds[downIdx] : null,
      umaResolutionStatuses: m.umaResolutionStatuses,
      endDate: m.endDate,
    };
  }
}

module.exports = { MarketDiscovery, parseMaybeJson };
