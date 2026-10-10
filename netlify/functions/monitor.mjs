// Shieldly — self-contained Netlify Function (this file goes in the folder netlify/functions/)
import crypto from 'node:crypto';
// Shieldly Pro on Netlify — PayPal Subscriptions (server-side only).
// The PayPal Client Secret is read ONLY from Netlify environment variables and never reaches the browser.

const ENV = process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';
const BASE = (process.env.PAYPAL_API_BASE && process.env.SHIELDLY_TEST === '1') ? process.env.PAYPAL_API_BASE
  : (ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
const CLIENT_ID = (process.env.PAYPAL_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
const WEBHOOK_ID = (process.env.PAYPAL_WEBHOOK_ID || '').trim();
const PRICE = '4.99', CURRENCY = 'EUR';
const GRACE_MS = 3 * 86400000;
const configured = () => !!(CLIENT_ID && CLIENT_SECRET);

// ---------- storage (Netlify Blobs; in-memory for tests) ----------
let storePromise = null;
function setTestStore(s) { storePromise = Promise.resolve(s); }
async function store() {
  if (!storePromise && globalThis.__SHIELDLY_TEST_STORE) storePromise = Promise.resolve(globalThis.__SHIELDLY_TEST_STORE);
  if (!storePromise) storePromise = import('@netlify/blobs').then(({ getStore }) => {
    const s = getStore({ name: 'shieldly-billing', consistency: 'strong' });
    return { get: (k) => s.get(k, { type: 'json' }), set: (k, v) => s.setJSON(k, v) };
  });
  return storePromise;
}
const sget = async (k) => (await store()).get(k);
const sset = async (k, v) => (await store()).set(k, v);

// ---------- PayPal REST ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
let token = null, tokenExp = 0;
async function accessToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const res = await fetch(`${BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('[paypal] token error', res.status, body.error || ''); throw new HttpError(502, 'Could not connect to PayPal. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.'); }
  token = body.access_token; tokenExp = Date.now() + (body.expires_in || 300) * 1000; return token;
}
async function api(method, path, body, headers = {}) {
  if (!configured()) throw new HttpError(503, 'Payments are not configured yet.');
  const res = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new HttpError(res.status === 404 ? 404 : 502, 'PayPal returned an error. Please try again.'); e.paypal = data; console.error('[paypal]', method, path, res.status, data.name || '', data.debug_id || ''); throw e; }
  return data;
}
function planMatches(p) {
  const c = p && p.billing_cycles && p.billing_cycles.find((x) => x.tenure_type === 'REGULAR');
  const price = c && c.pricing_scheme && c.pricing_scheme.fixed_price;
  return p && p.status === 'ACTIVE' && c && c.frequency.interval_unit === 'MONTH' && Number(c.frequency.interval_count) === 1 && price && price.currency_code === CURRENCY && Number(price.value) === Number(PRICE);
}
// Returns the "Shieldly Pro — €4.99/month" plan id; creates product + plan if they don't exist yet.
async function ensurePlan() {
  const cfg = (await sget(`config/${ENV}`)) || {};
  for (const id of [(process.env.PAYPAL_PLAN_ID || '').trim(), cfg.planId].filter(Boolean)) {
    try { const p = await api('GET', `/v1/billing/plans/${encodeURIComponent(id)}`); if (planMatches(p)) { if (id !== cfg.planId) await sset(`config/${ENV}`, { ...cfg, planId: id }); return id; } } catch (e) { /* fall through */ }
  }
  let productId = cfg.productId;
  if (productId) { try { await api('GET', `/v1/catalogs/products/${encodeURIComponent(productId)}`); } catch { productId = null; } }
  if (!productId) {
    const prod = await api('POST', '/v1/catalogs/products', { name: 'Shieldly Pro', description: 'Shieldly Pro website monitoring subscription', type: 'SERVICE', category: 'SOFTWARE' }, { 'PayPal-Request-Id': `shieldly-product-${ENV}-v1` });
    productId = prod.id; await sset(`config/${ENV}`, { ...cfg, productId });
  }
  const list = await api('GET', `/v1/billing/plans?product_id=${encodeURIComponent(productId)}&page_size=20&total_required=true`);
  for (const s of (list && list.plans) || []) {
    if (s.status !== 'ACTIVE') continue;
    const p = await api('GET', `/v1/billing/plans/${encodeURIComponent(s.id)}`);
    if (planMatches(p)) { await sset(`config/${ENV}`, { productId, planId: p.id }); return p.id; }
  }
  const plan = await api('POST', '/v1/billing/plans', {
    product_id: productId, name: 'Shieldly Pro — monthly', description: `Shieldly Pro, €${PRICE} per month`, status: 'ACTIVE',
    billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: PRICE, currency_code: CURRENCY } } }],
    payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 2 },
  }, { 'PayPal-Request-Id': `shieldly-plan-${ENV}-${productId}-v1`, Prefer: 'return=representation' });
  await sset(`config/${ENV}`, { productId, planId: plan.id });
  return plan.id;
}

// ---------- licenses ----------
const keyHash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
const validKey = (k) => typeof k === 'string' && /^SHL-[A-Za-z0-9_-]{43}$/.test(k);
const validSub = (s) => typeof s === 'string' && /^I-[A-Z0-9]{6,40}$/.test(s);

// Pro is ONLY granted from what this function fetched itself from PayPal.
async function syncLicense(subId) {
  const row = await sget(`sub/${subId}`);
  if (!row) return { ok: false, reason: 'unknown_subscription' };
  const sub = await api('GET', `/v1/billing/subscriptions/${encodeURIComponent(subId)}`);
  const planId = await ensurePlan();
  if (sub.plan_id !== planId || sub.plan_id !== row.planId) return { ok: false, reason: 'wrong_plan' };
  if (String(sub.custom_id) !== 'lic:' + row.keyHash) return { ok: false, reason: 'wrong_license' };
  const status = String(sub.status || '').toUpperCase();
  const next = sub.billing_info && sub.billing_info.next_billing_time ? sub.billing_info.next_billing_time : null;
  let proUntil = row.proUntil ? Date.parse(row.proUntil) : 0;
  if (status === 'ACTIVE') { const until = (next ? Date.parse(next) : Date.now() + 31 * 86400000) + GRACE_MS; if (until > proUntil) proUntil = until; }
  else if (status === 'SUSPENDED' || status === 'EXPIRED') proUntil = Date.now();
  const upd = { ...row, status, nextBillingTime: next, proUntil: proUntil ? new Date(proUntil).toISOString() : null, lastSyncedAt: new Date().toISOString() };
  await sset(`sub/${subId}`, upd);
  return { ok: true, row: upd };
}
const rank = (r) => (r.status === 'APPROVAL_PENDING' ? 0 : 1);
async function licenseState(key, { refresh = false, subscriptionId = null } = {}) {
  const h = keyHash(key);
  const ids = (await sget(`key/${h}`)) || [];
  if (subscriptionId && validSub(subscriptionId) && ids.includes(subscriptionId)) {
    const r = await sget(`sub/${subscriptionId}`);
    if (r && ['APPROVAL_PENDING', 'APPROVED'].includes(r.status)) { try { await syncLicense(subscriptionId); } catch (e) { console.error('[license] sync', e.message); } }
  }
  const rows = (await Promise.all(ids.map((id) => sget(`sub/${id}`)))).filter(Boolean);
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
  if (key) { const cur = await licenseState(key, { refresh: true }); if (cur.isPro && cur.status === 'ACTIVE') throw new HttpError(409, 'This license already has an active Pro subscription.'); }
  else key = 'SHL-' + crypto.randomBytes(32).toString('base64url');
  const planId = await ensurePlan();
  const h = keyHash(key);
  const sub = await api('POST', '/v1/billing/subscriptions', {
    plan_id: planId, custom_id: 'lic:' + h,
    application_context: { brand_name: 'Shieldly', locale: 'en-US', shipping_preference: 'NO_SHIPPING', user_action: 'SUBSCRIBE_NOW', return_url: `${origin}/license/return`, cancel_url: `${origin}/license/return?cancelled=1` },
  }, { 'PayPal-Request-Id': `shieldly-sub-${crypto.randomUUID()}`, Prefer: 'return=representation' });
  const approve = sub && (sub.links || []).find((l) => l.rel === 'approve');
  if (!sub || !validSub(sub.id) || !approve || (sub.plan_id && sub.plan_id !== planId)) throw new HttpError(502, 'PayPal did not create the subscription. Please try again.');
  await sset(`sub/${sub.id}`, { id: sub.id, keyHash: h, planId, status: String(sub.status || 'APPROVAL_PENDING').toUpperCase(), createdAt: new Date().toISOString() });
  const ids = (await sget(`key/${h}`)) || []; ids.push(sub.id); await sset(`key/${h}`, ids.slice(-20));
  return { licenseKey: key, subscriptionId: sub.id, approveUrl: approve.href, env: ENV };
}
async function cancel(key) {
  const ids = (await sget(`key/${keyHash(key)}`)) || [];
  const rows = (await Promise.all(ids.map((id) => sget(`sub/${id}`)))).filter((r) => r && ['ACTIVE', 'APPROVED', 'SUSPENDED'].includes(r.status));
  if (!rows.length) throw new HttpError(400, 'There is no active subscription for this license.');
  for (const r of rows) { await api('POST', `/v1/billing/subscriptions/${encodeURIComponent(r.id)}/cancel`, { reason: 'Cancelled by the customer in Shieldly' }); await syncLicense(r.id); }
  return licenseState(key);
}

// ---------- webhooks ----------
async function handleWebhook(headers, event) {
  if (!WEBHOOK_ID) throw new HttpError(500, 'PAYPAL_WEBHOOK_ID is not set.');
  const h = (n) => headers.get(n);
  const need = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (need.some((n) => !h(n))) return { status: 400, body: { error: 'invalid signature' } };
  const v = await api('POST', '/v1/notifications/verify-webhook-signature', { auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'), transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'), webhook_id: WEBHOOK_ID, webhook_event: event });
  if (!v || v.verification_status !== 'SUCCESS') return { status: 400, body: { error: 'invalid signature' } };
  const evId = String(event.id || '');
  if (evId && await sget(`wh/${evId}`)) return { status: 200, body: { ok: true, duplicate: true } };
  const type = String(event.event_type || ''); const r = event.resource || {};
  const subId = type.startsWith('BILLING.SUBSCRIPTION.') ? r.id : (r.billing_agreement_id || null);
  if (validSub(subId) && await sget(`sub/${subId}`)) {
    const out = await syncLicense(subId); // throws -> 500 -> PayPal retries
    if (!out.ok) console.warn('[webhook]', type, subId, out.reason);
  }
  if (evId) await sset(`wh/${evId}`, { type, at: new Date().toISOString() });
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
  const ids = (await sget(`key/${h}`)) || [];
  const rows = (await Promise.all(ids.map((id) => sget(`sub/${id}`)))).filter(Boolean);
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
    sites[id] = { ...old, domain, apiUrl: cleanApi(s.apiUrl), active: !!s.active, intervalMin: [1, 5, 10, 15, 30, 60].includes(Number(s.intervalMin)) ? Number(s.intervalMin) : 5, results: old.domain === domain ? (old.results || []) : [] };
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
      const due = !s.lastCheckedAt || Date.now() - Date.parse(s.lastCheckedAt) >= (s.intervalMin || 5) * 60000 - 20000;
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
// Runs every minute on Netlify — checks all customer websites, also when nobody has Shieldly open.
export default async () => {
  try { const r = await runMonitor(); console.log('[monitor]', JSON.stringify(r)); }
  catch (e) { console.error('[monitor] error', e); }
  return new Response('ok');
};
export const config = { schedule: '* * * * *' };
