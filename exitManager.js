'use strict';
/**
 * Exit manager — recycles capital by SELLING a position the model already
 * considers decided, shortly before the window closes.
 *
 * Why this exists: the CLOB has no redemption endpoint, and a winning share
 * that is held to resolution becomes an ERC-1155 token that does not count
 * toward `GET /balance-allowance?asset_type=COLLATERAL`. A bot that only ever
 * buys therefore drains its own float: every win converts spendable pUSD into
 * unspendable tokens until the balance hits zero and it silently stops trading
 * — while `realizedPnl` keeps climbing and the dashboard looks healthy.
 *
 * Selling at ~99c avoids that entirely: the proceeds land back in collateral
 * immediately, in the same tick, ready for the next window. The cost is the ~1c
 * given up against the $1.00 redemption, and the taker fee at that price is
 * essentially nil — `feePerShare = rate * p * (1-p)` is 0.07 * 0.99 * 0.01
 * ≈ 0.07c per share at 99c, versus 1.75c at 50c.
 *
 * Design notes:
 *  - The decision function `planExit()` is pure: no I/O, no clock reads, no
 *    instance state. Everything it needs is passed in, so it is directly
 *    testable and cannot drift from what the live path actually does.
 *  - Exits are *partial-fill tolerant*. A position is never removed early; it
 *    accumulates `exitShares` / `exitProceedsUsd` and is settled normally at
 *    resolution, where the payout is `sold proceeds + (remaining shares x
 *    outcome)`. That keeps exactly one accounting path and makes a half-filled
 *    exit correct rather than a rounding error.
 *  - Sizing respects measured bid depth and a participation cap. The endgame
 *    book on the decided side is frequently bid-only and thin (see
 *    SQS-INVESTIGATION.md), so dumping the whole position into it is how you
 *    turn a win into a slippage loss.
 */
const { computeSellAmounts, roundPriceToTick, tickRules } = require('./orderSigner');
const { estimateSellFill } = require('./clobClient');
const { feePerShare } = require('./pricing');

/** Position statuses that must never be exited (already terminal). */
const TERMINAL_STATUSES = new Set(['SETTLED', 'EXITED', 'CANCELLED', 'REJECTED', 'DRY_RUN']);

/**
 * Round a share count down to the market's size precision.
 * `tickRules(t).size` is the number of allowed decimals for a size.
 */
function floorShares(shares, tickSize) {
  const decimals = tickRules(tickSize).size;
  const f = Math.pow(10, decimals);
  return Math.floor(Number(shares) * f + 1e-9) / f;
}

/**
 * Decide whether a position should be sold now, and on what terms.
 *
 * @param {object} p
 * @param {object} p.position        the open position (see botCore.executeSignal)
 * @param {object} p.book            normalised book for the position's OWN token
 * @param {number} p.probUp          fair-value model probability that UP wins
 * @param {number} p.secondsLeft     seconds until the window closes (live clock)
 * @param {object} p.feeSchedule     the market's published fee schedule
 * @param {object} p.cfg             CONFIG.exit block
 * @param {number} [p.now]           epoch ms (injectable for tests)
 * @returns {{exit:boolean, reason:string, code?:string, sellShares?:number,
 *            limitPrice?:number, expectedVwap?:number, expectedGrossUsd?:number,
 *            expectedFeeUsd?:number, expectedNetUsd?:number, expectedPnlUsd?:number,
 *            allocatedCostUsd?:number, fill?:object}}
 */
