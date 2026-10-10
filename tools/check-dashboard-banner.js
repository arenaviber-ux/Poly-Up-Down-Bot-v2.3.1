'use strict';
/**
 * Render the real dashboard against a stubbed /api/state and read back what the
 * setup banner actually says. This executes public/index.html's own
 * renderState(), not a copy of it.
 *
 *     node tools/check-dashboard-banner.js [stateUrl]
 *
 * The base payload is the live server's own /api/state, so the fixture cannot
 * drift from the shape the UI is written against.
 */
const fs = require('fs');
const path = require('path');

// jsdom is not a project dependency (it is only needed by this check), so a
// missing install must read as "skipped", not as a broken dashboard.
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  console.log('skipped: jsdom is not installed (npm i -D jsdom to run this check)');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const STATE_URL = process.argv[2] || 'http://127.0.0.1:3000/api/state';

function bannerFor(state, health) {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: 'http://localhost:3000/',
    beforeParse(window) {
      // jsdom does not implement innerText, and the dashboard assigns to it.
      // Without this shim the assignment lands on an expando and textContent
      // stays empty, so the harness would read a blank banner for a banner that
      // really was filled in.
      const proto = window.HTMLElement.prototype;
      if (!Object.getOwnPropertyDescriptor(proto, 'innerText')) {
        Object.defineProperty(proto, 'innerText', {
          configurable: true,
          get() { return this.textContent; },
          set(v) { this.textContent = v; },
        });
      }
      window.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/api/state')) return { ok: true, json: async () => state };
        if (u.includes('/api/health')) return { ok: true, json: async () => health };
        if (u.includes('/api/markets')) return { ok: true, json: async () => ({ ok: true, markets: [] }) };
        return { ok: true, json: async () => ({}) };
      };
      window.setInterval = () => 0;
      window.alert = () => {};
    },
  });
  return dom;
}

async function banner(dom) {
  await new Promise(r => setTimeout(r, 80));
  const el = dom.window.document.getElementById('configBanner');
  const txt = dom.window.document.getElementById('configText');
  return {
    shown: !!el && el.style.display === 'block',
    text: txt ? txt.textContent.trim() : 'MISSING ELEMENT',
    errored: dom._error || null,
  };
}

(async () => {
  const base = await fetch(STATE_URL).then(r => r.json());
  // The banner only shows for a running live account.
  Object.assign(base, {
    isRunning: true,
    paperMode: false,
    auth: { ...(base.auth || {}), isAuthenticated: true, hasCredentials: true, walletSetup: { ok: true } },
  });
  const health = {
    ok: true, configErrors: [], configWarnings: [], running: true, mode: 'live',
    geoblock: null, ws: base.ws, feeds: base.feeds, auth: base.auth,
  };

  const cases = [
    ['healthy live account', {
      ...base,
      allowanceWarning: false,
      approvals: { ok: true, verifiedOnChain: true, missing: [], error: null },
      orderVersion: 2, orderVersionOk: true,
    }, null],
    ['missing approvals', {
      ...base,
      allowanceWarning: true,
      approvals: { ok: false, verifiedOnChain: true, missing: ['pUSD -> CTF Exchange'], error: null },
    }, /npm run approve/],
    ['approvals unverifiable (RPC down)', {
      ...base,
      approvals: { ok: false, verifiedOnChain: false, missing: [], error: 'socket hang up' },
    }, /could not be verified/],
    ['wrong order version', {
      ...base, orderVersion: 3, orderVersionOk: false,
    }, /order version 3/],
    ['paper mode hides the banner even with missing approvals', {
      ...base, paperMode: true, allowanceWarning: true,
    }, 'hidden'],
  ];

  let bad = 0;
  for (const [name, state, expect] of cases) {
    const dom = bannerFor(state, health);
    const { shown, text } = await banner(dom);
    const ok = expect === 'hidden' ? !shown
      : expect === null ? !shown
        : shown && expect.test(text);
    if (!ok) bad++;
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}`);
    console.log(`        banner ${shown ? 'shown' : 'hidden'}: ${text || '(empty)'}`);
    dom.window.close();
  }
  console.log(`\n${bad === 0 ? 'all dashboard banner cases behave' : `${bad} case(s) wrong`}`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('check crashed:', e.message); process.exit(2); });
