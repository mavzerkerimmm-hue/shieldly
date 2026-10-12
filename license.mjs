// Shieldly — self-contained Netlify Function
import crypto from 'node:crypto';
// Shieldly on Netlify — Stripe subscriptions (server-side only).
// The Stripe secret key is read ONLY from Netlify environment variables and never reaches the browser.

const SECRET = (process.env.STRIPE_SECRET_KEY || '').trim();
const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
const ENV = SECRET.startsWith('sk_live_') || SECRET.startsWith('rk_live_') ? 'live' : 'sandbox';
const BASE = (process.env.STRIPE_API_BASE && process.env.SHIELDLY_TEST === '1') ? process.env.STRIPE_API_BASE : 'https://api.stripe.com';
const PRICE = '4.99', CURRENCY = 'EUR';
const AMOUNT = 499, LOOKUP = 'shieldly_monthly_eur_499';
const GRACE_MS = 1 * 86400000;
const configured = () => /^(sk|rk)_(test|live)_/.test(SECRET);

// ---------- storage (Netlify Blobs; in-memory for tests) ----------
// NOTE: Netlify gives every request a fresh, short-lived access token for Blobs,
// so the store is created again on every call (never cached between requests).
let testStore = null;
function setTestStore(s) { testStore = s; }
let blobsModule = null;
async function store() {
  if (testStore || globalThis.__SHIELDLY_TEST_STORE) return testStore || globalThis.__SHIELDLY_TEST_STORE;
  if (!blobsModule) blobsModule = await import('@netlify/blobs');
  const s = blobsModule.getStore({ name: 'shieldly-billing', consistency: 'strong' });
  return { get: (k) => s.get(k, { type: 'json' }), set: (k, v) => s.setJSON(k, v) };
}
const sget = async (k) => (await store()).get(k);
const sset = async (k, v) => (await store()).set(k, v);

// ---------- Stripe REST ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`)));
    else if (typeof v === 'object') form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}
async function api(method, path, params, headers = {}) {
  if (!configured()) throw new HttpError(503, 'Payments are not configured yet.');
  const body = params && method !== 'GET' ? form(params).join('&') : undefined;
  const url = BASE + path + (params && method === 'GET' ? '?' + form(params).join('&') : '');
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20', ...headers }, body, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new HttpError(res.status === 404 ? 404 : 502, res.status === 401 ? 'Stripe rejected the secret key. Check STRIPE_SECRET_KEY in Netlify.' : 'Stripe returned an error. Please try again.'); e.stripe = data; console.error('[stripe]', method, path, res.status, data.error && data.error.message); throw e; }
  return data;
}
// Returns the id of the "Shieldly — €4.99 / month" price, creating product + price if they don't exist yet.
async function ensurePlan() {
  const envPrice = (process.env.STRIPE_PRICE_ID || '').trim();
  const ok = (p) => p && p.active && p.currency === 'eur' && p.unit_amount === AMOUNT && p.recurring && p.recurring.interval === 'month' && p.recurring.interval_count === 1;
  const cfg = (await sget(`stripe-config/${ENV}`)) || {};
  for (const id of [envPrice, cfg.priceId].filter(Boolean)) {
    try { const p = await api('GET', `/v1/prices/${encodeURIComponent(id)}`); if (ok(p)) { if (id !== cfg.priceId) await sset(`stripe-config/${ENV}`, { priceId: id }); return id; } } catch { /* fall through */ }
  }
  const list = await api('GET', '/v1/prices', { lookup_keys: [LOOKUP], active: 'true', limit: 3 });
  const found = (list.data || []).find(ok);
  if (found) { await sset(`stripe-config/${ENV}`, { priceId: found.id }); return found.id; }
  const prod = await api('POST', '/v1/products', { name: 'Shieldly', description: 'Website monitoring — 24/7 uptime checks, email alerts and security scans' }, { 'Idempotency-Key': `shieldly-product-${ENV}-v1` });
  const price = await api('POST', '/v1/prices', { product: prod.id, unit_amount: AMOUNT, currency: 'eur', recurring: { interval: 'month' }, lookup_key: LOOKUP, nickname: 'Shieldly monthly' }, { 'Idempotency-Key': `shieldly-price-${ENV}-${prod.id}-v1` });
  await sset(`stripe-config/${ENV}`, { priceId: price.id });
  return price.id;
}