function planExit({ position, book, probUp, secondsLeft, feeSchedule, cfg, now = Date.now() }) {
  const pos = position || {};
  const no = (code, reason) => ({ exit: false, code, reason });

  if (!cfg || !cfg.enabled) return no('disabled', 'pre-expiry exit is disabled (EXIT_ENABLED=false)');
  if (!pos || !pos.tokenId) return no('no-position', 'no position to exit');
  if (TERMINAL_STATUSES.has(pos.status)) return no('terminal', `position is ${pos.status}`);
  if (pos.exiting) return no('in-flight', 'an exit order is already live for this position');

  // The book is the current constraint source. A position's saved tick is only
  // an entry-time snapshot and may be stale after a tick_size_change event.
  // Every rounded value below (size, limit and signed amounts) must use the
  // tick that applies to the token being sold now.
  const bookTick = Number(book && book.tickSize);
  const positionTick = Number(pos.tickSize);
  const fallbackTick = Number(cfg.tickSizeFallback);
  const tickSize = Number.isFinite(bookTick) && bookTick > 0
    ? bookTick
    : Number.isFinite(positionTick) && positionTick > 0
      ? positionTick
      : Number.isFinite(fallbackTick) && fallbackTick > 0
        ? fallbackTick
        : 0.01;
  const heldTotal = Number(pos.filledShares || 0);
  const alreadySold = Number(pos.exitShares || 0);
  if (!(heldTotal > 0)) return no('unfilled', 'position has no filled shares yet');

  const sellable = floorShares(heldTotal - alreadySold, tickSize);
  if (!(sellable > 0)) return no('already-exited', 'every filled share has already been sold');

  // ------------------------------------------------------------- time gate
  // Fire inside a band, not at the last second: the exit order needs a round
  // trip and the entry path needs the freed balance before the window closes.
  const sec = Number(secondsLeft);
  if (!Number.isFinite(sec)) return no('no-clock', 'time to expiry is unknown');
  if (sec > cfg.maxSecondsToExpiry) {
    return no('too-early', `${Math.round(sec)}s to expiry — exits start at ${cfg.maxSecondsToExpiry}s`);
  }
  if (sec < cfg.minSecondsToExpiry) {
    // Past the floor we no longer have time to sell and re-use the proceeds.
    // Leave it to resolution (and to the redemption sweeper) rather than
    // firing an order that cannot settle cleanly.
    return no('too-late', `only ${Math.round(sec)}s left — below EXIT_MIN_SECONDS=${cfg.minSecondsToExpiry}s, holding to resolution`);
  }

  // ------------------------------------------------------- conviction gate
  if (!Number.isFinite(probUp)) return no('no-model', 'no fair-value model for this window');
  const probSide = String(pos.side).toUpperCase() === 'UP' ? probUp : 1 - probUp;
  if (probSide < cfg.minModelProb) {
    return no('not-decided',
      `model gives ${pos.side} ${(probSide * 100).toFixed(1)}% — below EXIT_MIN_MODEL_PROB ${(cfg.minModelProb * 100).toFixed(1)}%`);
  }

  // ----------------------------------------------------------- book gates
  if (!book || !Array.isArray(book.bids) || !book.bids.length) {
    // The common endgame shape on the LOSING side, and occasionally on the
    // decided side too. Not an error — just nothing to sell into.
    return no('no-bids', `no bid liquidity on ${pos.side} — cannot sell`);
  }
  const bestBid = book.bestBid !== null && book.bestBid !== undefined ? book.bestBid : book.bids[0].price;
  if (!(bestBid > 0)) return no('no-bids', `no usable bid on ${pos.side}`);
  if (bestBid < cfg.minSellPrice) {
    return no('bid-too-low',
      `best bid ${(bestBid * 100).toFixed(1)}c is below EXIT_MIN_SELL_PRICE ${(cfg.minSellPrice * 100).toFixed(1)}c — the market does not agree this is decided`);
  }
  if (bestBid > cfg.maxSellPrice) {
    return no('bid-above-cap',
      `best bid ${(bestBid * 100).toFixed(1)}c is above EXIT_MAX_SELL_PRICE ${(cfg.maxSellPrice * 100).toFixed(1)}c — holding for the $1.00 redemption is better than selling here`);
  }

  // ----------------------------------------------------------- size gates
  // Walk the bid ladder to see what the position would actually fetch, then
  // cap participation so we are not the whole print.
  const probe = estimateSellFill(book, sellable);
  if (!probe || !(probe.shares > 0)) return no('no-bids', `bid ladder cannot take any of ${sellable} shares`);

  const bidDepthShares = Number(book.bidDepthShares || probe.shares) || probe.shares;
  const maxByParticipation = floorShares(bidDepthShares * cfg.maxBidDepthParticipation, tickSize);
  let shares = Math.min(sellable, maxByParticipation);
  shares = floorShares(shares, tickSize);
  if (!(shares > 0)) {
    return no('depth-too-thin',
      `bid depth ${bidDepthShares.toFixed(2)} shares x ${(cfg.maxBidDepthParticipation * 100).toFixed(0)}% participation rounds to zero`);
  }

  // A marketable SELL limit rounds DOWN to the tick so it still crosses the bid.
  const limitPrice = roundPriceToTick(Math.max(bestBid, cfg.minSellPrice), tickSize, 'down');
  if (!(limitPrice > 0) || limitPrice >= 1) {
    return no('bad-price', `sell limit ${limitPrice} is outside (0,1) after tick rounding`);
  }

  const fill = estimateSellFill(book, shares) || probe;
  const grossUsd = fill.proceeds;
  const feeUsd = feePerShare(fill.vwap, feeSchedule) * fill.shares;
  const netUsd = grossUsd - feeUsd;

  // Cost attributable to the shares being sold, so partial exits stay honest.
  const avgCost = heldTotal > 0 ? Number(pos.filledUsd || 0) / heldTotal : 0;
  const allocatedCostUsd = avgCost * shares;
  const expectedPnlUsd = netUsd - allocatedCostUsd;

  if (expectedPnlUsd < cfg.minProfitFloorUsd) {
    return no('below-profit-floor',
      `selling ${shares} shares returns $${netUsd.toFixed(2)} net vs $${allocatedCostUsd.toFixed(2)} of cost `
      + `= $${expectedPnlUsd.toFixed(2)}, below EXIT_MIN_PROFIT_FLOOR_USD $${cfg.minProfitFloorUsd.toFixed(2)} — `
      + 'holding to the $1.00 redemption instead');
  }
  if (cfg.minNetEdge > 0) {
    const edge = probSide - limitPrice - feePerShare(limitPrice, feeSchedule);
    if (edge < cfg.minNetEdge) {
      return no('edge-too-thin',
        `net edge ${(edge * 100).toFixed(2)}c at the sell limit is below EXIT_MIN_NET_EDGE ${(cfg.minNetEdge * 100).toFixed(2)}c`);
    }
  }

  // ----------------------------------------------------- retry suppression
  // An exit that was attempted and did not fill must not be re-fired every
  // tick for the rest of the window: that is how a bot spams the exchange.
  if (pos.lastExitAttemptAt && cfg.retryCooldownSeconds > 0) {
    const elapsed = (now - Number(pos.lastExitAttemptAt)) / 1000;
    if (elapsed < cfg.retryCooldownSeconds) {
      return no('retry-cooldown',
        `last exit attempt was ${elapsed.toFixed(0)}s ago — waiting out the ${cfg.retryCooldownSeconds}s cooldown`);
    }
  }
  if (cfg.maxAttemptsPerPosition > 0 && Number(pos.exitAttempts || 0) >= cfg.maxAttemptsPerPosition) {
    return no('attempts-exhausted',
      `${pos.exitAttempts} exit attempt(s) already made — EXIT_MAX_ATTEMPTS=${cfg.maxAttemptsPerPosition} reached`);
  }

  let amounts;
  try {
    amounts = computeSellAmounts(limitPrice, shares, tickSize);
  } catch (e) {
    return no('sizing-failed', `sell sizing failed: ${e.message}`);
  }

  return {
    exit: true,
    code: 'exit',
    reason: `model ${pos.side} ${(probSide * 100).toFixed(1)}%, bid ${(bestBid * 100).toFixed(1)}c, `
      + `${Math.round(sec)}s to expiry — selling ${amounts.size} shares at ${(amounts.price * 100).toFixed(1)}c`,
    probSide,
    tickSize,
    sellShares: amounts.size,
    limitPrice: amounts.price,
    makerAmount: amounts.makerAmount,
    takerAmount: amounts.takerAmount,
    expectedVwap: fill.vwap,
    expectedGrossUsd: grossUsd,
    expectedFeeUsd: feeUsd,
    expectedNetUsd: netUsd,
    allocatedCostUsd,
    expectedPnlUsd,
    fill,
    complete: !!fill.complete,
  };
}

