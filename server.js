// server.js — HTTP layer (express). Contracts must stay byte-compatible:
//   GET  /health   no auth, fast
//   GET  /solve    ?url=&sitekey=[&timeout=][&proxy=]   X-Token auth
//   GET  /castle   ?pk=&timeout=                        X-Token auth
//   POST /turnstile {url, sitekey, proxy?}              X-Token auth
//   POST /iuam      {url, proxy?}                       X-Token auth
const express = require('express');
const crypto = require('crypto');
const solver = require('./solver');

const PORT = parseInt(process.env.PORT || '407', 10); // Railway injects PORT
const API_TOKEN = process.env.API_TOKEN || '';

const app = express();

// H1 capture overlay: expose captures dir (CHI khi CAPTURE=1 — service tam, xoa sau khi keo)
if (process.env.CAPTURE === '1') {
  app.use('/captures', require('express').static('/app/captures'));
}
  // H1: bat capture-proxy xuat session ra dia (no chi ghi khi nhan SIGINT)
  app.get('/capture-status', (_req, res) => {
    const fs = require('fs');
    const out = { capture: process.env.CAPTURE, proxy_args: process.env.PROXY_LAUNCH_ARGS || null };
    try { out.pid = parseInt(fs.readFileSync('/tmp/capture-proxy.pid', 'utf8').trim(), 10); } catch (_) { out.pid = null; }
    if (out.pid) { try { process.kill(out.pid, 0); out.proxy_alive = true; } catch (_) { out.proxy_alive = false; } }
    try { out.ca_dir = fs.readdirSync('/app/proxy-ca'); } catch (_) { out.ca_dir = null; }
    try { out.captures = fs.readdirSync('/app/captures'); } catch (_) { out.captures = null; }
    res.json(out);
  });
  app.get('/capture-dump', (req, res) => {
    try {
      const fs = require('fs');
      const pid = parseInt(fs.readFileSync('/tmp/capture-proxy.pid', 'utf8').trim(), 10);
      process.kill(pid, 'SIGINT');
    } catch (e) { return res.json({ success: false, err: String(e).slice(0, 120) }); }
    const t0 = Date.now();
    const iv = setInterval(() => {
      let files = [];
      try {
        files = fs.readdirSync('/app/captures/sessions') || [];
      } catch (_) {}
      if (files.length || Date.now() - t0 > 20000) {
        clearInterval(iv);
        res.json({ success: files.length > 0, sessions: files });
      }
    }, 1000);
  });
app.disable('x-powered-by');
app.use(express.json());

