'use strict';
/**
 * Proof: the same dashboard payload and the same losing day, run against the
 * original code and the patched code.
 *
 *   node proof.js                        # this checkout
 *   node proof.js <path-to-project> "<label>"   # compare against another
 *
 * Scenario: the user sets the dashboard stop-loss to -$300, then has a losing
 * day whose gross losses reach $59.67 in a single settled trade (the counter
 * overshoots the $50 env cap — losses are booked per position, and the check
 * runs once per loop tick).
 */
const path = require('path');
const os = require('os');

const dir = path.resolve(process.argv[2] || __dirname);
const label = process.argv[3] || dir;

const { CONFIG } = require(path.join(dir, 'config.js'));
const { BotCore } = require(path.join(dir, 'botCore.js'));

function scenario() {
  // Rebuild the config the way the user's .env has it (the shipped default).
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.risk.maxDailyLossUsd = 50;
  cfg.risk.stopLossUsd = 25;
  cfg.runtime.stateFile = path.join(os.tmpdir(), `proof-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  const bot = new BotCore({
    config: cfg,
    auth: { setPaperMode() {}, getStatus: () => ({}) },
    log: () => {},
  });

  // 1. The operator types 300 into the dashboard's "Risk Circuit Breaker" box.
  const applied = bot.updateSettings({ stopLossUsd: 300 });

  // 2. They ask for a $300 daily cap too (the control the patch adds).
  const applied2 = bot.updateSettings({ maxDailyLossUsd: 300 });

  // 3. A losing day: gross realised losses reach $59.67.
  bot.isRunning = true;
  bot.dailyLoss = 59.67;
  bot.realizedPnl = -59.67;

  // 4. The risk check runs on the next loop tick (every 750 ms).
  const stillTrading = bot.checkRiskLimits();

  return {
    accepted_cumulative_stop_loss: applied.settingsChanges.applied.find(a => a.key === 'stopLossUsd') || null,
    daily_cap_setting_accepted: applied2.settingsChanges.applied.find(a => a.key === 'maxDailyLossUsd') || null,
    daily_cap_payload_rejected: applied2.settingsChanges.unapplied,
    // Original code has no instance property at all: it reads cfg.risk.* live.
    effective_daily_cap: bot.maxDailyLossUsd !== undefined ? bot.maxDailyLossUsd : bot.cfg.risk.maxDailyLossUsd,
    cap_is_runtime_setting: bot.maxDailyLossUsd !== undefined,
    still_trading_after_59_67_loss: stillTrading && bot.isRunning,
    stopped_reason: bot.stoppedReason,
  };
}

const r = scenario();
console.log(`\n${'='.repeat(74)}\n  ${label}\n${'='.repeat(74)}`);
console.log(`  "Stop-Loss Circuit Breaker" box accepted the $300 ... ${r.accepted_cumulative_stop_loss ? 'yes' : 'NO'}`);
console.log(`  "Max Daily Loss" control accepted the $300 ....... ${r.daily_cap_setting_accepted ? 'yes' : `NO  (rejected: ${JSON.stringify(r.daily_cap_payload_rejected)})`}`);
console.log(`  Daily cap is a runtime setting .................... ${r.cap_is_runtime_setting ? 'yes' : 'NO — read live from .env, unreachable from the UI'}`);
console.log(`  Daily cap the bot actually enforces .............. $${r.effective_daily_cap.toFixed(2)}`);
console.log(`  After -$59.67 of losses, bot is .................. ${r.still_trading_after_59_67_loss ? 'STILL TRADING' : 'STOPPED'}`);
if (r.stopped_reason) console.log(`  Reason ........................................... ${r.stopped_reason}`);
console.log('');
