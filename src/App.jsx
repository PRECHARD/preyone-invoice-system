import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { todayISO, addDaysISO } from './lib/format.js';
import Dashboard from './components/Dashboard.jsx';
import Editor from './components/Editor.jsx';
import SettingsPage from './components/Settings.jsx';
import Clients from './components/Clients.jsx';
import Login from './components/Login.jsx';
import UpgradePlan from './components/UpgradePlan.jsx';

const blankDoc = (type, client = null) => ({
  type,
  status: 'draft',
  issueDate: todayISO(),
  dueDate: type === 'invoice' ? addDaysISO(todayISO(), 14) : '',
  client: client
    ? { name: client.name, address: client.address || '', email: client.email || '', phone: client.phone || '' }
    : { name: '', address: '', email: '', phone: '' },
  items: [{ description: '', price: 0, qty: 1 }],
  payments: [],
  taxRate: 15.5,
  discount: 0,
  notes: ''
});

export default function App() {
  const [view, setView] = useState({ name: 'dashboard' });
  const [settings, setSettings] = useState(null);
  const [toast, setToast] = useState(null);
  const [user, setUser] = useState(undefined);
  const [entitlement, setEntitlement] = useState(undefined);

  const notify = useCallback((message, kind = 'ok') => {
    setToast({ message, kind });
    clearTimeout(notify._t);
    notify._t = setTimeout(() => setToast(null), 2600);
  }, []);

  // undefined = still checking, null = signed out, object = signed in.
  useEffect(() => {
    api.auth
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null));
  }, []);

  // api.js raises this when any request comes back 401 mid-session.
  useEffect(() => {
    const signedOut = () => setUser(null);
    window.addEventListener('preyone:signed-out', signedOut);
    return () => window.removeEventListener('preyone:signed-out', signedOut);
  }, []);

  useEffect(() => {
    if (!user) {
      setEntitlement(undefined);
      return;
    }
    api.entitlement()
      .then(setEntitlement)
      .catch((e) => {
        notify(e.message, 'error');
        setEntitlement({
          allowed: false,
          canTransact: false,
          planName: null,
          error: e.message,
          plans: [],
        });
      });
  }, [user, notify]);

  useEffect(() => {
    if (!user || !entitlement?.allowed) return;
    api.settings
      .get()
      .then(setSettings)
      .catch((e) => notify(e.message, 'error'));
  }, [user, entitlement, notify]);

  const openDoc = (doc) => setView({ name: 'editor', doc });
  const newDoc = () => {
    if (entitlement && !entitlement.canTransact) {
      notify(entitlement.error || 'Renew your plan to create invoices.', 'error');
      return;
    }
    setView({ name: 'editor', doc: blankDoc('invoice') });
  };

  // Voiding documents, deleting clients and editing company settings are
  // CEO/Manager-only on the server; hide them rather than offer a 403.
  const canManage = user?.role === 'CEO' || user?.role === 'Manager';

  const signOut = async () => {
    try {
      await api.auth.logout();
    } catch {
      /* cookie may already be gone; either way we return to the sign-in screen */
    }
    setSettings(null);
    setEntitlement(undefined);
    setView({ name: 'dashboard' });
    setUser(null);
  };

  if (user === undefined) {
    return (
      <div className="empty-state" style={{ paddingTop: '8rem' }}>
        <img src="/brand/Preyone.svg" alt="Preyone" />
        <p>Loading…</p>
      </div>
    );
  }

  if (user === null) {
    return <Login onSignedIn={setUser} />;
  }

  if (user && entitlement === undefined) {
    return (
      <div className="empty-state" style={{ paddingTop: '8rem' }}>
        <img src="/brand/Preyone.svg" alt="Preyone" />
        <p>Loading…</p>
      </div>
    );
  }

  if (user && entitlement && !entitlement.allowed) {
    return <UpgradePlan entitlement={entitlement} onSignOut={signOut} />;
  }

  if (!settings) {
    return (
      <div className="empty-state" style={{ paddingTop: '8rem' }}>
        <img src="/brand/Preyone.svg" alt="Preyone" />
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <>
      <header className="app-topbar no-print">
        <div className="logo">
          <img src="/brand/Preyone.svg" alt="Preyone enterprise" />
        </div>
        <nav className="app-nav">
          <button
            className={view.name === 'dashboard' ? 'active' : ''}
            onClick={() => setView({ name: 'dashboard' })}
          >
            Documents
          </button>
          <button
            className={view.name === 'clients' ? 'active' : ''}
            onClick={() => setView({ name: 'clients' })}
          >
            Clients
          </button>
          {canManage && (
            <button
              className={view.name === 'settings' ? 'active' : ''}
              onClick={() => setView({ name: 'settings' })}
            >
              Settings
            </button>
          )}
        </nav>
        <button
          className="btn ghost"
          style={{ background: 'rgba(255,255,255,.14)', color: '#fff', border: 'none' }}
          onClick={newDoc}
          disabled={!entitlement?.canTransact}
        >
          + New
        </button>
        <div className="login-user">
          <span className="login-user-name">{user.fullName}</span>
          <button type="button" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {entitlement && !entitlement.canTransact && (
        <div className="card" style={{ margin: '1rem auto', maxWidth: 960 }}>
          <strong>{entitlement.planName || 'Your plan'}</strong>
          <p>{entitlement.error}</p>
        </div>
      )}

      {view.name === 'dashboard' && (
        <Dashboard onOpen={openDoc} onNew={newDoc} notify={notify} canManage={canManage} />
      )}

      {view.name === 'editor' && (
        <Editor
          key={view.doc.id || 'new'}
          doc={view.doc}
          settings={settings}
          notify={notify}
          canManage={canManage}
          onSaved={(saved) => {
            setSettings(settings);
            setView({ name: 'editor', doc: saved });
          }}
          onDeleted={() => setView({ name: 'dashboard' })}
        />
      )}

      {view.name === 'clients' && (
        <Clients
          notify={notify}
          canManage={canManage}
          onNewDocForClient={(type, client) =>
            setView({ name: 'editor', doc: blankDoc(type, client) })
          }
        />
      )}

      {view.name === 'settings' && (
        <SettingsPage settings={settings} notify={notify} onSaved={setSettings} />
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
    </>
  );
}