// ---- X-Token auth (open mode when API_TOKEN unset = local testing) ----
function tokenOk(req) {
    if (!API_TOKEN) return true;
    const given = req.header('x-token') || '';
    const a = Buffer.from(given);
    const b = Buffer.from(API_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function needAuth(req, res) {
    if (tokenOk(req)) return false;
    res.status(401).json({ success: false, err: 'unauthorized' });
    return true;
}

// any throw inside a handler -> 500 JSON, never an HTML stack page
const wrap = fn => (req, res) => {
    Promise.resolve(fn(req, res)).catch(e => {
        if (!res.headersSent) res.status(500).json({ success: false, err: (e && e.message) || String(e) });
    });
};

const drain503 = res => res.status(503).json({ success: false, err: 'draining' });

// ---- GET /health — no auth, no browser touch (checker probes this with 3s timeout) ----
app.get('/httpcheck', (req, res) => {
  const net = require('net'); const tls = require('tls');
  const proxy = new URL(String(req.query.proxy || ''));
  const target = new URL(String(req.query.target || 'https://api.ipify.org'));
  const auth = proxy.username ? 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') : null;
  const s = net.connect(parseInt(proxy.port || '8080', 10), proxy.hostname);
  const t0 = Date.now();
  let done = false;
  const fail = (o) => { if (done) return; done = true; console.log('[HTTP] FAIL', proxy.hostname, JSON.stringify(o)); res.json(o); s.destroy(); };
  s.setTimeout(15000, () => fail({ ok: false, err: 'timeout' }));
  s.on('error', (e) => fail({ ok: false, err: String(e.code || e) }));
  s.on('connect', () => {
    s.write('CONNECT ' + target.hostname + ':443 HTTP/1.1\r\nHost: ' + target.hostname + ':443\r\n' + (auth ? 'Proxy-Authorization: ' + auth + '\r\n' : '') + '\r\n');
  });
  let buf = Buffer.alloc(0);
  s.on('data', (d) => {
    if (done) return;
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf('\r\n\r\n');
    if (i === -1) return;
    const head = buf.slice(0, i).toString();
    if (!/^HTTP\/1\.[01] 200/.test(head)) return fail({ ok: false, head: head.split('\r\n')[0] });
    done = true;
    const rest = buf.slice(i + 4);
    const tt = tls.connect({ socket: s, servername: target.hostname }, () => {
      tt.write('GET ' + (target.pathname || '/') + ' HTTP/1.1\r\nHost: ' + target.hostname + '\r\nConnection: close\r\nUser-Agent: Mozilla/5.0\r\n\r\n');
      if (rest.length) tt.write(rest);
    });
    let body = '';
    tt.on('data', (c) => { body += c.toString(); });
    tt.on('end', () => { console.log('[HTTP] OK', proxy.hostname, Date.now() - t0 + 'ms', body.slice(-30).trim()); res.json({ ok: true, ms: Date.now() - t0, tail: body.slice(-40).trim() }); s.destroy(); });
    tt.on('error', (e) => { console.log('[HTTP] TLSERR', String(e.code || e)); res.json({ ok: false, err: String(e.code || e) }); s.destroy(); });
  });
});

app.get('/tcpcheck', (req, res) => {
  const net = require('net');
  const host = String(req.query.host || ''); const port = parseInt(req.query.port || '0', 10);
  const t0 = Date.now();
  const sock = net.connect({ host, port, timeout: 9000 }, () => {
    console.log('[TCP] OK', host + ':' + port, Date.now() - t0 + 'ms');
    res.json({ ok: true, ms: Date.now() - t0 }); sock.destroy();
  });
  sock.on('timeout', () => { console.log('[TCP] TIMEOUT', host + ':' + port); res.json({ ok: false, err: 'timeout' }); sock.destroy(); });
  sock.on('error', (e) => { console.log('[TCP] ERR', host + ':' + port, e.code); res.json({ ok: false, err: e.code }); });
});

app.get('/probe', (req, res) => {
  console.log('[PROBE]', req.query.tag || '?', String(req.query.url || '').slice(0, 80));
  res.type('text/plain').send('ok');
});

app.get('/health', (req, res) => res.json(solver.health()));

// ---- GET /solve ----
app.get('/solve', wrap(async (req, res) => {
    if (needAuth(req, res)) return;
    const { url, sitekey, timeout, proxy } = req.query;
    if (!url) return res.status(400).json({ success: false, err: 'missing url' });
    if (!sitekey) return res.status(400).json({ success: false, err: 'missing sitekey' });
    if (solver.isDraining()) return drain503(res);
    let closed = false;
    req.on('close', () => { closed = true; }); // client gave up → stop burning a solve slot
    const r = await solver.solveTurnstile(url, sitekey, timeout ? parseFloat(timeout) : solver.DEFAULT_TIMEOUT, proxy, () => closed);
    if (r.success) return res.json(r); // {success, token, time, by} — token length > 50 guaranteed in engine
    delete r.__pooled; // internal retry flag — never leak it into the contract
    return res.status(500).json(r);
}));

// ---- POST /turnstile — B00H0 shape: {token, elapsed:"1.9s", status:"completed"} ----
app.post('/turnstile', wrap(async (req, res) => {
    if (needAuth(req, res)) return;
    const { url, sitekey, proxy } = req.body || {};
    if (!url) return res.status(400).json({ status: 'error', error: 'missing url' });
    if (!sitekey) return res.status(400).json({ status: 'error', error: 'missing sitekey' });
    if (solver.isDraining()) return res.status(503).json({ status: 'error', error: 'draining' });
    let closed = false;
    req.on('close', () => { closed = true; });
    const r = await solver.solveTurnstile(url, sitekey, solver.DEFAULT_TIMEOUT, proxy, () => closed);
    if (r.success) return res.json({ token: r.token, elapsed: r.time.toFixed(1) + 's', status: 'completed' });
    return res.status(500).json({ status: 'error', error: r.err });
}));

// ---- POST /iuam — {cf_clearance, cookies, "user agent", ip} ----
app.post('/iuam', wrap(async (req, res) => {
    if (needAuth(req, res)) return;
    const { url, proxy } = req.body || {};
    if (!url) return res.status(400).json({ success: false, err: 'missing url' });
    if (solver.isDraining()) return drain503(res);
    const r = await solver.solveIuam(url, proxy);
    if (r.success) return res.json({ cf_clearance: r.cf_clearance, cookies: r.cookies, 'user agent': r.ua, ip: r.ip });
    return res.status(500).json({ success: false, err: r.err });
}));

app.get('/castle', wrap(async (req, res) => {
    if (needAuth(req, res)) return;
    if (solver.isDraining()) return drain503(res);
    const { pk, timeout } = req.query;
    let closed = false;
    req.on('close', () => { closed = true; });
    const r = await solver.mintCastle(pk, timeout ? parseFloat(timeout) : 15, () => closed);
    if (r.success) return res.json(r);
    return res.status(500).json(r);
}));

// ---- GET /debug — one throwaway introspected solve (container diagnosis; X-Token auth) ----
app.get('/debug', wrap(async (req, res) => {
    if (needAuth(req, res)) return;
    const { sitekey, url, gpu, seconds, args, bare, bundled, spoof } = req.query;
    const tlsProbe = req.query.tls === '1';
    if (!sitekey) return res.status(400).json({ success: false, err: 'missing sitekey' });
    try {
        const out = await solver.debugSolve(sitekey, url || 'https://example.com/', {
            gpu: gpu === '1', seconds: seconds ? parseInt(seconds, 10) : 20,
            extraArgs: args, bare: bare === '1', bundled: bundled === '1', spoofWebgl: spoof === '1', tls: tlsProbe,
        });
        return res.json(out);
    } catch (e) {
        return res.status(500).json({ success: false, err: (e && e.message) || String(e) });
    }
}));

// ---- GET / — tiny inline status page (no external assets) ----
const HTML_UI = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Turnstile Cloud Solver</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: monospace; background: #0d0d0d; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .wrap { background: #111; border: 1px solid #1e1e1e; border-radius: 8px; padding: 30px; width: 100%; max-width: 480px; }
    h1 { color: #c084fc; font-size: 16px; letter-spacing: -0.3px; }
    .sub { color: #383838; font-size: 11px; margin: 4px 0 22px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: #1a1a1a; border: 1px solid #1a1a1a; border-radius: 6px; overflow: hidden; }
    .c { background: #111; padding: 12px; text-align: center; }
    .v { color: #c084fc; font-size: 18px; font-weight: 700; }
    .l { color: #2e2e2e; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; margin-top: 3px; }
    .ep { margin-top: 16px; color: #3a3a3a; font-size: 10px; line-height: 1.7; }
</style>
</head><body>
<div class="wrap">
    <h1>// turnstile cloud solver</h1>
    <p class="sub">patchright + real chrome — self-hosted</p>
    <div class="grid">
        <div class="c"><div class="v" id="solved">0</div><div class="l">solved</div></div>
        <div class="c"><div class="v" id="failed">0</div><div class="l">failed</div></div>
        <div class="c"><div class="v" id="avg">&mdash;</div><div class="l">avg sec</div></div>
        <div class="c"><div class="v" id="rate">&mdash;</div><div class="l">success</div></div>
        <div class="c"><div class="v" id="pool">0</div><div class="l">pool</div></div>
        <div class="c"><div class="v" id="busy">0</div><div class="l">busy</div></div>
        <div class="c"><div class="v" id="queue">0</div><div class="l">queue</div></div>
    </div>
    <div class="ep">
        GET /solve?url=&lt;url&gt;&amp;sitekey=&lt;key&gt;<br>
        POST /turnstile &middot; POST /iuam &middot; GET /health
    </div>
</div>
<script>
    async function tick() {
        try {
            const d = await (await fetch('/health')).json();
            solved.textContent = d.solved;
            failed.textContent = d.failed;
            avg.textContent = d.solved ? d.avg.toFixed(2) + 's' : '\\u2014';
            rate.textContent = (d.solved + d.failed) ? d.rate.toFixed(1) + '%' : '\\u2014';
            pool.textContent = d.pool;
            busy.textContent = d.busy;
            queue.textContent = d.queue;
        } catch {}
    }
    tick();
    setInterval(tick, 3000);
</script>
</body></html>`;

app.get('/', (req, res) => res.send(HTML_UI));

// unknown route or bad JSON body -> JSON, never HTML
app.use((req, res) => res.status(404).json({ success: false, err: 'not found' }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ success: false, err: err.message || 'server error' }));

// ---- boot ----
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`  Turnstile Cloud Solver  |  @yeatdiddy cloud edition`);
    console.log(`  GET  http://localhost:${PORT}/solve?url=<site>&sitekey=<key>[&timeout=<sec>][&proxy=<urlencoded>]`);
    console.log(`  POST http://localhost:${PORT}/turnstile  {"url","sitekey","proxy"?}`);
    console.log(`  POST http://localhost:${PORT}/iuam       {"url","proxy"?}`);
    console.log(`  auth: ${API_TOKEN ? 'X-Token header required' : 'OPEN (set API_TOKEN to lock down)'}`);
});

solver.init(); // warm the pool in the background — /health answers immediately

// ---- graceful SIGTERM: stop accepting, drain, close browsers, exit 0 ----
let closing = false;
async function bye() {
    if (closing) return;
    closing = true;
    server.close(() => {});
    await solver.shutdown();
    process.exit(0);
}
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
