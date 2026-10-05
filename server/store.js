import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// â”€â”€ Branding settings stay local (not business data) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const localDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const dataDir = process.env.PREYONE_DATA_DIR || localDir;
const settingsFile = path.join(dataDir, 'settings.json');
const legacyDbFile = path.join(dataDir, 'db.json');

const defaultSettings = {
  companyName: 'Preyone enterprise',
  tagline: 'Innovation with it exellence, driven by faith, growing beyond bounds',
  address: '245 Sullivan Street.\nCenturion, South Africa.',
email: 'support@preyone.com',
  phone: '+263 77 132 7202',
  phone2: '+27 81 358 4854',
  website: 'www.preyone.com',
  terms: 'Payment due within 14 days of issue. Goods remain the property of Preyone enterprise until paid in full.',
};

function persistSettings(s) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${settingsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, settingsFile);
}

function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
  } catch {
    // First run after the Postgres port: carry branding over from the old db.json
    let carried = {};
    try {
      carried = JSON.parse(fs.readFileSync(legacyDbFile, 'utf8')).settings || {};
    } catch { /* fresh install */ }
    const merged = { ...defaultSettings, ...carried };
    persistSettings(merged);
    return merged;
  }
}

let settings = loadSettings();

// â”€â”€ Shared Preyone database (same pos_* tables as the POS till) â”€â”€â”€â”€â”€

export const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5433),
  database: process.env.DB_NAME || 'preyone_pos',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'posdemo',
  max: 10,
});

pool.on('error', (err) => console.error('[store] pg pool error:', err.message));

export async function checkDatabase() {
  await pool.query('SELECT 1');
}

/**
 * Additive-only, idempotent. NULL company_id on existing rows is intentional
 * (it means "shared/legacy", matching what the portal POS still writes), so
 * there is deliberately no backfill and no NOT NULL here.
 */
export async function ensureSchema() {
  await pool.query(`ALTER TABLE pos_customers ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pos_customers_company ON pos_customers (company_id)`);
}

/**
 * Resolve the owning tenant for office-issued documents.
 *
 * pos_documents.company_id is NOT NULL with no default and FKs to companies(id):
 * the portal made the POS tables tenant-scoped after this app was written, so
 * every INSERT must name an owner or Postgres rejects it outright.
 *
 * `scope` is the caller's own company (admin_users.portal_company_id), supplied
 * by requireAuth. That is what keeps two tenants' invoices apart: the company a
 * user may see is decided by their account, never by anything the request body
 * or query string can influence.
 *
 * INVOICE_COMPANY_ID remains a deliberate override for single-tenant setups and
 * for the portal's own Level 0 account, which has no portal_company_id but still
 * needs to reach Preyone's own books. When it is set it wins for every caller,
 * so only set it if this instance genuinely serves one company.
 */
let cachedCompanyId = null;

async function resolveOverride(client) {
  if (cachedCompanyId) return cachedCompanyId;
  const pinned = str(process.env.INVOICE_COMPANY_ID).trim();
  if (!pinned) return null;
  const { rows } = await client.query('SELECT id FROM companies WHERE id = $1::uuid', [pinned]);
  if (!rows[0]) {
    throw new Error(
      `INVOICE_COMPANY_ID=${pinned} does not match any company. Fix the value or unset it.`
    );
  }
  cachedCompanyId = pinned;
  return cachedCompanyId;
}

/**
 * Company id every statement in this request must be filtered by.
 *
 * Order: per-user scope, then the operator override, then -- only while a single
 * company exists -- that company. The multi-company case throws instead of
 * guessing, because silently filing one tenant's invoices under another is far
 * worse than refusing to show anything.
 */
async function companyIdFor(scope, client = pool) {
  if (scope) return scope;
  const override = await resolveOverride(client);
  if (override) return override;
  const { rows } = await client.query('SELECT id FROM companies ORDER BY created_at ASC');
  if (rows.length === 0) throw Object.assign(new Error('No company exists to own these documents.'), { status: 500 });
  if (rows.length > 1) {
    throw Object.assign(
      new Error('Several companies exist, so the owning tenant is ambiguous. Assign the account to a company.'),
      { status: 403 }
    );
  }
  return rows[0].id;
}



const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => (v == null ? '' : String(v));
const PAY_METHODS = ['cash', 'card', 'ecocash', 'bank', 'pesepay', 'other'];
const STATUSES = ['draft', 'unpaid', 'sent', 'partial', 'paid'];
const DOC_PREFIX = { invoice: 'INV', quotation: 'QUO' };

