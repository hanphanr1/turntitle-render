// solver.js — engine: persistent browser pool, FRESH context per request, turnstile + iuam.
// HTTP layer lives in server.js. Patterns ported from the local @YeatTheLegit solver.
const { chromium } = require(process.env.PW_IMPL || 'patchright');
const fs = require('fs');
const path = require('path');

// safety net: a stray rejection (e.g. a page crash racing a route handler) must never take the
// whole service down mid-batch — log it; Railway restarts only on a real process exit.
process.on('unhandledRejection', e => console.error('[UNHANDLED]', (e && e.message) || e));
process.on('uncaughtException', e => console.error('[UNCAUGHT]', (e && e.message) || e));

const POOL_SIZE = Math.max(1, parseInt(process.env.BROWSER_POOL || '2', 10) || 2);
const RECYCLE_AFTER = Math.max(1, parseInt(process.env.RECYCLE_AFTER_CONTEXTS || '50', 10) || 50);
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT || '4', 10) || 4);
const DEFAULT_TIMEOUT = parseFloat(process.env.DEFAULT_TIMEOUT || '30') || 30;
const HANDLE = '@yeatdiddy';

// ---- fingerprint override (2026-10-07): CHI ap dung khi env duoc set (khong set = giu nguyen nhu cu).
// Dung de bisect tin hieu nao lam x.ai reject token: FP_UA / FP_TZ / FP_LOCALE (context-level).
const FP_UA = process.env.FP_UA || '';
const FP_TZ = process.env.FP_TZ || '';
const FP_LOCALE = process.env.FP_LOCALE || '';

const PROXY_ARGS = (process.env.PROXY_LAUNCH_ARGS || '').split(/\s+/).filter(Boolean);
const LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // NO --disable-gpu here: in a GPU-less container it kills WebGL entirely and Turnstile
    // silently refuses to issue. --enable-unsafe-swiftshader restores software WebGL (Chrome 126+).
    '--enable-unsafe-swiftshader',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1536,864', // match the Xvfb screen
    '--window-position=0,0',
    ...PROXY_ARGS,
];

const pool = []; // [{ browser, used, dead, active, closed }]
let busy = 0;
let launching = 0; // a launch + pool splice is mid-flight — keeps pickSlot from stacking duplicate browsers
const waiting = [];
let draining = false;
const stats = { solved: 0, failed: 0, ms: 0 };

// ---- built-in proxy pool (optional): callers that send no proxy get one rotated from here ----
const PROXY_POOL_FILE = process.env.PROXY_POOL_FILE || 'proxies.txt';
let proxyPool = []; // [{ raw, fails }]
let poolIdx = 0;

function loadProxyPool() {
    if (process.env.CAPTURE === '1') {
        // H1 capture: TAT pool proxy — context-level proxy se override --proxy-server cua launch,
        // lam traffic khong qua MITM capture-proxy.
        proxyPool = [];
        console.log('[PROXY-POOL] CAPTURE=1 -> pool off (traffic qua MITM 127.0.0.1:8888)');
        return;
    }
    const file = path.isAbsolute(PROXY_POOL_FILE) ? PROXY_POOL_FILE : path.join(__dirname, PROXY_POOL_FILE);
    try {
        const lines = [...new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()))]
            .filter(l => l && !l.startsWith('#'));
        proxyPool = lines.map(raw => ({ raw, fails: 0 }));
        poolIdx = 0;
        console.log(`[PROXY-POOL] loaded ${proxyPool.length} proxies from ${PROXY_POOL_FILE}`);
    } catch {
        if (proxyPool.length) { /* file vanished — keep serving what we have */ }
        else console.log(`[PROXY-POOL] no ${PROXY_POOL_FILE} — requests without a proxy go direct`);
    }
}

const POOL_FAIL_LIMIT = 3; // consecutive fails before a pooled proxy is benched
const IP_HOURLY = parseInt(process.env.PROXY_IP_HOURLY || '0', 10) || 0; // per-ENTRY picks/hour cap (0 = off) — static exits get CF-throttled above ~100/h
const ipPicks = new Map(); // entry raw -> pick timestamps (last hour)
function pickProxy(explicitRaw) {
    if (explicitRaw) return { pw: parseProxy(explicitRaw), entry: null }; // caller's own proxy always wins
    const now = Date.now();
    let live = proxyPool.filter(e => e.fails < POOL_FAIL_LIMIT);
    if (IP_HOURLY > 0) live = live.filter(e => {
        const a = (ipPicks.get(e.raw) || []).filter(t => now - t < 3600000);
        ipPicks.set(e.raw, a);
        return a.length < IP_HOURLY;
    });
    if (!live.length) return { pw: undefined, entry: null };
    const entry = live[poolIdx++ % live.length];
    if (IP_HOURLY > 0) {
        const a = ipPicks.get(entry.raw) || [];
        a.push(now);
        ipPicks.set(entry.raw, a);
    }
    return { pw: parseProxy(entry.raw), entry };
}

