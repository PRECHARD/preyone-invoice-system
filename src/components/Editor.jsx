import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { todayISO, addDaysISO } from '../lib/format.js';
import { computeTotals, computePayments } from '../lib/calc.js';
import DocumentSheet from './DocumentSheet.jsx';

const STATUS_OPTIONS = {
  invoice: [
    ['draft', 'Draft'],
    ['unpaid', 'Unpaid'],
    ['partial', 'Partially Paid'],
    ['paid', 'Paid']
  ],
  quotation: [
    ['draft', 'Draft'],
    ['sent', 'Sent'],
    ['partial', 'Partially Paid'],
    ['paid', 'Paid']
  ]
};

const newId = () =>
  (crypto.randomUUID && crypto.randomUUID()) || `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const ZOOMS = [0.5, 0.62, 0.75, 1];

const MERCHANT_ECOCASH = '+263771327202';

export default function Editor({ doc, settings, notify, onSaved, onDeleted, canManage }) {
  const [form, setForm] = useState(structuredClone(doc));
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(0.62);
  const [saveClient, setSaveClient] = useState(false);
  const [clients, setClients] = useState([]);
  const [stock, setStock] = useState([]);
  const [ussdPhone, setUssdPhone] = useState('');
  const [ussdPin, setUssdPin] = useState('');
  const [ussdActive, setUssdActive] = useState(false);
  const [ussdErr, setUssdErr] = useState('');
  const isNew = !doc.id;

  useEffect(() => {
    api.clients.list().then(setClients).catch(() => {});
    api.items.list().then(setStock).catch(() => {});
  }, []);

  useEffect(() => {
    setForm(structuredClone(doc));
  }, [doc]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setClient = (patch) => setForm((f) => ({ ...f, client: { ...f.client, ...patch } }));

  const setItem = (i, patch) =>
    setForm((f) => ({
      ...f,
      items: f.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it))
    }));

  const addItem = () =>
    setForm((f) => ({ ...f, items: [...f.items, { description: '', price: 0, qty: 1 }] }));

  const pickStock = (i, description) => {
    const match = stock.find((s) => s.name.toLowerCase() === description.trim().toLowerCase());
    setItem(i, match ? { description, price: match.price } : { description });
  };

  const paidOf = (f) => computePayments(f).paid;

  const withAutoStatus = (f) => {
    if (f.status === 'draft') return f;
    const paid = paidOf(f);
    if (paid <= 0) {
      if (f.status === 'partial') return { ...f, status: f.type === 'invoice' ? 'unpaid' : 'sent' };
      return f;
    }
    const balance = computeTotals(f).total - paid;
    if (balance <= 0.005) return { ...f, status: 'paid' };
    return { ...f, status: 'partial' };
  };

  const setPayment = (i, patch) =>
    setForm((f) =>
      withAutoStatus({
        ...f,
        payments: (f.payments || []).map((p, idx) => (idx === i ? { ...p, ...patch } : p))
      })
    );

  const addPayment = () =>
    setForm((f) => {
      const balance = computePayments(f).balance;
      return withAutoStatus({
        ...f,
        payments: [
          ...(f.payments || []),
          { id: newId(), date: todayISO(), amount: Number(balance.toFixed(2)), method: '' }
        ]
      });
    });

  const removePayment = (i) =>
    setForm((f) =>
      withAutoStatus({ ...f, payments: (f.payments || []).filter((_, idx) => idx !== i) })
    );

  const openUssd = () => {
    const phone = ussdPhone.replace(/[^\d+]/g, '');
    if (phone.length < 9) {
      setUssdErr('Enter the customer\u2019s EcoCash number (e.g. +263 77 123 4567).');
      return;
    }
    setUssdErr('');
    setUssdPin('');
    setUssdActive(true);
  };

  const confirmUssd = () => {
    if (ussdPin.trim().length < 4) {
      setUssdErr('Customer must approve with their 4-digit EcoCash PIN.');
      return;
    }
    const balance = Number(computePayments(form).balance.toFixed(2));
    if (balance <= 0) return;
    setForm((f) =>
      withAutoStatus({
        ...f,
        payments: [
          ...(f.payments || []),
          {
            id: newId(),
            date: todayISO(),
            amount: balance,
            method: 'ecocash',
            reference: `USSD ${ussdPhone.trim()} PIN\u2714`
          }
        ]
      })
    );
    setUssdActive(false);
    setUssdPin('');
    setUssdPhone('');
  };

  const removeItem = (i) =>
    setForm((f) => ({ ...f, items: f.items.filter((_, idx) => idx !== i) }));

  const changeType = (type) => {
    set({ type, status: 'draft', dueDate: type === 'invoice' ? addDaysISO(form.issueDate, 14) : '' });
  };

  const changeIssueDate = (issueDate) => {
    set({ issueDate, dueDate: form.type === 'invoice' ? addDaysISO(issueDate, 14) : form.dueDate });
  };

  const saveClientRecord = async () => {
    const name = (form.client?.name || '').trim();
    if (!name) return;
    const existing = clients.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      await api.clients.update(existing.id, {
        name,
        address: form.client.address || '',
        email: form.client.email || '',
        phone: form.client.phone || ''
      });
      notify(`Client “${name}” updated`);
    } else {
      await api.clients.create({
        name,
        address: form.client.address || '',
        email: form.client.email || '',
        phone: form.client.phone || ''
      });
      notify(`Client “${name}” saved to client book`);
    }
    setClients(await api.clients.list());
  };

  const persist = async (patch, silent = false) => {
    setSaving(true);
    try {
      const payload = { ...form, ...patch };
      const saved = isNew
        ? await api.documents.create(payload)
        : await api.documents.update(doc.id, payload);
      if (saveClient && (form.client?.name || '').trim()) {
        try {
          await saveClientRecord();
          setSaveClient(false);
        } catch (err) {
          notify(`Client not saved: ${err.message}`, 'error');
        }
      }
      let stockNote = '';
      try {
        const known = new Set(stock.map((s) => s.name.toLowerCase()));
        const fresh = [];
        for (const it of payload.items || []) {
          const name = (it.description || '').trim();
          if (name && !known.has(name.toLowerCase())) {
            known.add(name.toLowerCase());
            fresh.push({ name, price: Number(it.price) || 0 });
          }
        }
        if (fresh.length) {
          for (const f of fresh) await api.items.create(f);
          setStock(await api.items.list());
          stockNote = ` · ${fresh.length} item${fresh.length > 1 ? 's' : ''} added to stock`;
        }
      } catch {
        /* stock sync is best-effort */
      }
      if (!silent) notify(`${saved.number} saved${stockNote}`);
      onSaved(saved);
      return saved;
    } catch (e) {
      notify(e.message, 'error');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const markPaid = async () => {
    setSaving(true);
    try {
      const balance = computePayments(form).balance;
      const payments = [...(form.payments || [])];
      if (balance > 0.005) {
        payments.push({ id: newId(), date: todayISO(), amount: Number(balance.toFixed(2)), method: '' });
      }
      const saved = await api.documents.update(doc.id || form.id, { status: 'paid', payments });
      set(saved && structuredClone(saved));
      notify(`${saved.number} marked as PAID`);
      onSaved(saved);
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const del = async () => {
    if (!confirm(`Delete ${doc.number}?`)) return;
    try {
      await api.documents.remove(doc.id);
      notify(`${doc.number} deleted`);
      onDeleted();
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  const doPrint = async () => {
    if (isNew) {
      const saved = await persist();
      if (!saved) return;
    }
    setTimeout(() => window.print(), 60);
  };

  const downloadPdf = async () => {
    let id = doc.id;
    if (isNew) {
      const saved = await persist();
      if (!saved) return;
      id = saved.id;
    }
    const a = document.createElement('a');
    a.href = `/api/documents/${id}/pdf`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    notify('Generating PDF…');
  };

  const totals = computeTotals(form);
  const { paid: paidAmt, balance } = computePayments(form);

  return (
    <div className="page">
      <div className="actions-bar">
        <button className="btn primary" disabled={saving} onClick={() => persist()}>
          💾 Save
        </button>
        {!isNew && form.status !== 'paid' && (
          <button className="btn ghost" disabled={saving} onClick={markPaid}>
            ✓ Mark as Paid
          </button>
        )}
        <button className="btn ghost" onClick={doPrint}>
          🖨 Print / PDF
        </button>
        <button className="btn ghost" disabled={saving} onClick={downloadPdf}>
          ⬇ Download PDF
        </button>
        {!isNew && canManage && (
          <button className="btn danger" onClick={del}>
            Delete
          </button>
        )}
      </div>

      <div className="editor-layout">
        <div>
          <div className="card" style={{ marginBottom: '1.2rem' }}>
            <h2>Document</h2>
            <div className="grid-3">
              <label className="field">
                Type
                <select
                  value={form.type}
                  disabled={!isNew}
                  onChange={(e) => changeType(e.target.value)}
                >
                  <option value="invoice">Invoice</option>
                  <option value="quotation">Quotation</option>
                </select>
              </label>
              <label className="field">
                Number
                <input value={isNew ? 'auto on save' : doc.number} disabled />
              </label>
              <label className="field">
                Status
                <select value={form.status} onChange={(e) => set({ status: e.target.value })}>
                  {STATUS_OPTIONS[form.type].map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid-3">
              <label className="field">
                Issue date
                <input
                  type="date"
                  value={form.issueDate || ''}
                  onChange={(e) => changeIssueDate(e.target.value)}
                />
              </label>
              <label className="field">
                {form.type === 'invoice' ? 'Due date' : 'Valid until'}
                <input
                  type="date"
                  value={form.dueDate || ''}
                  onChange={(e) => set({ dueDate: e.target.value })}
                />
              </label>
              <label className="field">
                VAT % (incl.)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.taxRate}
                  onChange={(e) => set({ taxRate: e.target.value })}
                />
              </label>
            </div>
            <div className="grid-3">
              <label className="field">
                Discount %
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.discount}
                  onChange={(e) => set({ discount: e.target.value })}
                />
              </label>
              <div style={{ gridColumn: 'span 2' }}>
                <label className="field">
                  Payment Information
                  <textarea
                    rows="2"
                    value={form.notes}
                    placeholder="Bank details, payment info, thank-you note…"
                    onChange={(e) => set({ notes: e.target.value })}
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: '1.2rem' }}>
            <h2>Bill To</h2>
            {clients.length > 0 && (
              <label className="field">
                Load saved client
                <select
                  value=""
                  onChange={(e) => {
                    const c = clients.find((x) => x.id === e.target.value);
                    if (c)
                      setClient({
                        name: c.name,
                        address: c.address || '',
                        email: c.email || '',
                        phone: c.phone || ''
                      });
                  }}
                >
                  <option value="">— Choose client —</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="grid-2">
              <label className="field">
                Client name
                <input
                  value={form.client?.name || ''}
                  onChange={(e) => setClient({ name: e.target.value })}
                />
              </label>
              <label className="field">
                Email
                <input
                  type="email"
                  value={form.client?.email || ''}
                  onChange={(e) => setClient({ email: e.target.value })}
                />
              </label>
            </div>
            <label className="field">
              Address
              <textarea
                rows="2"
                value={form.client?.address || ''}
                onChange={(e) => setClient({ address: e.target.value })}
              />
            </label>
            <div className="grid-2">
              <label className="field">
                Phone
                <input
                  value={form.client?.phone || ''}
                  onChange={(e) => setClient({ phone: e.target.value })}
                />
              </label>
              <label className="field" style={{ textTransform: 'none' }}>
                &nbsp;
                <span style={{ display: 'flex', alignItems: 'center', gap: '.4rem', fontWeight: 500 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={saveClient}
                    onChange={(e) => setSaveClient(e.target.checked)}
                  />
                  Save to client book
                </span>
              </label>
            </div>
          </div>

          <div className="card items-editor">
            <h2>Items</h2>
            <div className="head-row">
              <span>Description</span>
              <span>Price ($)</span>
              <span>Qty</span>
              <span></span>
            </div>
            {form.items.map((it, i) => (
              <div className="item-row" key={i}>
                <input
                  list="stock-items"
                  placeholder="Product or service…"
                  value={it.description}
                  onChange={(e) => pickStock(i, e.target.value)}
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={it.price}
                  onChange={(e) => setItem(i, { price: e.target.value })}
                />
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={it.qty}
                  onChange={(e) => setItem(i, { qty: e.target.value })}
                />
                <button className="icon-btn" title="Remove item" onClick={() => removeItem(i)}>
                  ✕
                </button>
              </div>
            ))}
            <datalist id="stock-items">
              {stock.map((s) => (
                <option key={s.id} value={s.name}>
                  ${Number(s.price || 0).toFixed(2)}
                </option>
              ))}
            </datalist>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '.6rem' }}>
              <button className="btn ghost small" onClick={addItem}>+ Add item</button>
              <strong>Total: ${totals.total.toFixed(2)}</strong>
            </div>
          </div>

          <div className="card payments-editor" style={{ marginBottom: '1.2rem' }}>
            <h2>Payments</h2>
            <div className="head-row pay-head">
              <span>Date</span>
              <span>Amount ($)</span>
              <span>Method / Note</span>
              <span>Reference</span>
              <span></span>
            </div>
            {(form.payments || []).map((p, i) => (
              <div className="payment-row" key={p.id || i}>
                <input
                  type="date"
                  value={p.date || ''}
                  onChange={(e) => setPayment(i, { date: e.target.value })}
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={p.amount ?? 0}
                  onChange={(e) => setPayment(i, { amount: e.target.value })}
                />
                <input
                  placeholder="Cash, EcoCash, bank transfer…"
                  value={p.method || ''}
                  onChange={(e) => setPayment(i, { method: e.target.value })}
                />
                <input
                  placeholder="USSD 077 123 4567"
                  value={p.reference || ''}
                  onChange={(e) => setPayment(i, { reference: e.target.value })}
                />
                <button className="icon-btn" title="Remove payment" onClick={() => removePayment(i)}>
                  ✕
                </button>
              </div>
            ))}
            <div className="pay-summary">
              <button className="btn ghost small" onClick={addPayment}>+ Record payment</button>
              <button className="btn primary small" onClick={openUssd}>📱 EcoCash USSD request</button>
              <span>Total <strong>${totals.total.toFixed(2)}</strong></span>
              <span>Paid <strong className="ok">${paidAmt.toFixed(2)}</strong></span>
              <span>Balance <strong className={balance > 0.005 ? 'due' : 'ok'}>${balance.toFixed(2)}</strong></span>
            </div>
            <div className="ussd-input-row">
              <input
                value={ussdPhone}
                placeholder="Customer EcoCash number (e.g. +263 77 123 4567)"
                onChange={(e) => { setUssdPhone(e.target.value); setUssdErr(''); }}
              />
            </div>
            {ussdErr && <div className="err-note">{ussdErr}</div>}
          </div>
        </div>

        <div className="preview-pane">
          <div className="preview-toolbar">
            <strong style={{ fontSize: '.82rem', color: 'var(--muted)' }}>LIVE PREVIEW — A4</strong>
            <div className="zoom">
              {ZOOMS.map((z) => (
                <button
                  key={z}
                  className={zoom === z ? 'active' : ''}
                  onClick={() => setZoom(z)}
                >
                  {Math.round(z * 100)}%
                </button>
              ))}
            </div>
          </div>
          <div className="sheet-scale-wrap" style={{ height: `${297 * zoom}mm`, overflow: 'hidden' }}>
            <div className="sheet-scale" style={{ zoom }}>
              <DocumentSheet doc={form} settings={settings} />
            </div>
          </div>
        </div>
      </div>

      {createPortal(
        <div id="print-mount" style={{ display: 'none' }}>
          <DocumentSheet doc={form} settings={settings} />
        </div>,
        document.body
      )}

      {ussdActive &&
        createPortal(
          <div className="ussd-overlay-invoice" onClick={() => setUssdActive(false)}>
            <div className="ussd-phone">
              <div className="ussd-bar">
                <span>Econet</span>
                <span>USSD · *151#</span>
              </div>
              <div className="ussd-screen">
                <div className="ussd-header">Preyone Enterprise</div>
                <p className="ussd-body">
                  Payment request
                  <br />
                  <strong>${computePayments(form).balance.toFixed(2)}</strong>
                  <br />
                  <span className="ussd-muted">from {ussdPhone.replace(/[^\d+]/g, '')}</span>
                  <br />
                  <span className="ussd-muted">to {MERCHANT_ECOCASH}</span>
                </p>
                <p className="ussd-question">Enter your EcoCash PIN to approve</p>
                <input
                  className="ussd-pin"
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="••••"
                  value={ussdPin}
                  autoFocus
                  onChange={(e) => { setUssdPin(e.target.value.replace(/\D/g, '')); setUssdErr(''); }}
                />
                {ussdErr && <div className="ussd-err">{ussdErr}</div>}
                <div className="ussd-actions">
                  <button className="ussd-btn" onClick={confirmUssd}>1 Approve</button>
                  <button className="ussd-btn" onClick={() => setUssdActive(false)}>2 Cancel</button>
                </div>
                <p className="ussd-foot">Reply U to cancel</p>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
