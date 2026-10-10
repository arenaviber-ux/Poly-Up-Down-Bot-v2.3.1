'use strict';
/**
 * Load the real dashboard in jsdom against the live server and assert it
 * renders without a JS error. The banner copy is checked separately by
 * check-dashboard-banner.js; this is the "does the page actually work" check.
 *
 *     node tools/check-dashboard-renders.js [origin]
 */
const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  console.log('skipped: jsdom is not installed (npm i -D jsdom to run this check)');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const ORIGIN = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');

(async () => {
  // Pull the live payloads so the page renders against real shapes.
  const state = await fetch(`${ORIGIN}/api/state`).then(r => r.json());
  const health = await fetch(`${ORIGIN}/api/health`).then(r => r.json());
  const markets = await fetch(`${ORIGIN}/api/markets`).then(r => r.json());

  const errors = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: `${ORIGIN}/`,
    pretendToBeVisual: true,
    beforeParse(window) {
      // jsdom has no innerText; the dashboard assigns to it.
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
        if (u.includes('/api/markets')) return { ok: true, json: async () => markets };
        return { ok: true, json: async () => ({}) };
      };
      window.setInterval = () => 0;
      window.alert = (m) => errors.push(`alert(): ${m}`);
      window.onerror = (msg, src, line, col, err) => {
        errors.push(`window.onerror: ${msg} (${src}:${line}:${col}) ${err && err.stack ? '\n' + err.stack : ''}`);
      };
      const origError = window.console.error;
      window.console.error = (...a) => { errors.push(`console.error: ${a.join(' ')}`); origError(...a); };
    },
  });

  await new Promise(r => setTimeout(r, 400));

  const doc = dom.window.document;
  const text = (id) => {
    const el = doc.getElementById(id);
    return el ? el.textContent.trim() : 'MISSING';
  };

  // Elements the page is expected to have filled in from /api/state.
  const probes = [
    ['openPosCount', /^\d+$/],
    ['authEmail', /.+/],
    ['authFunder', /.+/],
  ];
  let bad = 0;
  for (const [id, re] of probes) {
    const v = text(id);
    const ok = v !== 'MISSING' && re.test(v);
    if (!ok) { bad++; console.log(`  FAIL #${id} = ${JSON.stringify(v)}`); }
    else console.log(`  ok   #${id} = ${JSON.stringify(v.slice(0, 70))}`);
  }

  if (errors.length) {
    bad += errors.length;
    console.log('\n  JS errors during render:');
    for (const e of errors) console.log(`   - ${e}`);
  } else {
    console.log('\n  no JS errors during render');
  }

  console.log(`\n${bad === 0 ? 'dashboard renders cleanly' : `${bad} problem(s)`}`);
  dom.window.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('check crashed:', e.message); process.exit(2); });