// ---- stub page: turnstile widget + interactive-challenge sniffer ----
// page->solver signalling goes through DOM data-attributes: patchright's evaluate runs in an
// isolated world and never sees window.* set by page scripts, but DOM attributes are shared.

const PORT_INJ = String(process.env.PORT || '8080');
const STEALTH_SRC = `
try { fetch('http://127.0.0.1:${PORT_INJ}/probe?tag=inject&url=' + encodeURIComponent(location.href)).catch(() => {}); } catch (e) {}
try { fetch('http://127.0.0.1:${PORT_INJ}/probe?tag=stealth&url='+encodeURIComponent(location.href)).catch(()=>{}); } catch (e) {}
(() => {
  try {
    const V = 'Intel Inc.';
    const R = 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)';
    const patch = (proto) => {
      if (!proto) return;
      const orig = proto.getParameter;
      proto.getParameter = function (p) {
        if (p === 37445) return V;
        if (p === 37446) return R;
        return orig.apply(this, arguments);
      };
    };
    patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
    // container: khong co sound device -> AudioContext 44100; local Windows 48000
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      try { Object.defineProperty(AC.prototype, 'sampleRate', { get: () => 48000, configurable: true }); } catch (e) {}
      try { Object.defineProperty(AC.prototype, 'destination', { get: function () { return { maxChannelCount: 2, channelCount: 2 }; }, configurable: true }); } catch (e) {}
    }
  } catch (e) {}
})();`;



function buildPage(siteKey, spoofWebgl) {
    const spoof = spoofWebgl ? `<script>
(function(){
try{
var V='Intel Inc.',R='Intel(R) Iris(R) Xe Graphics';
[window.WebGLRenderingContext,window.WebGL2RenderingContext].forEach(function(proto){
if(!proto)return;
var orig=proto.prototype.getParameter;
proto.prototype.getParameter=function(p){
if(p===37445)return V;
if(p===37446)return R;
return orig.apply(this,arguments);
};
});
document.documentElement.setAttribute("data-spoof","1");
}catch(e){}
})();
</` + `script>` : '';
    return `<!DOCTYPE html>
<html><head>
${spoof}
<script>
window.addEventListener("message",function(m){
if(m.origin!=="https://challenges.cloudflare.com"||!m.data)return;
document.documentElement.setAttribute("data-ev",(document.documentElement.getAttribute("data-ev")||"")+"|"+(m.data.event||"?"));
if(m.data.event==="interactiveBegin")document.documentElement.setAttribute("data-ci","1");
try{
var t=(m.data&&(m.data.token||m.data.response))||null;
if(t&&t.length>20)document.documentElement.setAttribute("data-pmtoken",String(t).slice(0,4000));
var c=m.data&&(m.data.code||m.data.errorCode||m.data.failureCode)||null;
if(c)document.documentElement.setAttribute("data-code",(document.documentElement.getAttribute("data-code")||"")+"|"+c);
}catch(e){}
});
</` + `script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></` + `script>
</head>
<body><div class="cf-turnstile" data-sitekey="${siteKey}"></div></body>
</html>`;
}

// ---- proxies: "http://user:pass@host:port" OR bare "ip:port:user:pass" ----
function parseProxy(raw) {
    if (!raw || typeof raw !== 'string') return undefined;
    raw = raw.trim();
    if (!raw) return undefined;
    if (raw.includes('://')) {
        try {
            const u = new URL(raw);
            const p = { server: `${u.protocol}//${u.hostname}:${u.port || 80}` };
            if (u.username) p.username = decodeURIComponent(u.username);
            if (u.password) p.password = decodeURIComponent(u.password);
            return p;
        } catch {
            return undefined;
        }
    }
    const parts = raw.split(':');
    if (parts.length === 4) return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
    if (parts.length === 2) return { server: `http://${raw}` };
    return undefined;
}

// ---- FIFO semaphore: requests queue, never rejected ----
function acquire() {
    return new Promise((resolve, reject) => {
        if (draining) return reject(new Error('draining'));
        if (busy < MAX_CONCURRENT) { busy++; return resolve(); }
        waiting.push({ resolve, reject });
    });
}

function release() {
    const next = waiting.shift();
    if (next) next.resolve(); // hand the slot straight to the next waiter
    else busy--;
}

// ---- browser pool ----

// H1 debug: mo page bat ky tu browser pool (dung kiem tra proxy routing)
async function debugOpenPage(url) {
    const slot = await pickSlot();
    const ctx = await slot.browser.newContext({ viewport: null });
    const pg = await ctx.newPage();
    const resp = await pg.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' }).catch(e => { throw e; });
    return pg;
}

