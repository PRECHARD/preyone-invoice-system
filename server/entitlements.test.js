import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const query = vi.hoisted(() => vi.fn());

vi.mock('../server/store.js', () => ({
  pool: { query },
  store: {},
  checkDatabase: vi.fn(),
  ensureSchema: vi.fn(),
}));

import {
  attachEntitlement,
  describeEntitlement,
  modulesForPlan,
  requireActiveSubscription,
  requireInvoiceModule,
} from '../server/entitlements.js';

function companyRow(planType, extras = {}) {
  query.mockResolvedValue({
    rows: [{ plan_type: planType, subscription_status: 'active', subscription_expires_at: null, ...extras }],
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { portal_company_id: 'company-1' };
    next();
  });
  app.use(attachEntitlement);
  app.get('/api/entitlement', (req, res) => res.json(req.entitlement));
  app.use(requireInvoiceModule);
  app.get('/api/documents', (_req, res) => res.json([]));
  app.post('/api/documents', requireActiveSubscription, (_req, res) => res.status(201).json({ id: 'doc-1' }));
  return app;
}

beforeEach(() => {
  query.mockReset();
});

describe('invoice plan names', () => {
  it('uses the same Pre names and module split as the portal', () => {
    expect(modulesForPlan('standard_10')).toEqual(['pos']);
    expect(modulesForPlan('pos_invoice_15')).toEqual(['pos', 'invoice']);
    expect(describeEntitlement({ plan_type: 'standard_10', subscription_status: 'active' }).planName).toBe('PreTill');
    expect(describeEntitlement({ plan_type: 'pos_invoice_15', subscription_status: 'active' }).planName).toBe('PreBiz');
    expect(describeEntitlement({ plan_type: 'growth_20', subscription_status: 'active' }).planName).toBe('PrePro');
    expect(describeEntitlement({ plan_type: 'unlimited_30', subscription_status: 'active' }).planName).toBe('PreUnlimited');
  });
});

describe('invoice API entitlement', () => {
  it('refuses a PreTill company on every invoice route', async () => {
    companyRow('standard_10');
    const app = buildApp();
    const docs = await request(app).get('/api/documents');
    const created = await request(app).post('/api/documents').send({});
    expect(docs.status).toBe(403);
    expect(docs.body.code).toBe('PLAN_MODULE_DISABLED');
    expect(docs.body.error).toMatch(/not on your plan/i);
    expect(created.status).toBe(403);
    expect(created.body.code).toBe('PLAN_MODULE_DISABLED');
  });

  it('lets PreBiz and above read and create invoices', async () => {
    for (const plan of ['pos_invoice_15', 'growth_20', 'unlimited_30']) {
      companyRow(plan);
      const app = buildApp();
      const docs = await request(app).get('/api/documents');
      const created = await request(app).post('/api/documents').send({ type: 'invoice' });
      expect(docs.status, plan).toBe(200);
      expect(created.status, plan).toBe(201);
    }
  });

  it('blocks a new invoice when the plan has expired', async () => {
    companyRow('unlimited_30', { subscription_expires_at: new Date(Date.now() - 60_000).toISOString() });
    const app = buildApp();
    const docs = await request(app).get('/api/documents');
    const created = await request(app).post('/api/documents').send({});
    expect(docs.status).toBe(200);
    expect(created.status).toBe(403);
    expect(created.body.code).toBe('SUBSCRIPTION_EXPIRED');
    expect(created.body.error).toMatch(/expired/i);
  });
});