function computeTotals(doc) {
  const items = Array.isArray(doc.items) ? doc.items : [];
  const subtotal = items.reduce((s, it) => s + num(it.price) * num(it.qty), 0);
  const discountAmount = subtotal * ((num(doc.discount)) / 100);
  return { subtotal, total: round2(subtotal - discountAmount) };
}

const mapMethod = (m) => {
  const v = str(m).toLowerCase();
  return PAY_METHODS.includes(v) ? v : 'other';
};
const mapStatus = (s) => {
  const v = str(s).toLowerCase();
  return STATUSES.includes(v) ? v : 'draft';
};

const DOC_SELECT = `
  SELECT d.id::text AS id, d.doc_number AS number, d.doc_type AS type,
         d.status, d.issue_date, d.due_date, d.notes,
         d.subtotal::float8, d.discount_pct::float8, d.tax_pct::float8,
         d.total::float8, d.amount_paid::float8,
         d.created_at, d.updated_at,
         COALESCE(c.name, '')   AS client_name,
         COALESCE(c.address,'') AS client_address,
         COALESCE(c.email, '')  AS client_email,
         COALESCE(c.phone, '')  AS client_phone,
         COALESCE((
           SELECT json_agg(x ORDER BY x.position)
             FROM (SELECT description, price::float8 AS price, qty::float8 AS qty, position
                     FROM pos_document_items WHERE document_id = d.id) x
         ), '[]'::json) AS items,
COALESCE((
            SELECT json_agg(y ORDER BY y.paid_at)
              FROM (SELECT id::text AS id, paid_at, amount::float8 AS amount, method, reference
                      FROM pos_document_payments WHERE document_id = d.id) y
          ), '[]'::json) AS payments
    FROM pos_documents d
    LEFT JOIN pos_customers c ON c.id = d.customer_id`;

function rowToDoc(r) {
  return {
    id: r.id,
    type: r.type === 'quotation' ? 'quotation' : 'invoice',
    number: r.number,
    status: r.status,
    issueDate: r.issue_date ? r.issue_date.toISOString().slice(0, 10) : '',
    dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : '',
    client: {
      name: r.client_name || '',
      address: r.client_address || '',
      email: r.client_email || '',
      phone: r.client_phone || '',
    },
    items: (r.items || []).map((i) => ({ description: i.description, price: Number(i.price), qty: Number(i.qty) })),
    payments: (r.payments || []).map((p) => ({
      id: p.id,
      date: p.paid_at ? new Date(p.paid_at).toISOString().slice(0, 10) : '',
      amount: Number(p.amount),
      method: p.method === 'other' ? '' : p.method,
      reference: p.reference || '',
    })),
    taxRate: Number(r.tax_pct),
    discount: Number(r.discount_pct),
    notes: r.notes || '',
    createdAt: r.created_at ? r.created_at.toISOString() : new Date().toISOString(),
    updatedAt: r.updated_at ? r.updated_at.toISOString() : new Date().toISOString(),
  };
}

/**
 * pos_customers.company_id is nullable on purpose: the portal POS (src/routes/pos.ts)
 * still inserts customers without one, and making it NOT NULL would break checkout.
 * NULL therefore means "shared/legacy" and stays visible to every tenant, while
 * rows this app creates are stamped with the caller's company and stay private to it.
 */
const CLIENT_SCOPE = (p = 1) => `(company_id = $${p} OR company_id IS NULL)`;