async function launchSlot(attach = true) {
    const base = { headless: false, args: LAUNCH_ARGS };
    let browser;
    try {
        browser = await chromium.launch({ ...base, channel: 'chrome' }); // real Chrome beats bundled chromium (TLS/JA3)
    } catch {
        browser = await chromium.launch(base); // fallback when no chrome executable exists
    }
    const slot = { browser, used: 0, dead: false, active: 0, closed: false };

    // crash recovery: an OOM-killed / crashed Chrome must never brick the pool — a fresh
    // replacement is spliced in; in-flight contexts fail their own requests and the slot heals.
    browser.on('disconnected', () => {
        if (!slot.dead && !draining) recycleSlot(slot).catch(() => {});
    });
    if (attach) pool.push(slot); // exactly-once: callers that splice in place pass attach=false
    return slot;
}

async function pickSlot() {
    let live = pool.filter(s => !s.dead);
    if (live.length) return live.sort((a, b) => a.used - b.used)[0];
    if (launching) await new Promise(r => { // a lazy/replacement launch is mid-flight — wait for it, don't stack another
        const t = setInterval(() => { if (!launching) { clearInterval(t); r(); } }, 50);
    });
    live = pool.filter(s => !s.dead);
    if (live.length) return live.sort((a, b) => a.used - b.used)[0];
    launching++;
    try {
        const fresh = await launchSlot(false); // attach=false — spliced in below, never pushed twice
        const dead = pool.findIndex(s => s.dead); // reclaim a retired entry so the pool never outgrows POOL_SIZE
        if (dead >= 0) pool[dead] = fresh; else pool.push(fresh);
        return fresh; // pool still warming or everything mid-recycle — went lazy
    } finally {
        launching--;
    }
}

// bleed fingerprint accumulation: launch the replacement FIRST, then close the old one
async function recycleSlot(slot) {
    if (slot.dead) return;
    slot.dead = true; // pickSlot stops handing it out from here on
    launching++;
    let fresh;
    try {
        fresh = await launchSlot(false); // attach=false — spliced in below, never pushed twice
        const i = pool.indexOf(slot);
        if (i >= 0) pool[i] = fresh; else pool.push(fresh);
    } catch (e) {
        console.error('[POOL] replacement launch failed, keeping old browser:', e.message);
        slot.dead = false;
        return;
    } finally {
        launching--;
    }
    console.log(`[POOL] recycled browser after ${slot.used} contexts`);
    closeIfDrained(slot); // old browser only dies once its in-flight contexts are gone
}

// deferred close: retire() may fire while sibling solves still ride this browser
function closeIfDrained(slot) {
    if (!slot.dead || slot.active > 0 || slot.closed) return;
    slot.closed = true;
    slot.browser.close().catch(() => {});
}

function releaseSlot(slot) { // one in-flight context done; a retired browser closes when the last one leaves
    if (slot.active > 0) slot.active--;
    closeIfDrained(slot);
}

function retire(slot) {
    if (slot && slot.used >= RECYCLE_AFTER) recycleSlot(slot); // async, best-effort
}

// A renderer/browser crash makes every later newContext/newPage on the same browser throw
// "Target page, context or browser has been closed" — swap that browser out immediately
// instead of letting the poisoned slot serve failures forever (it once bricked a full run).
function replaceIfDeadBrowser(slot, e) {
    if (!slot || slot.dead) return;
    const msg = (e && e.message) || String(e || '');
    if (!/has been closed|Target crashed|disconnected|Protocol error|has disconnected/i.test(msg)) return;
    recycleSlot(slot).catch(() => {});
}

// ---- turnstile: route-fulfill stub + poll + humanized click ----
async function solveTurnstile(siteUrl, siteKey, timeoutSec, proxyRaw, isCancelled) {
    const timeout = Math.min(120, Math.max(5, parseFloat(timeoutSec) || DEFAULT_TIMEOUT));
    await acquire();
    const t0 = Date.now();
    try {
        if (isCancelled && isCancelled()) return { success: false, err: 'client-gone' }; // dropped while queued
        let r = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            r = await solveTurnstileOnce(siteUrl, siteKey, timeout, t0, proxyRaw, isCancelled);
            if (r.success) break;
            if (r.err === 'client-gone') break; // client hung up — reclaim the slot, no retry
            // a pooled proxy that died mid-solve gets ONE immediate retry on the next rotation,
            // but only while at least half the budget is still left
            if (!r.__pooled || Date.now() - t0 > timeout * 500) break;
        }
        return r;
    } finally {
        release();
    }
}