/**
 * Apply an exit fill to a position, in place.
 *
 * Two modes, and picking the wrong one double-counts money:
 *
 *   accumulate (default)  for an incremental fill — a second partial exit, or a
 *                         paper simulation. Adds to what is already booked.
 *   authoritative         for a reading of the exchange's own order state
 *                         (`size_matched`), which is a RUNNING TOTAL, not a
 *                         delta. Sets the exit fields to exactly that total.
 *
 * `botCore.reconcileExitOrder` always passes `authoritative: true`, which is
 * what makes it safe to call from three places at once (the immediate
 * reconcile, the delayed reconcile and the user websocket) without inflating
 * `exitShares` or `recycledUsd`.
 */
function applyExitFill(position, {
  shares, grossUsd, feeUsd, vwap, orderId = null, isPaper = false, authoritative = false,
}) {
  const base = authoritative ? 0 : Number(position.exitShares || 0);
  const baseProceeds = authoritative ? 0 : Number(position.exitProceedsUsd || 0);
  const baseFee = authoritative ? 0 : Number(position.exitFeeUsd || 0);
  position.exitShares = Number((base + Number(shares)).toFixed(6));
  position.exitProceedsUsd = Number((baseProceeds + Number(grossUsd)).toFixed(6));
  position.exitFeeUsd = Number((baseFee + Number(feeUsd)).toFixed(6));
  position.exitAvgPrice = position.exitShares > 0
    ? position.exitProceedsUsd / position.exitShares
    : Number(vwap) || null;
  position.exitedAt = new Date().toISOString();
  position.exitMode = isPaper ? 'paper' : 'live';
  if (orderId) {
    position.exitOrderIds = position.exitOrderIds || [];
    if (!position.exitOrderIds.includes(orderId)) position.exitOrderIds.push(orderId);
  }
  // Remaining shares are what resolution still has to pay out on.
  position.remainingShares = Number(Math.max(
    0, Number(position.filledShares || 0) - position.exitShares,
  ).toFixed(6));
  position.exiting = false;
  return position;
}