async function upsertCustomer(client, c = {}, companyId = null) {
  const name = str(c.name).trim();
  if (!name) return null;
  const found = await client.query(
    `SELECT id FROM pos_customers
      WHERE lower(name) = lower($1) AND ${CLIENT_SCOPE(2)}
      ORDER BY company_id NULLS LAST
      LIMIT 1`,
    [name, companyId]
  );
  if (found.rows[0]) {
    await client.query(
      `UPDATE pos_customers SET
          phone = CASE WHEN $2::text IS NOT NULL AND $2::text <> '' THEN $2 ELSE phone END,
          email = CASE WHEN $3::text IS NOT NULL AND $3::text <> '' THEN $3 ELSE email END,
          address = CASE WHEN $4::text IS NOT NULL AND $4::text <> '' THEN $4 ELSE address END,
          updated_at = NOW()
        WHERE id = $1`,
      [found.rows[0].id, str(c.phone).trim() || null, str(c.email).trim() || null, str(c.address).trim() || null]
    );
    return found.rows[0].id;
  }
  const ins = await client.query(
    `INSERT INTO pos_customers (name, phone, email, address, company_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [name, str(c.phone).trim() || null, str(c.email).trim() || null, str(c.address).trim() || null, companyId]
  );
  return ins.rows[0].id;
}

async function insertChildren(client, docId, doc) {
  for (let i = 0; i < (doc.items || []).length; i++) {
    const it = doc.items[i];
    const description = str(it.description).trim();
    if (!description && !num(it.price)) continue;
    let productId = null;
    if (description) {
      const match = await client.query(
        `SELECT id FROM pos_products WHERE active = TRUE AND lower(name) = lower($1) LIMIT 1`,
        [description]
      );
      if (match.rows[0]) productId = match.rows[0].id;
    }
    await client.query(
      `INSERT INTO pos_document_items (document_id, product_id, description, price, qty, line_total, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [docId, productId, description || 'Item', round2(num(it.price)), round2(num(it.qty)) || 1,
        round2(num(it.price) * (num(it.qty) || 1)), i]
    );
  }
  for (const p of doc.payments || []) {
    const amount = round2(num(p.amount));
    if (amount <= 0) continue;
    const when = str(p.date) ? new Date(`${str(p.date)}T12:00:00`) : new Date();
    await client.query(
      `INSERT INTO pos_document_payments (document_id, amount, method, reference, paid_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [docId, amount, mapMethod(p.method), p.reference ? str(p.reference) : null,
        Number.isNaN(when.getTime()) ? new Date() : when]
    );
  }
}

async function nextDocNumber(client, type) {
  const seq = await client.query(`SELECT nextval('pos_doc_number_seq') AS v`);
  return `${DOC_PREFIX[type]}-${String(seq.rows[0].v).padStart(4, '0')}`;
}

async function fetchDoc(id, scope) {
  const companyId = await companyIdFor(scope);
  const { rows } = await pool.query(`${DOC_SELECT} WHERE d.id = $1 AND d.company_id = $2`, [id, companyId]);
  return rows[0] ? rowToDoc(rows[0]) : null;
}

// â”€â”€ Store interface (identical contract to the previous file store) â”€â”€

export const store = {
  get settings() { return settings; },
  saveSettings(patch) {
    settings = { ...settings, ...(patch || {}) };
    persistSettings(settings);
    return settings;
  },

  async listClients(scope) {
    const companyId = await companyIdFor(scope);
    const { rows } = await pool.query(
      `SELECT id::text AS id, name, phone, email, address, created_at AS "createdAt"
         FROM pos_customers WHERE ${CLIENT_SCOPE(1)} ORDER BY name`,
      [companyId]
    );
    return rows;
  },
  async addClient(c = {}, scope) {
    const companyId = await companyIdFor(scope);
    const name = str(c.name).trim();
    if (!name) throw new Error('Client name is required');
    const existing = await pool.query(
      `SELECT id::text AS id FROM pos_customers
        WHERE lower(name) = lower($1) AND ${CLIENT_SCOPE(2)}
        ORDER BY company_id NULLS LAST LIMIT 1`,
      [name, companyId]
    );
    if (existing.rows[0]) {
      return (await pool.query(
        `UPDATE pos_customers SET phone=$2, email=$3, address=$4, updated_at=NOW()
          WHERE id=$1::uuid RETURNING id::text AS id, name, phone, email, address, created_at AS "createdAt"`,
        [existing.rows[0].id, str(c.phone) || null, str(c.email) || null, str(c.address) || null]
      )).rows[0];
    }
    return (await pool.query(
      `INSERT INTO pos_customers (name, phone, email, address, company_id)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id::text AS id, name, phone, email, address, created_at AS "createdAt"`,
      [name, str(c.phone) || null, str(c.email) || null, str(c.address) || null, companyId]
    )).rows[0];
  },
  async updateClient(id, patch = {}, scope) {
    const companyId = await companyIdFor(scope);
    const fields = [];
    const values = [];
    for (const k of ['name', 'phone', 'email', 'address']) {
      if (k in patch) {
        values.push(str(patch[k]) || null);
        fields.push(`${k} = $${values.length}`);
      }
    }
    if (!fields.length) {
      const { rows } = await pool.query(
        `SELECT id::text AS id, name, phone, email, address, created_at AS "createdAt"
           FROM pos_customers WHERE id = $1::uuid AND ${CLIENT_SCOPE(2)}`,
        [id, companyId]
      );
      return rows[0] || null;
    }
    values.push(id, companyId);
    const idPos = values.length - 1;
    const { rows } = await pool.query(
      `UPDATE pos_customers SET ${fields.join(', ')}, updated_at = NOW()
        WHERE id = $${idPos}::uuid AND ${CLIENT_SCOPE(values.length)}
        RETURNING id::text AS id, name, phone, email, address, created_at AS "createdAt"`,
      values
    );
    return rows[0] || null;
  },
  async deleteClient(id, scope) {
    const companyId = await companyIdFor(scope);
    // Refuse to delete a shared/legacy row: POS sales reference it too.
    const { rowCount } = await pool.query(
      `DELETE FROM pos_customers
        WHERE id = $1::uuid AND company_id = $2::uuid AND company_id IS NOT NULL`,
      [id, companyId]
    );
    return rowCount > 0;
  },

  // pos_products is a deliberately shared catalogue (the portal POS stocks the same
  // rows for every tenant and does not write company_id), so these stay unscoped.
  async listItems() {
    const { rows } = await pool.query(
      `SELECT id::text AS id, name, price::float8 AS price
         FROM pos_products WHERE active = TRUE ORDER BY lower(name)`
    );
    return rows;
  },
  async addItem(data = {}) {
    const name = str(data.name).trim();
    if (!name) throw new Error('Item name is required');
    const price = round2(num(data.price));
    const existing = await pool.query(`SELECT id::text AS id FROM pos_products WHERE lower(name)=lower($1) LIMIT 1`, [name]);
    if (existing.rows[0]) {
      return (await pool.query(
        `UPDATE pos_products SET price=$2, updated_at=NOW() WHERE id=$1::uuid
         RETURNING id::text AS id, name, price::float8 AS price`,
        [existing.rows[0].id, price]
      )).rows[0];
    }
    return (await pool.query(
      `INSERT INTO pos_products (name, price, track_stock, stock_qty)
       VALUES ($1,$2,FALSE,0)
       RETURNING id::text AS id, name, price::float8 AS price`,
      [name, price]
    )).rows[0];
  },
  async updateItem(id, patch = {}) {
    const fields = [];
    const values = [];
    if ('name' in patch) {
      const n = str(patch.name).trim();
      if (!n) throw new Error('Item name is required');
      values.push(n); fields.push(`name = $${values.length}`);
    }
    if ('price' in patch) {
      values.push(round2(num(patch.price))); fields.push(`price = $${values.length}`);
    }
    if (!fields.length) throw new Error('Nothing to update');
    values.push(id);
    const { rows } = await pool.query(
      `UPDATE pos_products SET ${fields.join(', ')}, updated_at = NOW()
        WHERE id = $${values.length}::uuid
        RETURNING id::text AS id, name, price::float8 AS price`,
      values
    );
    return rows[0] || null;
  },
  async deleteItem(id) {
    const { rowCount } = await pool.query(
      `UPDATE pos_products SET active = FALSE, updated_at = NOW() WHERE id = $1::uuid`,
      [id]
    );
    return rowCount > 0;
  },

  async listDocuments(filter = {}, scope) {
    const params = [];
    const where = [`d.status <> 'void'`, `d.doc_type <> 'sale'`, `d.company_id = $1`];
    params.push(await companyIdFor(scope));
    if (filter.type) { params.push(filter.type); where.push(`d.doc_type = $${params.length}`); }
    if (filter.status) { params.push(filter.status); where.push(`d.status = $${params.length}`); }
    if (filter.q) {
      params.push(`%${str(filter.q).toLowerCase()}%`);
      where.push(`(lower(d.doc_number) LIKE $${params.length} OR lower(coalesce(c.name,'')) LIKE $${params.length})`);
    }
    const { rows } = await pool.query(
      `${DOC_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 500`,
      params
    );
    return rows.map(rowToDoc);
  },

  async getDocument(id, scope) {
    return fetchDoc(id, scope);
  },

  async createDocument(data = {}, scope) {
    const type = data.type === 'quotation' ? 'quotation' : 'invoice';
    const draft = {
      items: data.items || [{ description: '', price: 0, qty: 1 }],
      discount: data.discount ?? 0,
      taxRate: data.taxRate ?? 0,
      payments: data.payments || [],
    };
    const totals = computeTotals(draft);
    const amountPaid = round2((data.payments || []).reduce((s, p) => s + num(p.amount), 0));
    const status = mapStatus(data.status);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const companyId = await companyIdFor(scope, client);
      const number = await nextDocNumber(client, type);
      const customerId = await upsertCustomer(client, data.client, companyId);
      const inserted = await client.query(
        `INSERT INTO pos_documents
            (doc_number, doc_type, channel, status, issue_date, due_date, customer_id,
             subtotal, discount_pct, tax_pct, total, amount_paid, notes, company_id)
         VALUES ($1,$2,'office',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [number, type, status,
          str(data.issueDate) || new Date().toISOString().slice(0, 10),
          str(data.dueDate) || null,
          customerId,
          round2(totals.subtotal), round2(num(data.discount)), round2(num(data.taxRate)),
          totals.total, amountPaid, str(data.notes) || null,
          companyId]
      );
      const docId = inserted.rows[0].id;

      // Link items to catalogue products and decrement tracked stock once, at creation
      for (let i = 0; i < draft.items.length; i++) {
        const it = draft.items[i];
        const description = str(it.description).trim();
        if (!description && !num(it.price)) continue;
        let productId = null;
        if (description) {
          const match = await client.query(
            `SELECT id FROM pos_products WHERE active = TRUE AND lower(name) = lower($1) LIMIT 1`,
            [description]
          );
          if (match.rows[0]) {
            productId = match.rows[0].id;
            await client.query(
              `UPDATE pos_products SET stock_qty = stock_qty - $1, updated_at = NOW()
                WHERE id = $2 AND track_stock = TRUE`,
              [round2(num(it.qty)) || 1, productId]
            );
          }
        }
        await client.query(
          `INSERT INTO pos_document_items (document_id, product_id, description, price, qty, line_total, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [docId, productId, description || 'Item', round2(num(it.price)), round2(num(it.qty)) || 1,
            round2(num(it.price) * (num(it.qty) || 1)), i]
        );
      }
      for (const p of draft.payments) {
        const amount = round2(num(p.amount));
        if (amount <= 0) continue;
        const when = str(p.date) ? new Date(`${str(p.date)}T12:00:00`) : new Date();
        await client.query(
          `INSERT INTO pos_document_payments (document_id, amount, method, paid_at)
           VALUES ($1,$2,$3,$4)`,
          [docId, amount, mapMethod(p.method), Number.isNaN(when.getTime()) ? new Date() : when]
        );
      }
      await client.query('COMMIT');
      return fetchDoc(docId, companyId);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async updateDocument(id, patch = {}, scope) {
    const companyId = await companyIdFor(scope);
    const currentRow = await pool.query(
      `SELECT doc_type FROM pos_documents
        WHERE id = $1::uuid AND status <> 'void' AND company_id = $2`,
      [id, companyId]
    );
    if (!currentRow.rows[0]) return null;

    const current = await fetchDoc(id, companyId);
    const merged = {
      ...current,
      ...(['status', 'issueDate', 'dueDate', 'client', 'items', 'payments', 'taxRate', 'discount', 'notes', 'type']
        .reduce((acc, k) => (k in patch ? { ...acc, [k]: patch[k] } : acc), {})),
    };
    if (patch.type && patch.type !== merged.type) {
      merged.number = await nextDocNumber(pool, patch.type === 'quotation' ? 'quotation' : 'invoice');
      merged.type = patch.type === 'quotation' ? 'quotation' : 'invoice';
    }
    const totals = computeTotals(merged);
    const amountPaid = round2((merged.payments || []).reduce((s, p) => s + num(p.amount), 0));
    const status = mapStatus(merged.status);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const customerId = await upsertCustomer(client, merged.client, companyId);
      await client.query(
        `UPDATE pos_documents SET
            doc_number = $2, doc_type = $3, status = $4, issue_date = $5, due_date = $6,
            customer_id = $7, subtotal = $8, discount_pct = $9, tax_pct = $10,
            total = $11, amount_paid = $12, notes = $13, updated_at = NOW()
          WHERE id = $1::uuid AND company_id = $14`,
        [id, merged.number, merged.type, status,
          str(merged.issueDate) || null, str(merged.dueDate) || null,
          customerId,
          round2(totals.subtotal), round2(num(merged.discount)), round2(num(merged.taxRate)),
          totals.total, amountPaid, str(merged.notes) || null,
          companyId]
      );
      await client.query(`DELETE FROM pos_document_items WHERE document_id = $1::uuid`, [id]);
      await client.query(`DELETE FROM pos_document_payments WHERE document_id = $1::uuid`, [id]);
      await insertChildren(client, id, merged);
      await client.query('COMMIT');
      return fetchDoc(id, companyId);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async duplicateDocument(id, scope) {
    const companyId = await companyIdFor(scope);
    const src = await fetchDoc(id, companyId);
    if (!src) return null;
    return this.createDocument({ ...src, status: 'draft' }, companyId);
  },

  async deleteDocument(id, scope) {
    // Keep the audit trail: void instead of hard delete (matches POS behaviour)
    const { rowCount } = await pool.query(
        `UPDATE pos_documents SET status = 'void', updated_at = NOW()
        WHERE id = $1::uuid AND status <> 'void' AND company_id = $2`,
      [id, await companyIdFor(scope)]
    );
    return rowCount > 0;
  },
};


