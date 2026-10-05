/**
 * The session lives in the httpOnly `.preyone.com` SSO cookie, so every call is
 * same-origin and must send credentials. The token is deliberately never read
 * from JS — the cookie is the only copy.
 */
async function req(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    // Cookie expired or was cleared elsewhere: drop back to the sign-in screen
    // instead of leaving a half-broken app on screen.
    window.dispatchEvent(new CustomEvent('preyone:signed-out'));
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Please sign in again');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  auth: {
    me: () => req('/auth/me'),
    login: (email, password) => req('/auth/login', { method: 'POST', body: { email, password } }),
    logout: () => req('/auth/logout', { method: 'POST' })
  },
  settings: {
    get: () => req('/settings'),
    save: (patch) => req('/settings', { method: 'PUT', body: patch })
  },
  clients: {
    list: () => req('/clients'),
    create: (c) => req('/clients', { method: 'POST', body: c }),
    update: (id, patch) => req(`/clients/${id}`, { method: 'PUT', body: patch }),
    remove: (id) => req(`/clients/${id}`, { method: 'DELETE' })
  },
  items: {
    list: () => req('/items'),
    create: (item) => req('/items', { method: 'POST', body: item }),
    update: (id, patch) => req(`/items/${id}`, { method: 'PUT', body: patch }),
    remove: (id) => req(`/items/${id}`, { method: 'DELETE' })
  },
  documents: {
    list: (params = {}) => {
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
      return req(`/documents${qs ? `?${qs}` : ''}`);
    },
    get: (id) => req(`/documents/${id}`),
    create: (data) => req('/documents', { method: 'POST', body: data }),
    update: (id, patch) => req(`/documents/${id}`, { method: 'PUT', body: patch }),
    duplicate: (id) => req(`/documents/${id}/duplicate`, { method: 'POST' }),
    pdfUrl: (id) => `/api/documents/${id}/pdf`,
    remove: (id) => req(`/documents/${id}`, { method: 'DELETE' })
  }
};
