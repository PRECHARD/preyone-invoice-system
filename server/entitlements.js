/**
 * Invoice entitlement. Keep this catalogue in lockstep with
 * preyone-ruijie-captive-portal/src/plans/entitlements.ts.
 *
 * companies.plan_type is the only rule:
 *   PreTill      standard_10      POS only
 *   PreBiz       pos_invoice_15   POS + Invoice, 3 devices
 *   PrePro       growth_20        POS + Invoice, 6 devices
 *   PreUnlimited unlimited_30     POS + Invoice, unlimited devices
 */
import { pool } from './store.js';

export const PLAN_CATALOG = [
  { id: 'standard_10', name: 'PreTill', price: 10, devices: 1, modules: ['pos'], tagline: 'POS only. One registered device.' },
  { id: 'pos_invoice_15', name: 'PreBiz', price: 15, devices: 3, modules: ['pos', 'invoice'], tagline: 'POS and Invoice. Up to 3 devices.' },
  { id: 'growth_20', name: 'PrePro', price: 20, devices: 6, modules: ['pos', 'invoice'], tagline: 'POS and Invoice. Up to 6 devices.' },
  { id: 'unlimited_30', name: 'PreUnlimited', price: 30, devices: 9999, modules: ['pos', 'invoice'], tagline: 'POS and Invoice. Unlimited devices.' },
];

export function modulesForPlan(planType) {
  const tier = PLAN_CATALOG.find((t) => t.id === planType);
  return tier ? tier.modules.slice() : [];
}

export function describeEntitlement(row) {
  const planType = row?.plan_type ?? null;
  const tier = PLAN_CATALOG.find((t) => t.id === planType) || null;
  const modules = tier ? tier.modules.slice() : [];
  const status = row?.subscription_status || (row ? 'active' : 'none');
  const expires = row?.subscription_expires_at ? new Date(row.subscription_expires_at) : null;
  const expired = (!!expires && !Number.isNaN(expires.getTime()) && expires.getTime() <= Date.now()) || status === 'expired';
  const suspended = status === 'suspended';
  const allowed = modules.includes('invoice');
  const canTransact = allowed && !expired && !suspended;
  let code = null;
  let error = null;
  if (!allowed) {
    code = 'PLAN_MODULE_DISABLED';
    error = 'Invoice is not on your plan. Upgrade to PreBiz or higher.';
  } else if (expired) {
    code = 'SUBSCRIPTION_EXPIRED';
    error = 'Your subscription has expired. Renew your plan to create invoices.';
  } else if (suspended) {
    code = 'SUBSCRIPTION_SUSPENDED';
    error = 'Your subscription is suspended. Renew your plan to create invoices.';
  }
  return {
    planType,
    planName: tier?.name ?? null,
    modules,
    allowed,
    canTransact,
    status: expired ? 'expired' : status,
    code,
    error,
    plans: PLAN_CATALOG.map((t) => ({
      id: t.id,
      name: t.name,
      price: t.price,
      devices: t.devices,
      tagline: t.tagline,
      includesInvoice: t.modules.includes('invoice'),
    })),
  };
}

export async function loadEntitlement(companyId) {
  if (!companyId) return describeEntitlement(null);
  const { rows } = await pool.query(
    `SELECT plan_type, subscription_status, subscription_expires_at
       FROM companies WHERE id = $1`,
    [companyId]
  );
  return describeEntitlement(rows[0] || null);
}

export async function attachEntitlement(req, _res, next) {
  try {
    const companyId = req.user?.portal_company_id || req.user?.companyId || null;
    req.entitlement = await loadEntitlement(companyId);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireInvoiceModule(req, res, next) {
  const ent = req.entitlement;
  if (ent?.allowed) {
    next();
    return;
  }
  res.status(403).json({
    error: ent?.error || 'Invoice is not on your plan.',
    code: ent?.code || 'PLAN_MODULE_DISABLED',
    planName: ent?.planName ?? null,
  });
}

export function requireActiveSubscription(req, res, next) {
  const ent = req.entitlement;
  if (ent?.canTransact) {
    next();
    return;
  }
  res.status(403).json({
    error: ent?.error || 'Your subscription has expired. Renew your plan to create invoices.',
    code: ent?.code || 'SUBSCRIPTION_EXPIRED',
    planName: ent?.planName ?? null,
  });
}
