// PayPal is no longer used (Shieldly now uses Stripe). This file only exists to replace the old one.
export default async () => new Response('Gone', { status: 410 });
export const config = { path: '/webhooks/paypal' };
