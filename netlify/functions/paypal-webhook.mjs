// Shieldly Pro — self-contained Netlify Function (put this file in the folder netlify/functions/)
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

// ===================== function =====================
// PayPal webhooks — every event is signature-verified with PayPal before it is used.
export default async (req) => {
  if (req.method !== 'POST') return new Response('Not found', { status: 404 });
  let event = {}; try { event = await req.json(); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  try { const r = await handleWebhook(req.headers, event); return Response.json(r.body, { status: r.status }); }
  catch (e) { console.error('[webhook] error', e.message); return Response.json({ error: 'temporary error' }, { status: 500 }); }
};
export const config = { path: '/webhooks/paypal' };
