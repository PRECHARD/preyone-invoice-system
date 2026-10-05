import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Clients({ notify, onNewDocForClient, canManage }) {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const refresh = async () => {
    setLoading(true);
    try {
      setClients(await api.clients.list());
    } catch (e) {
      notify(e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const saveEdit = async () => {
    try {
      await api.clients.update(editing.id, editing);
      notify('Client updated');
      setEditing(null);
      refresh();
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  const remove = async (c) => {
    if (!confirm(`Delete client “${c.name}”?`)) return;
    try {
      await api.clients.remove(c.id);
      notify('Client deleted');
      refresh();
    } catch (e) {
      notify(e.message, 'error');
    }
  };

  return (
    <div className="page">
      <div className="card">
        <h2>Client book</h2>
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : clients.length === 0 ? (
          <div className="empty-state">
            <p>
              No saved clients yet. Tick “Save to client book” when saving a document, and your
              clients will appear here.
            </p>
          </div>
        ) : (
          <table className="docs-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Address</th>
                <th style={{ width: 250 }}></th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} style={{ cursor: 'default' }}>
                  <td><strong>{c.name}</strong></td>
                  <td>{c.email || '—'}</td>
                  <td>{c.phone || '—'}</td>
                  <td style={{ whiteSpace: 'pre-line', maxWidth: 260 }}>{c.address || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button
                      className="btn ghost small"
                      onClick={() => onNewDocForClient('invoice', c)}
                    >
                      Invoice
                    </button>{' '}
                    <button
                      className="btn ghost small"
                      onClick={() => onNewDocForClient('quotation', c)}
                    >
                      Quote
                    </button>{' '}
                    <button className="btn ghost small" onClick={() => setEditing({ ...c })}>
                      Edit
                    </button>{' '}
                    {canManage && (
                      <button className="btn danger small" onClick={() => remove(c)}>
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <div className="card" style={{ marginTop: '1.2rem' }}>
          <h2>Edit — {editing.name}</h2>
          <div className="grid-2">
            <label className="field">
              Name
              <input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <label className="field">
              Email
              <input
                value={editing.email || ''}
                onChange={(e) => setEditing({ ...editing, email: e.target.value })}
              />
            </label>
          </div>
          <label className="field">
            Address
            <textarea
              rows="2"
              value={editing.address || ''}
              onChange={(e) => setEditing({ ...editing, address: e.target.value })}
            />
          </label>
          <label className="field">
            Phone
            <input
              value={editing.phone || ''}
              onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
            />
          </label>
          <div style={{ display: 'flex', gap: '.5rem' }}>
            <button className="btn primary" onClick={saveEdit}>💾 Save client</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
