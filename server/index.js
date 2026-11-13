import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { store, pool, checkDatabase, ensureSchema } from './store.js';
import { renderPrintPage } from './renderDocument.js';
import { renderPdf } from './pdf.js';
import { computeTotals } from '../src/lib/calc.js';
import {
  requireAuth,
  requireRole,
  loginLimiter,
  loadPermissions,
  signSession,
  setSessionCookie,
  clearSessionCookie,
  requireCompanyScope,
  auditLog,
} from './auth.js';
import { attachEntitlement, requireInvoiceModule, requireActiveSubscription, loadEntitlement } from './entitlements.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, 'dist');
const PORT = process.env.PORT || 4000;

/**
 * The PDF endpoint renders /print/:id by asking this same server for the page.
 * That self-request carries no browser cookie, so /print is gated on either a
 * real session or this per-boot secret. Without it, either the PDF breaks or
 * /print has to be left public -- and a print page is the whole document.
 */
const RENDER_TOKEN = crypto.randomBytes(32).toString('hex');

const app = express();
// nginx terminates TLS in front of us; needed so the rate limiter sees the real client IP.
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ── Public ──────────────────────────────────────────────────────────────────

app.get('/api/health', async (_req, res) => {
  try {
    await checkDatabase();
    res.json({ ok: true, db: 'connected' });
  } catch (e) {
    res.json({ ok: true, db: `unreachable: ${e.message}` });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone, role, password_hash, approved, portal_company_id
         FROM admin_users WHERE lower(email) = lower($1) LIMIT 1`,
      [email]
    );
    const row = rows[0];
    // Compare unconditionally so a missing account and a wrong password cost the same.
    const ok = await bcrypt.compare(password, row?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!row || !ok) {
      auditLog({ email }, 'login_failed', 'account', null, 'bad credentials');
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    if (!row.approved) {
      auditLog(row, 'login_denied', 'account', row.id, 'unapproved');
      res.status(403).json({ error: 'Your account is pending approval' });
      return;
    }
    const permissions = await loadPermissions(row.role, row.id, row.portal_company_id ?? null);
    setSessionCookie(res, signSession(row));
    auditLog(row, 'login', 'account', row.id, `company=${row.portal_company_id || 'none'}`);
    res.json({
      user: {
        id: row.id,
        fullName: row.full_name,
        email: row.email,
        phone: row.phone,
        role: row.role,
        companyId: row.portal_company_id ?? null,
        permissions,
      },
    });
  } catch (e) {
    console.error('login failed:', e.message);
    res.status(500).json({ error: 'Sign-in is unavailable right now' });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ message: 'Signed out' });
});

// ── Authenticated ───────────────────────────────────────────────────────────

app.get('/api/auth/me', requireAuth, (req, res) => {
  const { portal_company_id, ...user } = req.user;
  res.json({ user });
});

const allowPrint = (req, res, next) => {
  const supplied = req.query.render;
  if (typeof supplied === 'string' && supplied.length === 64 && supplied === RENDER_TOKEN) {
    next();
    return;
  }
  requireAuth(req, res, next);
};

app.get('/print/:id', allowPrint, async (req, res) => {
  try {
    if (req.user) {
      const ent = await loadEntitlement(req.user.portal_company_id || req.user.companyId || null);
      if (!ent.allowed) {
        res.status(403).type('text/plain').send(ent.error);
        return;
      }
    }
    const scope = requireCompanyScope(req.user);
    const doc = await store.getDocument(req.params.id, scope);
    if (!doc) return res.status(404).send('Document not found');
    res.type('html').send(renderPrintPage(doc, store.settings));
  } catch (e) {
    res.status(e.status || 500).send(e.message);
  }
});

// Everything past this line needs a valid session and the Invoice module.
app.use('/api', requireAuth);
app.use('/api', attachEntitlement);
app.get('/api/entitlement', (req, res) => {
  res.json(req.entitlement);
});
app.use('/api', requireInvoiceModule);

app.get('/api/settings', (_req, res) => res.json(store.settings));
app.put('/api/settings', requireRole('CEO', 'Manager'), (req, res) => res.json(store.saveSettings(req.body || {})));

app.get('/api/clients', async (req, res) => {
  try {
    res.json(await store.listClients(requireCompanyScope(req.user)));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.post('/api/clients', async (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'Client name is required' });
  try {
    res.status(201).json(await store.addClient(req.body, requireCompanyScope(req.user)));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});
app.put('/api/clients/:id', async (req, res) => {
  try {
    const rec = await store.updateClient(req.params.id, req.body || {}, requireCompanyScope(req.user));
    if (!rec) return res.status(404).json({ error: 'Client not found' });
    res.json(rec);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});
app.delete('/api/clients/:id', requireRole('CEO', 'Manager'), async (req, res) => {
  try {
    if (!(await store.deleteClient(req.params.id, requireCompanyScope(req.user)))) {
      return res.status(404).json({ error: 'Client not found, or it is shared with POS sales' });
    }
    res.status(204).end();
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/items', async (_req, res) => res.json(await store.listItems()));
app.post('/api/items', requireRole('CEO', 'Manager'), async (req, res) => {
  try {
    res.status(201).json(await store.addItem(req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put('/api/items/:id', requireRole('CEO', 'Manager'), async (req, res) => {
  try {
    const rec = await store.updateItem(req.params.id, req.body || {});
    if (!rec) return res.status(404).json({ error: 'Item not found' });
    res.json(rec);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/items/:id', requireRole('CEO', 'Manager'), async (req, res) => {
  if (!(await store.deleteItem(req.params.id))) return res.status(404).json({ error: 'Item not found' });
  res.status(204).end();
});

app.get('/api/documents', async (req, res) => {
  const { type, status, q } = req.query;
  try {
    res.json(await store.listDocuments({ type, status, q }, requireCompanyScope(req.user)));
  } catch (e) {
    console.error('listDocuments failed:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/documents', requireActiveSubscription, async (req, res) => {
  try {
    const doc = await store.createDocument(req.body || {}, requireCompanyScope(req.user));
    auditLog(req.user, 'document_created', 'document', doc.id, `${doc.number} total=${doc.total}`);
    res.status(201).json(doc);
  } catch (e) {
    console.error('createDocument failed:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/documents/:id', async (req, res) => {
  try {
    const doc = await store.getDocument(req.params.id, requireCompanyScope(req.user));
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json(doc);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.put('/api/documents/:id', requireActiveSubscription, async (req, res) => {
  try {
    const scope = requireCompanyScope(req.user);
    const doc = await store.updateDocument(req.params.id, req.body || {}, scope);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    auditLog(req.user, 'document_updated', 'document', doc.id, `${doc.number} total=${doc.total}`);
    res.json(doc);
  } catch (e) {
    console.error('updateDocument failed:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/documents/:id/pdf', async (req, res) => {
  try {
    const scope = requireCompanyScope(req.user);
    const doc = await store.getDocument(req.params.id, scope);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const url = `http://127.0.0.1:${PORT}/print/${doc.id}?render=${RENDER_TOKEN}`;
    const buffer = Buffer.from(await renderPdf(url));
    const total = computeTotals(doc).total;
    const totalPaid = (doc.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const isPaid = doc.status === 'paid' || (total > 0 && totalPaid >= total - 0.005);
    const clientPart = String(doc.client?.name || '')
      .trim()
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, '-');
    const nameParts = [doc.number, clientPart];
    if (clientPart && isPaid) nameParts.push('PAID');
    const filename = `${nameParts.filter(Boolean).join('-')}.pdf`;
    res.type('application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('PDF render failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/documents/:id/duplicate', requireActiveSubscription, async (req, res) => {
  try {
    const doc = await store.duplicateDocument(req.params.id, requireCompanyScope(req.user));
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.status(201).json(doc);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Voiding is a financial action, so it stays with CEO/Manager even though Staff may draft invoices.
app.delete('/api/documents/:id', requireRole('CEO', 'Manager'), requireActiveSubscription, async (req, res) => {
  try {
    const scope = requireCompanyScope(req.user);
    if (!(await store.deleteDocument(req.params.id, scope))) {
      return res.status(404).json({ error: 'Document not found' });
    }
    auditLog(req.user, 'document_voided', 'document', req.params.id);
    res.status(204).end();
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// The shell itself stays public so the SPA can render its own sign-in screen;
// every byte of actual data above is behind the session check.
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

export { app };

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`Preyone Invoice API ready on http://localhost:${PORT}`);
    console.log(
      process.env.NODE_ENV === 'production'
        ? `[auth] mode=production — SSO cookie scoped to .preyone.com, Secure`
        : `[auth] mode=${process.env.NODE_ENV || 'development'} — SSO cookie is host-only and not Secure`
    );
    checkDatabase()
      .then(() => console.log('Shared Preyone database connected — sales sync with POS + admin console'))
      .then(ensureSchema)
      .then(() => console.log('Schema verified (pos_customers.company_id present)'))
      .catch((e) =>
        console.warn(
          'WARNING: shared database unreachable. Start it with:\n' +
            '  node scripts/dev-pos.mjs   (in the preyone-ruijie-captive-portal repo)\n' +
            'or set DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD env vars.\n' +
            `  (${e.message})`
        )
      );
  });

  server.on('error', (err) => {
    console.error(`Server failed to start: ${err.message}`);
    process.exit(1);
  });
}