async function solveTurnstileOnce(siteUrl, siteKey, timeout, t0, proxyRaw, isCancelled) {
    let slot = null, ctx = null, pg = null, prox = null;
    try {
        slot = await pickSlot();
        slot.active++; // claim the browser — recycle defers its close until this drops back to 0
        prox = pickProxy(proxyRaw);
        const ctxOpts = { viewport: null, proxy: prox.pw };
        if (FP_UA) ctxOpts.userAgent = FP_UA;
        if (FP_TZ) ctxOpts.timezoneId = FP_TZ;
        if (FP_LOCALE) ctxOpts.locale = FP_LOCALE;
        ctx = await slot.browser.newContext(ctxOpts);
        console.log(`[SOLVE] slot=${slot.used} proxy=${prox.pw ? (prox.pw.server || 'pool') : 'direct'} ua=${FP_UA ? 'win' : 'native'} tz=${FP_TZ || '-'} loc=${FP_LOCALE || '-'}`);
        slot.used++;
        pg = await ctx.newPage();
        pg.on('request', (r) => {
            const u2 = r.url();
            if (u2.includes('challenges.cloudflare.com')) console.log('[CF-REQ]', r.resourceType(), u2.slice(0, 200));
        });
        // site isolation da tat -> script nay ap dung ca vao iframe cua CF (cung process)
        try {
            const cdp = await ctx.newCDPSession(pg);
            await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SRC });
        } catch (e) { console.log('[STEALTH] cdp err', String(e && e.message).slice(0, 60)); }
        // 2026-10-19: CF widget chay trong iframe cross-origin -> phai spoof trong realm cua no.
        // Playwright khong route CDP child session, nen chen spoof vao chinh JS cua challenges.cloudflare.com.
        if (process.env.SPOOF_CF_JS === '1') {
            await pg.route('https://challenges.cloudflare.com/**', async (route) => {
                try {
                    const resp = await route.fetch();
                    const req = route.request();
                    const rt = req.resourceType();
                    const ct = (resp.headers()['content-type'] || '');
                    if (rt !== 'script' && !ct.includes('text/html')) return await route.fulfill({ response: resp });
                    let body = await resp.text();
                    const headers = { ...resp.headers() };
                    delete headers['content-encoding']; delete headers['content-length'];
                    if (ct.includes('text/html')) {
                        body = body.replace(/<head([^>]*)>/i, '<head$1><script>' + STEALTH_SRC + '</scr' + 'ipt>');
                    } else {
                        body = STEALTH_SRC + '\n;' + body;
                    }
                    return await route.fulfill({ status: resp.status(), headers, body });
                } catch (e) {
                    try { await route.continue(); } catch (e2) {}
                }
            });
        }
        // 2026-10-19: rewrite header mang cho request toi challenges.cloudflare.com (JS van Linux,
        // nhung header/TLS-facing thi Windows). Test xem CF co dung JS hay dung header.
        if (process.env.HDR_SPOOF === '1') {
            await pg.route('https://challenges.cloudflare.com/**', async (route) => {
                const h = { ...route.request().headers() };
                delete h['sec-ch-ua-platform-version'];
                Object.assign(h, {
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
                    'sec-ch-ua': '"Chromium";v="155", "Google Chrome";v="155", "Not.A/Brand";v="24"',
                    'sec-ch-ua-full-version-list': '"Chromium";v="155.0.8059.84", "Google Chrome";v="155.0.8059.84", "Not.A/Brand";v="24.0.0.0"',
                    'sec-ch-ua-full-version': '"155.0.8059.84"',
                    'sec-ch-ua-platform': '"Windows"',
                    'sec-ch-ua-platform-version': '"10.0.0"',
                    'sec-ch-ua-arch': '"x86"',
                    'sec-ch-ua-bitness': '"64"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-model': '""',
                });
                try { await route.continue({ headers: h }); } catch (e) { try { await route.continue(); } catch (e2) {} }
            });
        }
        if (!siteUrl.endsWith('/')) siteUrl += '/';
        // fulfill() rejects if the page crashes mid-flight — never let that escape as an
        // unhandled rejection (it killed the whole service once under RAM pressure)
        // 2026-10-22: VPS 5Mbps — abort resource nang (anh/media/font) de gianh bandwidth
        // cho script CF. Dang ki TRUOC route stub cu the (Playwright: route sau dang ky chay truoc).
        await pg.route('**/*', async (route) => {
            try {
                const rt = route.request().resourceType();
                if (rt === 'image' || rt === 'media' || rt === 'font') return await route.abort();
                return await route.continue();
            } catch (e) { try { await route.continue(); } catch (e2) {} }
        });
        await pg.route(siteUrl, r => r.fulfill({ body: buildPage(siteKey), status: 200, contentType: 'text/html' }).catch(() => {}));
        await pg.goto(siteUrl, { timeout: 15000 });

        let clicked = false;
        while (Date.now() - t0 < timeout * 1000) {
            if (isCancelled && isCancelled()) return { success: false, err: 'client-gone' }; // slot back, no stats hit
            // token lands in the response input AND/OR in the widget's postMessage payload
            // (sniffer stores it in a DOM attribute — shared across patchright's isolated worlds)
            const [tok, pmtok, ci] = await pg.evaluate(`[
                document.querySelector("[name=cf-turnstile-response]")?.value||null,
                document.documentElement.getAttribute("data-pmtoken")||null,
                document.documentElement.getAttribute("data-ci")||0
            ]`);
            const token = (tok && tok.length > 50 && tok) || (pmtok && pmtok.length > 50 && pmtok) || null;
            if (!token && ci && Date.now() - t0 > 4000 && !globalThis.__dbgLogged) {
                globalThis.__dbgLogged = true;
                console.log(`[SOLVE-DBG] input=${tok ? tok.length : 0} pm=${pmtok ? pmtok.length : 0} ci=${ci} iframes=${await pg.evaluate('document.querySelectorAll("iframe").length')}`);
            }

            if (token) {
                const elapsed = Math.round((Date.now() - t0) / 10) / 100;
                stats.solved++;
                stats.ms += elapsed * 1000;
                if (prox.entry) prox.entry.fails = 0; // pooled proxy just proved itself
                const src = (tok && tok.length > 50) ? 'input' : 'pm';
                console.log(`[SOLVE-OK] slot=${slot.used} proxy=${prox.pw ? (prox.pw.server || 'pool') : 'direct'} src=${src} len=${token.length} head=${token.slice(0, 24)} t=${elapsed}`);
                return { success: true, token, time: elapsed, by: HANDLE };
            }
            // (fall through: poll until timeout)

            if (ci && !clicked) {
                clicked = true;
                setTimeout(async () => { // humanized gesture, fire-and-forget
                    try {
                        const box = await pg.locator('.cf-turnstile').boundingBox();
                        if (!box) return;
                        await pg.mouse.move(box.x + 80, box.y + 18);
                        await new Promise(r => setTimeout(r, 100));
                        await pg.mouse.move(box.x + 25, box.y + box.height / 2, { steps: 5 });
                        await new Promise(r => setTimeout(r, 80));
                        await pg.mouse.click(box.x + 25, box.y + box.height / 2);
                    } catch {}
                }, 180);
            }

            await new Promise(r => setTimeout(r, 250));
        }

        stats.failed++;
        if (prox && prox.entry) prox.entry.fails++;
        try {
            const st = await pg.evaluate(`[location.href, document.readyState, (window.turnstile?1:0), document.querySelectorAll('script').length, document.querySelectorAll('div').length]`);
            console.log('[SOLVE-TMO]', JSON.stringify(st).slice(0, 160));
        } catch (e) { console.log('[SOLVE-TMO] probe err', String(e && e.message).slice(0, 80)); }

        return { success: false, err: 'timeout', __pooled: !!(prox && prox.entry) };
    } catch (e) {
        stats.failed++;
        if (prox && prox.entry) prox.entry.fails++; // prox is null when the throw pre-dated pickProxy (e.g. browser launch)
        replaceIfDeadBrowser(slot, e);
        return { success: false, err: (e && e.message) || String(e), __pooled: !!(prox && prox.entry) };
    } finally {
        try { if (pg) await pg.close(); } catch {}
        try { if (ctx) await ctx.close(); } catch {} // proxied contexts are NEVER reused
        if (slot) releaseSlot(slot); // in-flight count drops BEFORE retire may flag the slot dead
        retire(slot);
    }
}

