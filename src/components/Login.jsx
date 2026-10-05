import { useState } from 'react';
import { api } from '../api.js';

/**
 * Sign-in for the invoice app. It posts to /api/auth/login, which issues the same
 * wildcard `.preyone.com` session the portal uses -- so a visitor who is already
 * signed in on admin.preyone.com lands straight in here without typing anything.
 */
export default function Login({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const { user } = await api.auth.login(email.trim(), password);
      onSignedIn(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <img className="login-logo" src="/brand/Preyone.svg" alt="Preyone enterprise" />
        <h1 className="login-title">Invoice &amp; Quotation</h1>
        <p className="login-sub">Sign in with your Preyone enterprise account.</p>

        <label className="login-label" htmlFor="login-email">
          Email
        </label>
        <input
          id="login-email"
          className="login-input"
          type="email"
          autoComplete="username"
          autoFocus
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label className="login-label" htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          className="login-input"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && <p className="login-error">{error}</p>}

        <button className="btn primary login-submit" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
