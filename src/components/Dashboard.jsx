import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { money, fmtDate } from '../lib/format.js';
import { computeTotals } from '../lib/calc.js';

export default function Dashboard({ onOpen, onNew, notify, canManage }) {
  const [docs, setDocs] = useState([]);
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      setDocs(await api.documents.list({ q, type, status }));
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [q, type, status]);

  const remove = async (e, id) => {
    e.stopPropagation();
    if (!confirm('Delete this document permanently?')) return;
    try {
      await api.documents.remove(id);
      notify('Document deleted');
      refresh();
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const duplicate = async (e, id) => {
    e.stopPropagation();
    try {
      const copy = await api.documents.duplicate(id);
      notify(`Created ${copy.number} (draft)`);
      onOpen(copy);
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="page">
      <div className="list-toolbar">
        <input
          type="search"
          placeholder="Search number or client"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          <option value="invoice">Invoices</option>
          <option value="quotation">Quotations</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="unpaid">Unpaid / Sent</option>
          <option value="partial">Partially Paid</option>
          <option value="paid">Paid</option>
        </select>
        <div className="spacer" />
        <button className="btn primary" onClick={onNew}>+ New Document</button>
      </div>

      <div className="card">
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : docs.length === 0 ? (
          <div className="empty-state">
            <img src="/brand/Preyone.svg" alt="" />
            <p>No documents yet. Create your first invoice or quotation.</p>
            <button className="btn primary" onClick={onNew}>+ New Document</button>
          </div>
        ) : (
          <table className="docs-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Number</th>
                <th>Client</th>
                <th>Issued</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th style={{ width: 190 }}></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => {
                const { total } = computeTotals(d);
                return (
                  <tr key={d.id} onClick={() => onOpen(d)}>
                    <td>
                      <span className={`type-badge ${d.type}`}>{d.type}</span>
                    </td>
                    <td><strong>{d.number}</strong></td>
                    <td>{d.client?.name || '—'}</td>
                    <td>{fmtDate(d.issueDate)}</td>
                    <td><span className={`status-pill status-${d.status}`}>{d.status}</span></td>
                    <td className="num">{money(total)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <a
                        className="btn ghost small"
                        href={`/api/documents/${d.id}/pdf`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        PDF
                      </a>{' '}
                      <button className="btn ghost small" onClick={(e) => duplicate(e, d.id)}>Duplicate</button>{' '}
                      {canManage && (
                        <button className="btn danger small" onClick={(e) => remove(e, d.id)}>Delete</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