/** Mark a position as having an exit order in flight (blocks re-entry + re-fire). */
function markExitPending(position, { orderId = null, attemptReason = '' } = {}) {
  position.exiting = true;
  position.exitAttempts = Number(position.exitAttempts || 0) + 1;
  position.lastExitAttemptAt = Date.now();
  position.lastExitReason = attemptReason || null;
  if (orderId) {
    position.exitOrderIds = position.exitOrderIds || [];
    if (!position.exitOrderIds.includes(orderId)) position.exitOrderIds.push(orderId);
  }
  return position;
}

/** Clear an in-flight exit flag after reconciliation (filled or not). */
function clearExitPending(position) {
  position.exiting = false;
  return position;
}

/** Shares still exposed to resolution for a position. */
function remainingShares(position) {
  return Number(Math.max(
    0, Number(position.filledShares || 0) - Number(position.exitShares || 0),
  ).toFixed(6));
}

/**
 * The resolution payout for a position that may have been partly sold:
 * cash already banked from the exit, plus $1.00/share on whatever is still
 * held if that side won.
 */
function exitAdjustedPayout(position, won) {
  const sold = Number(position.exitProceedsUsd || 0);
  const held = remainingShares(position);
  return sold + (won ? held : 0);
}

/** Total fees paid on a position: entry taker fee + any exit taker fees. */
function totalFees(position) {
  return Number(position.feeUsd || 0) + Number(position.exitFeeUsd || 0);
}

/** True when a position has been at least partly sold before resolution. */
function wasExited(position) {
  return Number(position.exitShares || 0) > 0;
}

/** Compact per-position exit view for the dashboard. */
function exitView(position) {
  return {
    id: position.id,
    slug: position.marketSlug,
    side: position.side,
    filledShares: Number(position.filledShares || 0),
    exitShares: Number(position.exitShares || 0),
    remainingShares: remainingShares(position),
    exitProceedsUsd: Number((Number(position.exitProceedsUsd || 0)).toFixed(4)),
    exitFeeUsd: Number((Number(position.exitFeeUsd || 0)).toFixed(4)),
    exitAvgPrice: position.exitAvgPrice ?? null,
    exiting: !!position.exiting,
    exitAttempts: Number(position.exitAttempts || 0),
    lastExitReason: position.lastExitReason || null,
    status: position.status,
  };
}

module.exports = {
  TERMINAL_STATUSES,
  applyExitFill,
  clearExitPending,
  exitAdjustedPayout,
  exitView,
  floorShares,
  markExitPending,
  planExit,
  remainingShares,
  totalFees,
  wasExited,
};