// ---- iuam: ride out the "under attack" page, harvest cf_clearance + egress ip ----
async function solveIuam(url, proxyRaw) {
    await acquire();
    const t0 = Date.now();
    let slot = null, ctx = null, pg = null, prox = null;
    try {
        slot = await pickSlot();
        slot.active++; // claim the browser — recycle defers its close until this drops back to 0
        prox = pickProxy(proxyRaw);
        ctx = await slot.browser.newContext({ viewport: null, proxy: prox.pw });
        slot.used++;
        pg = await ctx.newPage();
        await pg.goto(url, { timeout: 60000 });

        const deadline = Date.now() + 60000; // cookie wait starts after goto, per contract
        while (Date.now() < deadline) {
            const cookies = await ctx.cookies();
            const cl = cookies.find(c => c.name === 'cf_clearance');
            if (cl) {
                const map = {};
                for (const c of cookies) map[c.name] = c.value;
                let ua = null;
                try { ua = await pg.evaluate('navigator.userAgent'); } catch {}
                let ip = null;
                try {
                    const r = await ctx.request.get('https://api.ipify.org?format=json', { timeout: 5000 }); // inherits the proxy
                    ip = (await r.json()).ip;
                } catch {}
                const elapsed = Math.round((Date.now() - t0) / 10) / 100;
                stats.solved++;
                stats.ms += elapsed * 1000;
                if (prox.entry) prox.entry.fails = 0;
                return { success: true, cf_clearance: cl.value, cookies: map, ua, ip, time: elapsed };
            }
            await new Promise(r => setTimeout(r, 500));
        }

        stats.failed++;
        if (prox && prox.entry) prox.entry.fails++;
        return { success: false, err: 'timeout' };
    } catch (e) {
        stats.failed++;
        if (prox && prox.entry) prox.entry.fails++;
        replaceIfDeadBrowser(slot, e);
        return { success: false, err: (e && e.message) || String(e) };
    } finally {
        try { if (pg) await pg.close(); } catch {}
        try { if (ctx) await ctx.close(); } catch {}
        if (slot) releaseSlot(slot); // in-flight count drops BEFORE retire may flag the slot dead
        retire(slot);
        release();
    }
}

