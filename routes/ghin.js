/**
 * routes/ghin.js
 * ──────────────────────────────────────────────────────────────────────────
 * Proxy routes that sit between the Caddie web/iOS client and the GHIN API.
 * All GHIN requests are made server-side to avoid CORS restrictions.
 *
 * Routes:
 *   POST /api/ghin/login          — authenticate with GHIN, return token
 *   GET  /api/ghin/search         — search golfers by name or GHIN number
 *   GET  /api/ghin/golfer/:ghin   — fetch a single golfer by GHIN number
 *   GET  /api/ghin/health         — verify a stored token is still valid
 */

const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

const GHIN_BASE = process.env.GHIN_API_BASE || 'https://api.ghin.com/api/v1';

// ── Helper: forward errors from GHIN as structured responses ────────────────
async function ghinFetch(url, options = {}) {
  const res  = await fetch(url, options);
  const text = await res.text();

  let body;
  try { body = JSON.parse(text); }
  catch { body = { raw: text }; }

  return { ok: res.ok, status: res.status, body };
}

// ── POST /api/ghin/login ────────────────────────────────────────────────────
//
// Request body:
//   { "email_or_ghin": "...", "password": "..." }
//
// Response (success):
//   { "token": "...", "golfer": { player_name, ghin, handicap_index, club_name, ... } }
//
// Response (failure):
//   { "error": true, "message": "..." }
//
router.post('/login', async (req, res, next) => {
  try {
    const { email_or_ghin, password } = req.body;

    if (!email_or_ghin || !password) {
      return res.status(400).json({
        error: true,
        message: 'email_or_ghin and password are required'
      });
    }

    const { ok, status, body } = await ghinFetch(
      `${GHIN_BASE}/golfer_login.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept':        'application/json'
        },
        body: JSON.stringify({
          user: {
            email_or_ghin,
            password,
            remember_me: 'true'
          },
          token: '123'   // arbitrary value required by GHIN API
        })
      }
    );

    if (!ok) {
      console.warn(`GHIN login failed (HTTP ${status}):`, body);
      return res.status(401).json({
        error: true,
        message: 'GHIN authentication failed. Check your email/GHIN number and password.',
        ghin_status: status
      });
    }

    const token  = body?.golfer_user?.golfer_user_token;
    const golfer = body?.golfer_user?.golfers?.[0] || null;

    if (!token) {
      return res.status(401).json({
        error: true,
        message: 'GHIN did not return a token. Check your credentials.'
      });
    }

    // Return just what the client needs — never forward the raw GHIN response wholesale
    return res.json({
      token,
      golfer: golfer ? normalizeGolfer(golfer) : null
    });

  } catch (err) {
    err.detail = 'Error contacting GHIN login endpoint';
    next(err);
  }
});

// ── GET /api/ghin/search ────────────────────────────────────────────────────
//
// Query params (at least one required):
//   ?q=John Smith        — search by name (last name, or "first last")
//   ?q=1234567           — search by GHIN number
//   ?per_page=8          — results per page (default 8, max 20)
//
// Requires header:
//   Authorization: Bearer <token>
//
router.get('/search', async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: true, message: 'Authorization token required' });
    }

    const q        = (req.query.q || '').trim();
    const per_page = Math.min(parseInt(req.query.per_page) || 8, 20);

    if (!q) {
      return res.status(400).json({ error: true, message: 'Query parameter ?q is required' });
    }

    // Build GHIN search URL
    const params = new URLSearchParams({
      per_page,
      page: 1,
      status: 'Active',
      sorting_criteria: 'last_name',
      order: 'ASC'
    });

    const isGhinNumber = /^\d+$/.test(q);
    if (isGhinNumber) {
      params.set('golfer_id', q);
      params.set('sorting_criteria', 'id');
    } else {
      const parts     = q.split(/\s+/);
      const lastName  = parts[parts.length - 1];
      const firstName = parts.length > 1 ? parts[0] : '';
      params.set('last_name', lastName);
      if (firstName) params.set('first_name', firstName);
    }

    const { ok, status, body } = await ghinFetch(
      `${GHIN_BASE}/golfers/search.json?${params.toString()}`,
      {
        headers: {
          'Accept':        'application/json',
          'Authorization': `Bearer ${token}`
        }
      }
    );

    if (!ok) {
      if (status === 401) {
        return res.status(401).json({ error: true, message: 'GHIN token expired or invalid. Please log in again.' });
      }
      return res.status(status).json({ error: true, message: 'GHIN search failed', ghin_status: status });
    }

    const golfers = (body?.golfers || []).map(normalizeGolfer);
    return res.json({ golfers });

  } catch (err) {
    err.detail = 'Error contacting GHIN search endpoint';
    next(err);
  }
});

// ── GET /api/ghin/golfer/:ghinNumber ────────────────────────────────────────
//
// Fetch a single golfer by GHIN number.
// Requires header: Authorization: Bearer <token>
//
router.get('/golfer/:ghinNumber', async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: true, message: 'Authorization token required' });
    }

    const { ghinNumber } = req.params;
    if (!/^\d+$/.test(ghinNumber)) {
      return res.status(400).json({ error: true, message: 'Invalid GHIN number format' });
    }

    const params = new URLSearchParams({
      per_page: 1,
      page: 1,
      golfer_id: ghinNumber,
      status: 'Active'
    });

    const { ok, status, body } = await ghinFetch(
      `${GHIN_BASE}/golfers/search.json?${params.toString()}`,
      {
        headers: {
          'Accept':        'application/json',
          'Authorization': `Bearer ${token}`
        }
      }
    );

    if (!ok) {
      if (status === 401) {
        return res.status(401).json({ error: true, message: 'GHIN token expired. Please log in again.' });
      }
      return res.status(status).json({ error: true, message: 'Golfer lookup failed' });
    }

    const golfer = body?.golfers?.[0];
    if (!golfer) {
      return res.status(404).json({ error: true, message: `No active golfer found with GHIN ${ghinNumber}` });
    }

    return res.json({ golfer: normalizeGolfer(golfer) });

  } catch (err) {
    err.detail = 'Error fetching golfer from GHIN';
    next(err);
  }
});

// ── GET /api/ghin/health ─────────────────────────────────────────────────────
//
// Quick token validity check — tries a minimal search and returns ok/expired.
// Requires header: Authorization: Bearer <token>
//
router.get('/health', async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.json({ valid: false, message: 'No token provided' });
    }

    const { ok, status } = await ghinFetch(
      `${GHIN_BASE}/golfers/search.json?per_page=1&page=1&last_name=Smith&status=Active`,
      {
        headers: {
          'Accept':        'application/json',
          'Authorization': `Bearer ${token}`
        }
      }
    );

    if (ok) {
      return res.json({ valid: true });
    } else if (status === 401) {
      return res.json({ valid: false, message: 'Token expired' });
    } else {
      return res.json({ valid: false, message: `GHIN returned ${status}` });
    }

  } catch (err) {
    err.detail = 'Error checking token health';
    next(err);
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract Bearer token from Authorization header.
 */
function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/**
 * Normalize a raw GHIN golfer object into a consistent shape
 * that both the web app and iOS app can rely on.
 */
function normalizeGolfer(g) {
  // GHIN search.json uses snake_case; older endpoints use PascalCase
  const firstName = g.FirstName  || g.first_name  || '';
  const lastName  = g.LastName   || g.last_name   || '';
  const fullName  = g.player_name || `${firstName} ${lastName}`.trim();

  return {
    name:             fullName,
    first_name:       firstName,
    last_name:        lastName,
    ghin:             String(g.ghin || g.GhinNumber || g.ghin_number || g.id || ''),
    handicap_index:   parseFloat(g.handicap_index ?? g.HandicapIndex ?? 0),
    club_name:        g.club_name  || g.ClubName  || '',
    association_name: g.golf_association_name || g.association_name || '',
    state:            g.State || g.state || '',
    status:           g.Status || g.status || 'Active',
    low_hi:           g.low_hi_display || g.low_hi || null,
    revision_date:    g.hi_last_revised || null
  };
}

module.exports = router;
