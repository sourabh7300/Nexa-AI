// Nexa AI integration tests — spawn real server processes, assert over HTTP.
// Run with: npm test   (uses the Node built-in test runner, zero dependencies)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const ROOT = require('node:path').resolve(__dirname, '..');

function startServer(extraEnv = {}, port = '4310') {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: port,
      NODE_ENV: 'test',
      GROQ_API_KEY: '',            // force "no providers" so tests never hit real AI APIs
      GEMINI_API_KEY: '',
      GOOGLE_CLIENT_ID: '',
      SESSION_SECRET: 'test-only-secret',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const base = `http://127.0.0.1:${parseInt(port, 10) || 3000}`;
  return { child, base, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function waitReady(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not become ready at ${base}`);
}

const servers = [];
function track(server) { servers.push(server); return server; }

async function chat(base, body, extraHeaders = {}) {
  return fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  });
}

// ─── core server (no providers configured) ───────────────────────────────
let core;

before(async () => {
  core = track(startServer());
  await waitReady(core.base);
});

after(() => { for (const s of servers) { try { s.child.kill(); } catch {} } });

test('health check responds ok', async () => {
  const res = await fetch(`${core.base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('index page is served and is the Nexa app', async () => {
  const res = await fetch(`${core.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>Nexa AI/);
  assert.match(html, /id="question"/);
});

test('HEAD / works and returns no body', async () => {
  const res = await fetch(`${core.base}/`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('secrets and source files are NOT served (hardening)', async () => {
  for (const path of ['/.env', '/server.js', '/package.json', '/render.yaml', '/.git/config']) {
    const res = await fetch(`${core.base}${path}`);
    assert.equal(res.status, 404, `${path} must 404`);
  }
});

test('unknown static paths 404', async () => {
  const res = await fetch(`${core.base}/no-such-page.html`);
  assert.equal(res.status, 404);
});

test('api/status reports both providers absent', async () => {
  const res = await fetch(`${core.base}/api/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { providers: { groq: false, gemini: false } });
});

test('chat without any provider key returns 503, not a crash', async () => {
  const res = await chat(core.base, { message: 'hello' });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.ok(body.error, 'error message present');
});

test('chat rejects empty and oversized messages', async () => {
  assert.equal((await chat(core.base, { message: '   ' })).status, 400);
  assert.equal((await chat(core.base, { message: 'x'.repeat(20001) })).status, 400);
  assert.equal((await chat(core.base, {})).status, 400);
});

test('chat rejects invalid JSON body', async () => {
  const res = await fetch(`${core.base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(res.status, 400);
});

test('attachments: unsupported mime type is rejected', async () => {
  const res = await chat(core.base, { message: 'look', attachments: [{ mimeType: 'application/zip', data: 'AAAA' }] });
  assert.equal(res.status, 400);
});

test('auth-gated API returns 401 when signed out in production mode', async () => {
  // NODE_ENV=production turns auth on even without GOOGLE_CLIENT_ID
  const authServer = track(startServer({ NODE_ENV: 'production' }, '4313'));
  try {
    await waitReady(authServer.base);
    const res = await fetch(`${authServer.base}/api/status`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /Login with Google/);
  } finally {
    authServer.child.kill();
  }
});

test('google sign-in endpoint validates input', async () => {
  const authServer = track(startServer({ GOOGLE_CLIENT_ID: 'test-client-id' }, '4314'));
  try {
    await waitReady(authServer.base);
    const noBody = await fetch(`${authServer.base}/api/auth/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noBody.status, 400);
    const me = await fetch(`${authServer.base}/api/auth/me`);
    assert.equal(me.status, 200);
    assert.deepEqual((await me.json()), { authenticated: false, user: null });
  } finally {
    authServer.child.kill();
  }
});

test('per-account chat rate limit kicks in at 20/minute', async () => {
  const rl = track(startServer({}, '4315'));
  try {
    await waitReady(rl.base);
    const statuses = [];
    for (let i = 0; i < 21; i++) {
      const res = await chat(rl.base, { message: `msg ${i}` });
      statuses.push(res);
    }
    assert.ok(statuses.slice(0, 20).every(r => r.status === 503), 'first 20 requests pass the limiter (503 = no providers, not 429)');
    assert.equal(statuses[20].status, 429, '21st request is rate limited');
    assert.ok(statuses[20].headers.get('retry-after'), 'Retry-After header present');
  } finally {
    rl.child.kill();
  }
});

test('PORT fallback: invalid PORT value still serves on 3000 (regression test)', async t => {
  // Skip when something already listens on 3000 (e.g. the user's dev server)
  let busy = false;
  try { await fetch('http://127.0.0.1:3000/healthz', { signal: AbortSignal.timeout(500) }); busy = true; } catch {}
  if (busy) return t.skip('port 3000 already in use on this machine');
  const fallback = track(startServer({ PORT: 'abc' }, 'abc'));
  await waitReady('http://127.0.0.1:3000', 15000);
  assert.match(fallback.stdout, /http:\/\/localhost:3000/, 'server announces port 3000');
  const res = await fetch('http://127.0.0.1:3000/healthz');
  assert.equal(res.status, 200);
});