const CASTLE_PK_DEFAULT = process.env.CASTLE_PK || 'pk_p8GGWvD3TmFJZRsX3BQcqAv9aFVispNz';
const CASTLE_JS_PATH = path.join(__dirname, 'castle.browser.js');
let CASTLE_JS = Buffer.alloc(0);
try { CASTLE_JS = fs.readFileSync(CASTLE_JS_PATH); } catch (e) {
    console.error('[CASTLE] missing castle.browser.js', e && e.message);
}

function buildCastlePage(pk) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div id="st">boot</div><div id="tok"></div>
<script src="https://accounts.x.ai/castle.browser.js"></script>
<script>
(async () => {
  const st = (s) => document.getElementById("st").textContent = s;
  try {
    const C = window.Castle || window.castle;
    if (!C || !C.configure) { st("err no Castle SDK"); return; }
    const castle = C.configure({ pk: ${JSON.stringify(pk)} });
    await new Promise(r => setTimeout(r, 1500));
    const t = await castle.createRequestToken();
    document.getElementById("tok").textContent = t || "";
    st("ok");
  } catch (e) { st("err " + String(e)); }
})();
</script></body></html>`;
}

async function mintCastle(pk, timeoutSec, isCancelled) {
    if (!CASTLE_JS.length) return { success: false, err: 'castle.browser.js missing' };
    const timeout = Math.min(60, Math.max(5, parseFloat(timeoutSec) || 15));
    const html = buildCastlePage(pk || CASTLE_PK_DEFAULT);
    await acquire();
    const t0 = Date.now();
    let slot = null, ctx = null, pg = null;
    try {
        if (isCancelled && isCancelled()) return { success: false, err: 'client-gone' };
        slot = await pickSlot();
        slot.active++;
        ctx = await slot.browser.newContext({ viewport: null });
        slot.used++;
        pg = await ctx.newPage();
        await pg.route('https://accounts.x.ai/**', async route => {
            const u = route.request().url();
            try {
                if (u.includes('castle.browser.js')) {
                    return route.fulfill({ status: 200, contentType: 'application/javascript', body: CASTLE_JS });
                }
                if (route.request().resourceType() === 'document' || u.includes('sign-in')) {
                    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
                }
                return route.continue();
            } catch {
                return route.abort().catch(() => {});
            }
        });
        await pg.goto('https://accounts.x.ai/sign-in?redirect=grok-com&email=true', { timeout: 15000 });
        while (Date.now() - t0 < timeout * 1000) {
            if (isCancelled && isCancelled()) return { success: false, err: 'client-gone' };
            const [st, tok] = await pg.evaluate(`[
                document.getElementById("st")?.textContent||"",
                document.getElementById("tok")?.textContent||""
            ]`);
            if (st === 'ok' && tok && tok.length > 50) {
                const elapsed = Math.round((Date.now() - t0) / 10) / 100;
                stats.solved++;
                stats.ms += elapsed * 1000;
                return { success: true, token: tok, time: elapsed, by: HANDLE };
            }
            if (String(st).startsWith('err')) return { success: false, err: st };
            await new Promise(r => setTimeout(r, 200));
        }
        stats.failed++;
        return { success: false, err: 'castle timeout' };
    } catch (e) {
        stats.failed++;
        replaceIfDeadBrowser(slot, e);
        return { success: false, err: (e && e.message) || String(e) };
    } finally {
        try { if (pg) await pg.close(); } catch {}
        try { if (ctx) await ctx.close(); } catch {}
        if (slot) releaseSlot(slot);
        retire(slot);
        release();
    }
}

function health() {
    const total = stats.solved + stats.failed;
    return {
        ok: true,
        castle: CASTLE_JS.length > 0,
        pool: pool.filter(s => !s.dead).length,
        busy,
        queue: waiting.length,
        solved: stats.solved,
        failed: stats.failed,
        avg: stats.solved ? Math.round(stats.ms / stats.solved / 10) / 100 : 0,
        rate: total ? Math.round((stats.solved / total) * 1000) / 10 : 0,
        proxies: proxyPool.filter(e => e.fails < POOL_FAIL_LIMIT).length,
        max_concurrent: MAX_CONCURRENT,
    };
}

async function init() {
    loadProxyPool();
    console.log(`[SOLVER] warming ${POOL_SIZE} browser(s) — chrome channel, 1920x1080, headful`);
    for (let i = 0; i < POOL_SIZE; i++) {
        try {
            await launchSlot();
        } catch (e) {
            console.error(`[SOLVER] browser ${i + 1} failed to launch:`, e.message);
        }
    }
    if (!pool.some(s => !s.dead)) console.error('[SOLVER] no browser live — will lazy-launch on first request');
    console.log(`[SOLVER] ready — max concurrent ${MAX_CONCURRENT}, browsers recycle after ${RECYCLE_AFTER} contexts`);
    // hot-reload the pool file when it changes on disk (edit list -> next request uses it, no redeploy)
    const poolFile = path.isAbsolute(PROXY_POOL_FILE) ? PROXY_POOL_FILE : path.join(__dirname, PROXY_POOL_FILE);
    let lastMtime = 0;
    try { lastMtime = fs.statSync(poolFile).mtimeMs; } catch {}
    setInterval(() => {
        try {
            const m = fs.statSync(poolFile).mtimeMs;
            if (m !== lastMtime) { lastMtime = m; loadProxyPool(); }
        } catch {}
    }, 60000).unref();
}

let shut = false;
async function shutdown() {
    if (shut) return;
    shut = true;
    draining = true;
    // settle queued waiters now — an unsettled promise means a socket reset, which clients read as "server down"
    for (const w of waiting.splice(0)) w.reject(new Error('draining'));
    console.log('[SOLVER] SIGTERM — stop accepting, drain in-flight...');
    const t0 = Date.now();
    while (busy > 0 && Date.now() - t0 < 65000) await new Promise(r => setTimeout(r, 250));
    for (const s of pool) { try { await s.browser.close(); } catch {} }
    console.log('[SOLVER] drained, browsers closed');
}

// ---- debug: one throwaway solve with full widget introspection (container diagnosis) ----
async function debugSolve(siteKey, pageUrl, opts = {}) {
    let args;
    if (opts.bare) {
        args = ['--no-sandbox', '--disable-dev-shm-usage']; // minimum viable in-container args
        if (opts.gpu) args.push('--enable-unsafe-swiftshader');
        else args.push('--disable-gpu');
    } else {
        args = LAUNCH_ARGS.filter(a => !(opts.gpu && a === '--disable-gpu'));
        if (opts.gpu) args.push('--enable-unsafe-swiftshader');
    }
    if (opts.extraArgs) args.push(...String(opts.extraArgs).split(' ').filter(Boolean));
    const launchOpts = { headless: false, args };
    if (!opts.bundled) launchOpts.channel = 'chrome'; // real Chrome unless explicitly bundled
    const browser = await chromium.launch(launchOpts).catch(() => chromium.launch({ headless: false, args }));
    const ctx = await browser.newContext({ viewport: null });
    if (opts.spoofWebgl) {
        // stub-page-level spoof lives in buildPage (main world); addInitScript lands in an
        // isolated world under patchright and never reaches the page's real prototypes.
    }
    const pg = await ctx.newPage();
    const out = { events: [], iframes: [], console: [], args };
    if (opts.tls) {
        try {
            const pg2 = await ctx.newPage();
            await pg2.goto('https://tls.peet.ws/api/all', { timeout: 30000, waitUntil: 'domcontentloaded' });
            const txt = await pg2.evaluate('document.body.innerText');
            const j = JSON.parse(txt);
            out.tls = { ja3: j.tls && j.tls.ja3_hash, ja4: j.tls && j.tls.ja4, peet: j.tls && j.tls.peetprint_hash,
                        h2: j.http2 && j.http2.akamai_fingerprint_hash, ua: j.tls && j.tls.user_agent };
            await pg2.close().catch(() => {});
        } catch (e) { out.tls = 'ERR ' + String(e && e.message); }
    }
    // 2026-10-19: so TLS/HTTP2 fingerprint container vs local (CF co the phan biet o tang mang)
    try {
        out.tls = await pg.evaluate(`fetch('https://tls.peet.ws/api/all',{cache:'no-store'}).then(r=>r.json()).then(j=>({ja3:j.tls&&j.tls.ja3_hash, ja4:j.tls&&j.tls.ja4, peet:j.tls&&j.tls.peetprint_hash, h2:j.http2&&j.http2.akamai_fingerprint_hash})).catch(e=>String(e))`);
    } catch (e) { out.tls = 'ERR ' + String(e); }
    // fingerprint probe (2026-10-07): dump day du de diff cloud vs local
    try {
        out.fp = await pg.evaluate(`(() => {
  const out = {};
  try {
    out.ua = navigator.userAgent; out.platform = navigator.platform;
    out.hc = navigator.hardwareConcurrency; out.dm = navigator.deviceMemory;
    out.mtp = navigator.maxTouchPoints; out.langs = navigator.languages;
    out.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    out.screen = [screen.width, screen.height, screen.availWidth, screen.availHeight, screen.colorDepth, devicePixelRatio];
    out.win = [outerWidth, outerHeight, innerWidth, innerHeight];
    out.uad = navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null;
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      out.gl_vendor = gl.getParameter(37445); out.gl_renderer = gl.getParameter(37446);
      out.gl_ext = (gl.getSupportedExtensions() || []).sort();
      out.gl_params = [gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)];
    } else out.gl = null;
  } catch (e) { out.err = String(e); }
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    out.audio = [ac.sampleRate, ac.state, ac.destination && ac.destination.maxChannelCount];
    ac.close && ac.close();
  } catch (e) { out.audio = 'ERR ' + String(e && e.message || e); }
  try {
    const c2 = document.createElement('canvas'); c2.width = 200; c2.height = 50;
    const x = c2.getContext('2d');
    x.textBaseline = 'top'; x.font = '14px Arial';
    x.fillStyle = '#f60'; x.fillRect(0, 0, 200, 50);
    x.fillStyle = '#069'; x.fillText('grok-fp-\(\)', 2, 15);
    const d = c2.toDataURL();
    let h = 0; for (let i = 0; i < d.length; i++) { h = ((h << 5) - h + d.charCodeAt(i)) | 0; }
    out.canvas = [h, d.length];
  } catch (e) { out.canvas = 'ERR'; }
  try {
    const c = document.createElement('canvas'); const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    const tests = ['Arial','Calibri','Segoe UI','Tahoma','Verdana','Times New Roman','Courier New','Roboto','DejaVu Sans','Liberation Sans','Noto Sans'];
    out.fonts = tests.map(f => [f, (()=>{ctx.font = '14px '+f+', monospace'; return Math.round(ctx.measureText('mmmmmmmmmmlliW').width*100)/100;})()]);
  } catch (e) {}
  try {
    const a = document.createElement('audio');
    out.codecs = ['audio/mpeg','audio/ogg; codecs="vorbis"','audio/wav; codecs="1"','audio/mp4; codecs="mp4a.40.2"','video/mp4; codecs="avc1.42E01E"','video/webm; codecs="vp9"'].map(x=>[x, a.canPlayType(x)]);
  } catch(e) {}
  try { out.plugins = navigator.plugins.length; out.mimes = navigator.mimeTypes.length; } catch(e) {}
  return out;
})()`);
    } catch (e) { out.fpErr = String(e).slice(0, 200); }
    pg.on('console', m => out.console.push((m.type() + ': ' + m.text()).slice(0, 200)));
    pg.on('pageerror', e => out.console.push(('PAGEERROR: ' + e).slice(0, 200)));
    try {
        if (!pageUrl.endsWith('/')) pageUrl += '/';
        await pg.route(pageUrl, r => r.fulfill({ body: buildPage(siteKey, !!opts.spoofWebgl), status: 200, contentType: 'text/html' }));
        await pg.goto(pageUrl, { timeout: 15000 });
        const t0 = Date.now();
        while (Date.now() - t0 < (opts.seconds || 20) * 1000) {
            const [tok, ev, pmtok, code, iframes, webgl, ua, inputExists, widgetChildren, spoof] = await pg.evaluate(`[
                document.querySelector("[name=cf-turnstile-response]")?.value||null,
                document.documentElement.getAttribute("data-ev")||"",
                document.documentElement.getAttribute("data-pmtoken")||null,
                document.documentElement.getAttribute("data-code")||"",
                [...document.querySelectorAll("iframe")].map(f=>f.src.slice(0,80)),
                (function(){try{var c=document.createElement("canvas").getContext("webgl");if(!c)return "NO-WEBGL-CONTEXT";var d=c.getExtension("WEBGL_debug_renderer_info");return d?c.getParameter(d.UNMASKED_VENDOR_WEBGL)+" / "+c.getParameter(d.UNMASKED_RENDERER_WEBGL):"no-debug-ext"}catch(e){return "ERR:"+e.message}})(),
                navigator.userAgent,
                !!document.querySelector("[name=cf-turnstile-response]"),
                document.querySelector(".cf-turnstile")?.childElementCount||0,
                document.documentElement.getAttribute("data-spoof")||null
            ]`);
            Object.assign(out, { events: String(ev).split("|").filter(Boolean), pmtoken: pmtok ? pmtok.slice(0, 40) + '...' : null, codes: String(code).split("|").filter(Boolean), iframes, webgl, ua, inputExists, widgetChildren, spoof });
            if ((tok && tok.length > 50) || (pmtok && pmtok.length > 50)) { out.token = (tok || pmtok).slice(0, 40) + '...'; out.via = tok ? 'input' : 'postMessage'; out.elapsed = Math.round((Date.now() - t0) / 100) / 10; break; }
            await new Promise(r => setTimeout(r, 500));
        }
        if (!out.token) out.token = null;
        return out;
    } finally {
        await browser.close().catch(() => {});
    }
}

module.exports = { init, solveTurnstile, solveIuam, mintCastle, health, shutdown, debugSolve, DEFAULT_TIMEOUT, isDraining: () => draining };