// ---------- licenses ----------
const keyHash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
const validKey = (k) => typeof k === 'string' && /^SHL-[A-Za-z0-9_-]{43}$/.test(k);
const validSub = (s) => typeof s === 'string' && /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(s);
const periodEnd = (sub) => sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end) || null;

// Pro is ONLY granted from what this function fetched itself from Stripe.
async function syncLicense(id) {
  if (!validSub(id)) return { ok: false, reason: 'legacy' }; // old PayPal subscription ids (I-…) are ignored
  const row = await sget(`sub/${id}`);
  if (!row) return { ok: false, reason: 'unknown_subscription' };
  let subId = row.stripeSub;
  if (!subId) {
    const cs = await api('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`);
    if (cs.client_reference_id !== 'lic:' + row.keyHash) return { ok: false, reason: 'wrong_license' };
    if (cs.status === 'expired') { const upd = { ...row, status: 'EXPIRED', lastSyncedAt: new Date().toISOString() }; await sset(`sub/${id}`, upd); return { ok: true, row: upd }; }
    if (!cs.subscription) { const upd = { ...row, lastSyncedAt: new Date().toISOString() }; await sset(`sub/${id}`, upd); return { ok: true, row: upd }; }
    subId = typeof cs.subscription === 'string' ? cs.subscription : cs.subscription.id;
    await sset(`stripe-sub/${subId}`, { id });
  }
  const sub = await api('GET', `/v1/subscriptions/${encodeURIComponent(subId)}`);
  const priceId = await ensurePlan();
  const item = sub.items && sub.items.data && sub.items.data[0];
  if (!item || !item.price || item.price.id !== priceId || item.price.id !== row.planId) return { ok: false, reason: 'wrong_plan' };
  if ((sub.metadata || {}).lic !== row.keyHash) return { ok: false, reason: 'wrong_license' };
  const end = periodEnd(sub) ? periodEnd(sub) * 1000 : null;
  let status, proUntil = row.proUntil ? Date.parse(row.proUntil) : 0;
  if ((sub.status === 'active' || sub.status === 'trialing') && !sub.cancel_at_period_end) { status = 'ACTIVE'; if (end && end + GRACE_MS > proUntil) proUntil = end + GRACE_MS; }
  else if (sub.status === 'active' || sub.status === 'trialing') { status = 'CANCELLED'; if (end) proUntil = end; } // cancelled, but paid until the end of the period
  else if (sub.status === 'canceled') { status = 'CANCELLED'; proUntil = Math.min(proUntil || 0, (sub.ended_at || sub.canceled_at || Date.now() / 1000) * 1000); }
  else if (sub.status === 'past_due' || sub.status === 'unpaid') { status = 'SUSPENDED'; proUntil = Date.now(); }
  else if (sub.status === 'incomplete') { status = 'APPROVAL_PENDING'; }
  else { status = 'EXPIRED'; proUntil = Math.min(proUntil || 0, Date.now()); }
  const upd = { ...row, stripeSub: subId, status, nextBillingTime: status === 'ACTIVE' && end ? new Date(end).toISOString() : null, proUntil: proUntil ? new Date(proUntil).toISOString() : null, lastSyncedAt: new Date().toISOString() };
  await sset(`sub/${id}`, upd);
  return { ok: true, row: upd };
}
const rank = (r) => (r.status === 'APPROVAL_PENDING' || r.status === 'EXPIRED' && !r.stripeSub ? 0 : 1);
async function licenseState(key, { refresh = false, subscriptionId = null } = {}) {
  const h = keyHash(key);
  const ids = (await sget(`key/${h}`)) || [];
  if (subscriptionId && validSub(subscriptionId) && ids.includes(subscriptionId)) {
    const r = await sget(`sub/${subscriptionId}`);
    if (r && r.status === 'APPROVAL_PENDING') { try { await syncLicense(subscriptionId); } catch (e) { console.error('[license] sync', e.message); } }
  }
  const rows = (await Promise.all(ids.filter(validSub).map((id) => sget(`sub/${id}`)))).filter(Boolean);
  if (!rows.length) return { found: false, isPro: false, status: null };
  rows.sort((a, b) => rank(b) - rank(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  let lic = rows[0];
  if (configured() && (refresh || !lic.lastSyncedAt || Date.now() - Date.parse(lic.lastSyncedAt) > 2 * 60000)) {
    try { const r = await syncLicense(lic.id); if (r.ok) lic = r.row; } catch (e) { console.error('[license] sync', e.message); }
  }
  const isPro = !!(lic.proUntil && Date.parse(lic.proUntil) > Date.now());
  return { found: true, subscriptionId: lic.id, status: lic.status, isPro, proUntil: lic.proUntil, nextBillingTime: lic.nextBillingTime, checkedAt: new Date().toISOString(), env: ENV };
}
async function subscribe(key, origin) {
  if (!configured()) throw new HttpError(503, 'Payments are not configured yet.');
  if (key != null && !validKey(key)) throw new HttpError(400, 'Invalid license key.');
  if (key) { const cur = await licenseState(key, { refresh: true }); if (cur.isPro && cur.status === 'ACTIVE') throw new HttpError(409, 'This license already has an active subscription.'); }
  else key = 'SHL-' + crypto.randomBytes(32).toString('base64url');
  const priceId = await ensurePlan();
  const h = keyHash(key);
  const cs = await api('POST', '/v1/checkout/sessions', {
    mode: 'subscription', line_items: [{ price: priceId, quantity: 1 }], client_reference_id: 'lic:' + h,
    subscription_data: { metadata: { lic: h } }, metadata: { lic: h }, allow_promotion_codes: 'true', billing_address_collection: 'auto',
    success_url: `${origin}/license/return?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${origin}/license/return?cancelled=1`,
  }, { 'Idempotency-Key': `shieldly-cs-${crypto.randomUUID()}` });
  if (!cs || !validSub(cs.id) || !cs.url) throw new HttpError(502, 'Stripe did not create the checkout. Please try again.');
  await sset(`sub/${cs.id}`, { id: cs.id, keyHash: h, planId: priceId, status: 'APPROVAL_PENDING', createdAt: new Date().toISOString() });
  const ids = ((await sget(`key/${h}`)) || []).filter(validSub); ids.push(cs.id); await sset(`key/${h}`, ids.slice(-20));
  return { licenseKey: key, subscriptionId: cs.id, approveUrl: cs.url, env: ENV };
}
// Cancel any time: no more payments; access stays until the end of the period already paid for.
async function cancel(key) {
  const ids = ((await sget(`key/${keyHash(key)}`)) || []).filter(validSub);
  const rows = (await Promise.all(ids.map((id) => sget(`sub/${id}`)))).filter((r) => r && r.stripeSub && ['ACTIVE', 'SUSPENDED'].includes(r.status));
  if (!rows.length) throw new HttpError(400, 'There is no active subscription for this license.');
  for (const r of rows) {
    if (r.status === 'SUSPENDED') await api('DELETE', `/v1/subscriptions/${encodeURIComponent(r.stripeSub)}`);
    else await api('POST', `/v1/subscriptions/${encodeURIComponent(r.stripeSub)}`, { cancel_at_period_end: 'true' });
    await syncLicense(r.id);
  }
  return licenseState(key);
}

// ---------- Stripe webhooks (optional — the app also syncs on its own) ----------
function verifyStripeSig(raw, header) {
  if (!WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = header.split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const t = Number(parts.t); if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
async function handleWebhook(headers, raw) {
  if (!WEBHOOK_SECRET) return { status: 200, body: { ok: true, ignored: 'STRIPE_WEBHOOK_SECRET not set' } };
  if (!verifyStripeSig(raw, headers.get('stripe-signature'))) return { status: 400, body: { error: 'invalid signature' } };
  let event; try { event = JSON.parse(raw); } catch { return { status: 400, body: { error: 'bad json' } }; }
  if (event.id && await sget(`wh/${event.id}`)) return { status: 200, body: { ok: true, duplicate: true } };
  const o = (event.data && event.data.object) || {};
  let csId = null;
  if (o.object === 'checkout.session') csId = o.id;
  else { const subId = o.object === 'subscription' ? o.id : (o.subscription || null); if (subId) { const m = await sget(`stripe-sub/${subId}`); csId = m && m.id; } }
  if (csId && validSub(csId) && await sget(`sub/${csId}`)) { const out = await syncLicense(csId); if (!out.ok) console.warn('[webhook]', event.type, csId, out.reason); }
  if (event.id) await sset(`wh/${event.id}`, { type: event.type, at: new Date().toISOString() });
  return { status: 200, body: { ok: true } };
}

// ======================= 24/7 monitoring (runs on Netlify, also when nobody has Shieldly open) =======================
const MAX_SITES = 5, KEEP_RESULTS = 400; // max 5 websites per subscription
const hostOk = (h) => /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) && !/(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(h);
function cleanDomain(d) { const h = String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, ''); return hostOk(h) ? h : null; }
function cleanApi(u) {
  if (!u) return null;
  try { const x = new URL(String(u)); if (!/^https?:$/.test(x.protocol) || x.username || x.password || (x.port && !['80', '443', '8080', '8443'].includes(x.port)) || !hostOk(x.hostname)) return null; const s = x.toString(); return s.length <= 300 ? s : null; } catch { return null; }
}
async function proByHash(h) {
  const ids = ((await sget(`key/${h}`)) || []).filter(validSub);
  const rows = (await Promise.all(ids.map((id) => sget(`sub/${id}`)))).filter(Boolean);
  // renewals: re-check with Stripe shortly before the paid period ends (also when the customer never opens Shieldly)
  for (const r of rows) {
    if (configured() && r.stripeSub && r.status === 'ACTIVE' && (!r.proUntil || Date.parse(r.proUntil) < Date.now() + 12 * 3600000)
        && (!r.lastSyncedAt || Date.now() - Date.parse(r.lastSyncedAt) > 3600000)) {
      try { const o = await syncLicense(r.id); if (o.ok) Object.assign(r, o.row); } catch (e) { console.error('[monitor] renewal check', e.message); }
    }
  }
  return rows.some((r) => r.proUntil && Date.parse(r.proUntil) > Date.now());
}
// The HTML app sends the customer's websites here (only while the subscription is active).
async function saveSites(key, body) {
  const st = await licenseState(key);
  if (!st.isPro) throw new HttpError(402, 'An active Shieldly subscription is required.');
  const h = keyHash(key);
  const prev = (await sget(`mon/${h}`)) || { sites: {} };
  const email = typeof body.email === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(body.email) ? body.email.trim().slice(0, 254) : prev.email || null;
  const sites = {};
  for (const s of (Array.isArray(body.sites) ? body.sites : []).slice(0, MAX_SITES)) {
    const id = String(s && s.id || '').slice(0, 40); const domain = cleanDomain(s && s.domain);
    if (!/^[a-z0-9]{6,40}$/i.test(id) || !domain) continue;
    const old = prev.sites[id] || {};
    sites[id] = { ...old, domain, apiUrl: cleanApi(s.apiUrl), active: !!s.active, intervalMin: [10, 15, 30, 60].includes(Number(s.intervalMin)) ? Number(s.intervalMin) : 10, results: old.domain === domain ? (old.results || []) : [] };
  }
  await sset(`mon/${h}`, { email, alerts: body.alerts !== false, sites, updatedAt: new Date().toISOString() });
  const index = (await sget('mon-index')) || [];
  if (!index.includes(h)) { index.push(h); await sset('mon-index', index); }
  return { ok: true, monitored: Object.values(sites).filter((x) => x.active).length };
}
// The HTML app fetches the results of the server checks to show them in the dashboard.
async function getResults(key, since) {
  const rec = await sget(`mon/${keyHash(key)}`);
  if (!rec) return { sites: {}, serverTime: new Date().toISOString() };
  const t = Date.parse(since || 0) || 0; const out = {};
  for (const [id, s] of Object.entries(rec.sites)) out[id] = { health: s.health || 'unknown', apiHealth: s.apiHealth || 'unknown', lastCheckedAt: s.lastCheckedAt || null, results: (s.results || []).filter((r) => Date.parse(r.ts) > t) };
  return { sites: out, serverTime: new Date().toISOString() };
}
async function probe(url) {
  if (process.env.SHIELDLY_TEST === '1' && globalThis.__SHIELDLY_PROBE) return globalThis.__SHIELDLY_PROBE(url);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'ShieldlyMonitor/1.0 (+uptime check)' }, signal: AbortSignal.timeout(10000) });
    try { await res.body?.cancel(); } catch {}
    const ms = Date.now() - t0;
    if (res.status >= 500) return { ok: false, ms, code: res.status, error: `Server error (HTTP ${res.status})` };
    return { ok: true, ms, code: res.status };
  } catch (e) { return { ok: false, ms: Date.now() - t0, code: null, error: e && e.name === 'TimeoutError' ? 'No response within 10s' : 'Could not connect (server offline, connection refused or SSL error)' }; }
}
async function sendMail(to, subject, text) {
  if (process.env.SHIELDLY_TEST === '1' && globalThis.__SHIELDLY_MAIL) return globalThis.__SHIELDLY_MAIL(to, subject, text);
  const key = (process.env.RESEND_API_KEY || '').trim(), from = (process.env.EMAIL_FROM || '').trim();
  if (!key || !from || !to) { console.log('[mail] (not sent — RESEND_API_KEY/EMAIL_FROM not set)', to, subject); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, text }), signal: AbortSignal.timeout(10000) });
    if (!r.ok) console.error('[mail] failed', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) { console.error('[mail] error', e.message); return false; }
}
function step(site, target, r, mails, email, alerts) {
  const hk = target === 'api' ? 'apiHealth' : 'health', fk = target === 'api' ? 'apiFailCount' : 'failCount';
  const name = target === 'api' ? site.apiUrl : site.domain, label = target === 'api' ? 'API' : 'Website';
  if (r.ok) {
    if (site[hk] === 'down' && alerts && email) mails.push([email, `✅ ${name} is back online`, `Good news: your ${label.toLowerCase()} ${name} is reachable again (responded in ${r.ms} ms).\n\n— Shieldly`]);
    site[hk] = 'up'; site[fk] = 0;
  } else {
    site[fk] = (site[fk] || 0) + 1;
    if (site[fk] >= 2 && site[hk] !== 'down') {
      site[hk] = 'down';
      if (alerts && email) mails.push([email, `🔴 ${name} is down`, `Shieldly could not reach your ${label.toLowerCase()} ${name} (two checks in a row).\n\nReason: ${r.error}\nTime: ${new Date().toUTCString()}\n\nYou will get another email as soon as it is back online.\n\n— Shieldly`]);
    }
  }
}
// Called every minute by the scheduled function.
async function runMonitor({ deadlineMs = 24000 } = {}) {
  const started = Date.now();
  const index = (await sget('mon-index')) || [];
  const jobs = [];
  const recs = {};
  for (const h of index) {
    const rec = await sget(`mon/${h}`); if (!rec) continue;
    if (!(await proByHash(h))) continue; // subscription not active -> no checks
    recs[h] = rec;
    for (const [id, s] of Object.entries(rec.sites).slice(0, MAX_SITES)) {
      if (!s.active) continue;
      const due = !s.lastCheckedAt || Date.now() - Date.parse(s.lastCheckedAt) >= Math.max(10, s.intervalMin || 10) * 60000 - 60000;
      if (due) jobs.push({ h, id });
    }
  }
  const mails = []; let done = 0;
  const worker = async () => {
    while (jobs.length && Date.now() - started < deadlineMs) {
      const { h, id } = jobs.shift(); const rec = recs[h]; const s = rec.sites[id];
      const ts = new Date().toISOString();
      let rs = await probe(`https://${s.domain}/`);
      if (!rs.ok) { const r2 = await probe(`http://${s.domain}/`); if (r2.ok) rs = r2; }
      const ra = s.apiUrl ? await probe(s.apiUrl) : null;
      s.results = s.results || [];
      s.results.push({ ts, target: 'site', ok: rs.ok, ms: rs.ms, code: rs.code, error: rs.error || null });
      step(s, 'site', rs, mails, rec.email, rec.alerts);
      if (ra) { s.results.push({ ts, target: 'api', ok: ra.ok, ms: ra.ms, code: ra.code, error: ra.error || null }); step(s, 'api', ra, mails, rec.email, rec.alerts); }
      if (s.results.length > KEEP_RESULTS) s.results.splice(0, s.results.length - KEEP_RESULTS);
      s.lastCheckedAt = ts; rec._dirty = true; done++;
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  for (const [h, rec] of Object.entries(recs)) {
    if (!rec._dirty) continue; delete rec._dirty;
    // merge with the latest copy so a site list saved during this run is not lost
    const cur = (await sget(`mon/${h}`)) || rec;
    for (const [id, s] of Object.entries(rec.sites)) if (cur.sites[id] && cur.sites[id].domain === s.domain) cur.sites[id] = { ...cur.sites[id], results: s.results, health: s.health, apiHealth: s.apiHealth, failCount: s.failCount, apiFailCount: s.apiFailCount, lastCheckedAt: s.lastCheckedAt };
    await sset(`mon/${h}`, cur);
  }
  for (const m of mails) await sendMail(...m);
  return { checked: done, left: jobs.length, mails: mails.length };
}

// ===================== function =====================

// No cookies are used, so allowing any origin (also file://) is safe.
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const page = (ok) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shieldly</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f8fafc;color:#0a0a0a;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}.c{background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:32px;max-width:440px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.06)}h1{font-size:22px;margin:12px 0 8px}p{color:#52525b;line-height:1.5}.i{width:52px;height:52px;border-radius:50%;display:grid;place-items:center;margin:0 auto;background:#e8efff;color:#2563ff;font-size:26px}a{color:#2563ff;font-weight:600}</style></head><body><div class="c"><div class="i">${ok ? '&#10003;' : '&times;'}</div><h1>${ok ? 'Thank you! You can close this tab.' : 'Checkout cancelled'}</h1><p>${ok ? 'Go back to Shieldly. It checks your payment automatically and unlocks your account in a few seconds.' : 'No payment was made. You can close this tab and go back to Shieldly.'}</p><p><a href="/#/app/plan">Back to Shieldly</a></p></div></body></html>`;

export default async (req) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/license\/?/, '').replace(/\/$/, '');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    if (route === 'config' && req.method === 'GET') return json(200, { enabled: configured(), env: ENV, price: PRICE, currency: CURRENCY });
    if (route === 'return' && req.method === 'GET') {
      const id = url.searchParams.get('session_id') || '';
      if (validSub(id)) { try { await syncLicense(id); } catch (e) { console.error('[license] return sync', e.message); } }
      return new Response(page(!url.searchParams.get('cancelled')), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (req.method !== 'POST') return json(404, { error: 'Not found.' });
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    if (!body || typeof body !== 'object') body = {};
    if (route === 'subscribe') return json(200, await subscribe(body.licenseKey ?? null, url.origin));
    if (!validKey(body.licenseKey)) return json(400, { error: 'Invalid license key.' });
    if (route === 'status') return json(200, await licenseState(body.licenseKey, { refresh: !!body.refresh, subscriptionId: typeof body.subscriptionId === 'string' ? body.subscriptionId : null }));
    if (route === 'cancel') return json(200, await cancel(body.licenseKey));
    if (route === 'sites') return json(200, await saveSites(body.licenseKey, body));
    if (route === 'monitor') return json(200, await getResults(body.licenseKey, typeof body.since === 'string' ? body.since : null));
    return json(404, { error: 'Not found.' });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error('[license] error', e);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
};
export const config = { path: ['/license/*'] };
