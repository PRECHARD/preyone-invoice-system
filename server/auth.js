import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { pool } from './store.js';

/**
 * Authentication for the Invoice & Quotation app.
 *
 * Sessions are the SAME tokens the Preyone portal issues: HS256 over
 * JWT_SECRET, carried in the wildcard `.preyone.com` cookie that
 * src/utils/ssoCookie.ts sets. Signing in here therefore works on
 * admin.preyone.com and invoice.preyone.com interchangeably, and
 * sharing JWT_SECRET with the portal is what makes that possible.
 *
 * Nothing here trusts the token payload for identity or scope. Every request
 * re-reads admin_users so a deactivated or deleted account loses access
 * immediately instead of when its 7-day token happens to expire.
 */

/** Kept in sync with src/utils/ssoCookie.ts. */
const PREYONE_COOKIE = 'preyone_token';
const SSO_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FIELD_STAFF_ROLES = ['CONDUCTOR', 'DRIVER', 'TICKET_SELLER'];

// NOTE: this must be 'production' on the server. When it is not, the session
// cookie is silently issued host-only and without Secure, which breaks SSO with
// the rest of *.preyone.com and allows the cookie over plain HTTP. The banner
// printed at boot makes that state obvious instead of silent.
const isProduction = process.env.NODE_ENV === 'production';

if (!isProduction) {
  console.warn(
    `[auth] NODE_ENV is "${process.env.NODE_ENV || 'unset'}". Session cookie will be host-only ` +
      'and without Secure. Set NODE_ENV=production when deploying behind HTTPS.'
  );
}

/** Fail closed: an unset secret must never fall back to the portal default. */
let cachedSecret;
export function getJwtSecret() {
  if (cachedSecret !== undefined) return cachedSecret;
  const secret = process.env.JWT_SECRET || '';
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. The invoice app signs the same tokens as the portal, so it must use the portal JWT_SECRET value.'
    );
  }
  if (secret === 'preyone-jwt-secret-change-in-production') {
    throw new Error('JWT_SECRET is still the insecure default. Set a strong shared secret before serving traffic.');
  }
  cachedSecret = secret;
  return secret;
}

export function setSessionCookie(res, token) {
  res.cookie(PREYONE_COOKIE, token, {
    domain: isProduction ? '.preyone.com' : undefined,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: SSO_COOKIE_MAX_AGE_MS,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(PREYONE_COOKIE, {
    domain: isProduction ? '.preyone.com' : undefined,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });
}

/** Authorization Bearer wins, then the wildcard SSO cookie. */
function resolveToken(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || undefined;
  return req.cookies?.[PREYONE_COOKIE] || undefined;
}

export function signSession(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, fullName: user.full_name, company_id: user.portal_company_id ?? null },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
}

/** Same shape the portal returns from /api/admin/auth/me, minus the SSO extras. */
function publicUser(row, permissions) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    companyId: row.portal_company_id ?? null,
    permissions,
  };
}

export async function loadPermissions(role, userId, companyId) {
  const params = [];
  const branches = [];
  const push = (sql, value) => {
    if (value === undefined || value === null || value === '') return;
    params.push(value);
    branches.push(sql(`$${params.length}`));
  };
  push((p) => `SELECT rp.permission_code FROM role_permissions rp WHERE rp.role = ${p}`, role);
  push((p) => `SELECT up.permission_code FROM user_permissions up WHERE up.user_id = ${p}`, userId);
  push((p) => `SELECT cp.permission_code FROM company_permissions cp WHERE cp.company_id = ${p}`, companyId);
  if (branches.length === 0) return [];
  const { rows } = await pool.query(branches.join(' UNION '), params);
  return rows.map((r) => r.permission_code);
}

/**
 * Reject anyone with no company to bill against, rather than falling back to
 * "the first company" the way the single-tenant era did. An operator with an
 * unbound account seeing no documents is the safe failure.
 */
export function requireCompanyScope(user) {
  if (!user.portal_company_id) {
    const err = new Error(
      'Your account is not assigned to a company, so no documents are visible. Ask a CEO or Manager to assign it.'
    );
    err.status = 403;
    throw err;
  }
  return user.portal_company_id;
}

export async function requireAuth(req, res, next) {
  const token = resolveToken(req);
  if (!token) {
    res.status(401).json({ error: 'Sign in to continue' });
    return;
  }
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone, role, approved, portal_company_id, company_id
         FROM admin_users WHERE id = $1`,
      [decoded.id]
    );
    const row = rows[0];
    if (!row) {
      res.status(401).json({ error: 'Account no longer exists' });
      return;
    }
    if (!row.approved) {
      res.status(403).json({ error: 'Your account is pending approval' });
      return;
    }
    if (FIELD_STAFF_ROLES.includes(row.role)) {
      res.status(403).json({ error: 'Field staff must use the Preyone Transit Mobile App.' });
      return;
    }
    const permissions = await loadPermissions(row.role, row.id, row.portal_company_id ?? null);
    req.user = {
      ...publicUser(row, permissions),
      portal_company_id: row.portal_company_id ?? null,
    };
    next();
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Session expired. Sign in again.' });
      return;
    }
    if (err && err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Sign in to continue' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Your role cannot perform this action' });
      return;
    }
    next();
  };
}

/**
 * Brute-force protection counts FAILED attempts only.
 *
 * The portal counts every request, which means ten successful sign-ins from one
 * office IP lock the whole office out for 15 minutes. Only failures are worth
 * throttling, so successful logins are skipped.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed attempts. Try again in 15 minutes.' },
});

export const auditLog = (user, action, targetType, targetId, detail) => {
  const text = `[invoice] ${action} by ${user?.email || 'unknown'}${targetId ? ` ${targetType}=${targetId}` : ''}${detail ? ` (${detail})` : ''}`;
  if (action === 'login_failed') console.warn(text);
  else console.log(text);
};
