const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const root = __dirname;
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}
const port = Number(process.env.PORT || 3000);
const authEnabled = process.env.NODE_ENV === 'production' || Boolean(process.env.GOOGLE_CLIENT_ID);
const ownerEmail = (process.env.OWNER_EMAIL || 'sourabh73003@gmail.com').toLowerCase();
const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const googleClient = new OAuth2Client(googleClientId || undefined);
const sessionCookie = 'nexa_session';
const sessionSeconds = 60 * 60 * 24 * 7;
const chatUsage = new Map();
const guidance = {
  'AI Chat': 'Be a helpful, clear general assistant. Match the user’s language.',
  Coding: 'Act as a patient programming assistant. Give correct code and explain important choices.',
  Study: 'Act as a supportive tutor. Explain concepts step by step.',
  Writing: 'Help draft and improve writing. Keep the requested voice and purpose.',
  Business: 'Give practical business planning help. Separate assumptions from facts.',
  Voice: 'Keep replies conversational, concise, and easy to say aloud.'
};
const modeGuidance = {
  quick: 'Answer directly and concisely. Give the useful answer first.',
  deep: 'Think carefully through the problem, check edge cases, and explain your reasoning in clear structured steps. Do not reveal hidden chain of thought; provide a concise rationale and conclusions.'
};
function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 10000000) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function normalizeAttachments(value, limit = 2) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).filter(file => {
    if (!['application/pdf','image/png','image/jpeg','image/webp'].includes(file?.mimeType) || typeof file.data !== 'string' || !file.data.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) || file.data.length > 4200000) return false;
    return Buffer.from(file.data, 'base64').byteLength <= 3 * 1024 * 1024;
  }).map(file => ({ mimeType: file.mimeType, data: file.data }));
}
function chatLimit(req) {
  const user = getSession(req);
  const key = user?.sub || req.socket.remoteAddress || 'guest';
  const now = Date.now();
  const entry = chatUsage.get(key) || { minute: now, minuteCount: 0, day: now, dayCount: 0 };
  if (now - entry.minute >= 60_000) { entry.minute = now; entry.minuteCount = 0; }
  if (now - entry.day >= 86_400_000) { entry.day = now; entry.dayCount = 0; }
  if (entry.minuteCount >= 20) return { retryAfter: Math.ceil((60_000 - (now - entry.minute)) / 1000), message: 'Chat limit reached for this minute. Try again shortly.' };
  if (entry.dayCount >= 200) return { retryAfter: Math.ceil((86_400_000 - (now - entry.day)) / 1000), message: 'Daily chat limit reached for this account. Try again tomorrow.' };
  entry.minuteCount++; entry.dayCount++; chatUsage.set(key, entry);
  if (chatUsage.size > 10000) for (const [id, value] of chatUsage) if (now - value.day > 86_400_000) chatUsage.delete(id);
  return null;
}
function signSession(user) {
  const payload = Buffer.from(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + sessionSeconds })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function getSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean).map(part => { const at = part.indexOf('='); return at < 0 ? [part, ''] : [part.slice(0, at), decodeURIComponent(part.slice(at + 1))]; }));
  const token = cookies[sessionCookie];
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!user.exp || user.exp < Math.floor(Date.now() / 1000)) return null;
    return user;
  } catch { return null; }
}
function cookie(value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${sessionCookie}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
function originAllowed(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
async function askGroq(key, model, section, mode, history, message, webSearch) {
  const searchInstruction = webSearch ? 'Use browser search for current facts. Add markdown links to the original sources for important claims.' : '';
  const messages = [{ role: 'system', content: `${guidance[section]} ${modeGuidance[mode]} ${searchInstruction}` }, ...history, { role: 'user', content: message }];
  const payload = { model, messages, temperature: 0.7 };
  if (webSearch) { payload.tools = [{ type: 'browser_search' }]; payload.tool_choice = 'required'; }
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  const answer = data.choices?.[0]?.message?.content?.trim();
  const citations = (data.choices?.[0]?.message?.executed_tools || []).flatMap(tool => tool.search_results || []).map(item => ({ title: item.title || item.url, url: item.url })).filter(item => /^https?:\/\//.test(item.url || ''));
  return { ok: response.ok && Boolean(answer), answer, citations, error: data.error?.message || 'Groq se jawab nahi mila.' };
}
async function askGemini(key, model, section, mode, history, message, webSearch, attachments) {
  const contents = [...history.map(item => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [...(item.attachments || []).map(file => ({ inline_data: { mime_type: file.mimeType, data: file.data } })), { text: item.content }] })), { role: 'user', parts: [...attachments.map(file => ({ inline_data: { mime_type: file.mimeType, data: file.data } })), { text: message }] }];
  const payload = { systemInstruction: { parts: [{ text: `${guidance[section]} ${modeGuidance[mode]}` }] }, contents };
  if (webSearch) payload.tools = [{ google_search: {} }];
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  const answer = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n').trim();
  const citations = (data.candidates?.[0]?.groundingMetadata?.groundingChunks || []).map(chunk => chunk.web).filter(web => web?.uri).map(web => ({ title: web.title || web.uri, url: web.uri }));
  return { ok: response.ok && Boolean(answer), answer, citations, error: data.error?.message || 'Gemini se jawab nahi mila.' };
}
async function streamGroq(key, model, section, mode, history, message, onDelta, signal) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'system', content: `${guidance[section]} ${modeGuidance[mode]}` }, ...history, { role: 'user', content: message }], temperature: 0.7, stream: true }), signal });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error?.message || 'Groq se jawab nahi mila.'); }
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || ''; for (const event of events) { const line = event.split(/\r?\n/).find(part => part.startsWith('data:')); if (!line) continue; const raw = line.slice(5).trim(); if (raw === '[DONE]') continue; try { const chunk = JSON.parse(raw); const delta = chunk.choices?.[0]?.delta?.content; if (delta) onDelta(delta); } catch {} } }
}
async function streamGemini(key, model, section, mode, history, message, attachments, onDelta, signal) {
  const contents = [...history.map(item => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [...(item.attachments || []).map(file => ({ inline_data: { mime_type: file.mimeType, data: file.data } })), { text: item.content }] })), { role: 'user', parts: [...attachments.map(file => ({ inline_data: { mime_type: file.mimeType, data: file.data } })), { text: message }] }];
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: `${guidance[section]} ${modeGuidance[mode]}` }] }, contents }), signal });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error?.message || 'Gemini se jawab nahi mila.'); }
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || ''; for (const event of events) { const line = event.split(/\r?\n/).find(part => part.startsWith('data:')); if (!line) continue; try { const chunk = JSON.parse(line.slice(5).trim()); for (const part of chunk.candidates?.[0]?.content?.parts || []) if (part.text) onDelta(part.text); } catch {} } }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { authEnabled, googleClientId: authEnabled ? googleClientId : '' });
  if (req.method === 'POST' && url.pathname === '/api/auth/google') {
    if (!originAllowed(req)) return json(res, 403, { error: 'Sign-in request origin check failed.' });
    if (!googleClientId) return json(res, 503, { error: 'Google sign-in setup is incomplete. Add GOOGLE_CLIENT_ID.' });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'Sign-in request format is invalid.' }); }
    if (typeof body.credential !== 'string' || body.credential.length > 10000) return json(res, 400, { error: 'Google credential is missing.' });
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: body.credential, audience: googleClientId });
      const profile = ticket.getPayload();
      if (!profile?.email || profile.email_verified !== true) return json(res, 401, { error: 'Use a verified Google email to sign in.' });
      const user = { sub: profile.sub, email: profile.email.toLowerCase(), name: profile.name || profile.email, picture: profile.picture || '', role: profile.email.toLowerCase() === ownerEmail ? 'owner' : 'user' };
      return json(res, 200, { user: { email: user.email, name: user.name, picture: user.picture, role: user.role } }, { 'Set-Cookie': cookie(signSession(user), sessionSeconds) });
    } catch { return json(res, 401, { error: 'Google sign-in verify nahi hua. Dobara try karo.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = getSession(req);
    return json(res, 200, { authenticated: Boolean(user), user: user ? { email: user.email, name: user.name, picture: user.picture, role: user.role } : null });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    if (!originAllowed(req)) return json(res, 403, { error: 'Sign-out request origin check failed.' });
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }
  if (authEnabled && url.pathname.startsWith('/api/') && !getSession(req)) return json(res, 401, { error: 'Login with Google to use Nexa.' });
  if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { providers: { groq: Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_key_here'), gemini: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_key_here') } });
  if (req.method === 'POST' && ['/api/chat', '/api/chat/stream'].includes(url.pathname)) {
    const streaming = url.pathname.endsWith('/stream');
    const limit = chatLimit(req);
    if (limit) return json(res, 429, { error: limit.message }, { 'Retry-After': String(limit.retryAfter) });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'Message format sahi nahi hai.' }); }
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 20000) return json(res, 400, { error: 'Message likho (maximum 20,000 characters).' });
    const mode = body.mode === 'deep' ? 'deep' : 'quick';
    const webSearch = body.webSearch === true;
    const section = typeof body.section === 'string' && guidance[body.section] ? body.section : 'AI Chat';
    const history = Array.isArray(body.history) ? body.history.slice(-12).filter(x => x && ['user','assistant'].includes(x.role) && typeof x.content === 'string').map(x => ({ role: x.role, content: x.content.slice(0, 8000), attachments: normalizeAttachments(x.attachments, 1) })) : [];
    const attachments = normalizeAttachments(body.attachments, 2);
    if (Array.isArray(body.attachments) && body.attachments.length !== attachments.length) return json(res, 400, { error: 'PDF or PNG, JPG, and WEBP image files are supported (max 3 MB each).' });
    const hasAttachments = attachments.length > 0 || history.some(item => item.attachments.length > 0);
    const providers = [];
    const modelChoices = { 'groq:openai/gpt-oss-20b': ['groq','openai/gpt-oss-20b'], 'gemini:gemini-3.8-flash': ['gemini','gemini-3.8-flash'] };
    const choice = modelChoices[body.model] || null;
    const requestedProvider = choice?.[0] || (['groq','gemini'].includes(body.provider) ? body.provider : 'auto');
    if (requestedProvider === 'groq' && hasAttachments) return json(res, 400, { error: 'PDF and image attachments currently need Gemini. Choose Auto or Gemini.' });
    const providerOrder = requestedProvider === 'gemini' ? ['gemini','groq'] : ['groq','gemini'];
    for (const providerName of providerOrder) {
      if (providerName === 'groq' && !hasAttachments && process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_key_here') {
        const model = choice?.[0] === 'groq' ? choice[1] : process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
        providers.push({ name: 'Groq', model, stream: () => streamGroq(process.env.GROQ_API_KEY, model, section, mode, history, message, delta => writeEvent('delta', { text: delta })), run: () => askGroq(process.env.GROQ_API_KEY, model, section, mode, history, message, webSearch) });
      }
      if (providerName === 'gemini' && process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_key_here') {
        const model = choice?.[0] === 'gemini' ? choice[1] : process.env.GEMINI_MODEL || 'gemini-3.8-flash';
        providers.push({ name: 'Gemini', model, stream: () => streamGemini(process.env.GEMINI_API_KEY, model, section, mode, history, message, attachments, delta => writeEvent('delta', { text: delta })), run: () => askGemini(process.env.GEMINI_API_KEY, model, section, mode, history, message, webSearch, attachments) });
      }
    }
    if (!providers.length) return json(res, 503, { error: 'Groq ya Gemini ki free API key .env file mein add karo.' });
    if (streaming && !webSearch) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const writeEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      for (const provider of providers) {
        let sentText = false;
        const sendDelta = text => { sentText = true; writeEvent('delta', { text }); };
        provider.stream = provider.name === 'Groq'
          ? () => streamGroq(process.env.GROQ_API_KEY, provider.model, section, mode, history, message, sendDelta, controller.signal)
          : () => streamGemini(process.env.GEMINI_API_KEY, provider.model, section, mode, history, message, attachments, sendDelta, controller.signal);
        try { await provider.stream(); writeEvent('done', { provider: provider.name, model: provider.model }); return res.end(); }
        catch (error) { if (sentText || provider === providers.at(-1)) { writeEvent('error', { message: `${provider.name}: ${error.message || 'connection nahi ho paaya.'}` }); return res.end(); } }
      }
      return res.end();
    }
    let lastError = 'AI provider se jawab nahi mila.';
    for (const provider of providers) {
      try { const result = await provider.run(); if (result.ok) return json(res, 200, { answer: result.answer, provider: provider.name, model: provider.model, citations: result.citations || [] }); lastError = `${provider.name}: ${result.error}`; }
      catch { lastError = `${provider.name}: connection nahi ho paaya.`; }
    }
    return json(res, 502, { error: `${lastError} Free quota khatam ho toh kuch der baad try karo.` });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method allowed nahi hai.' });
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(root, requested);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});
server.listen(port, process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1', () => console.log(`Nexa AI is running at http://localhost:${port}`));

