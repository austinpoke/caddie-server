/**
 * routes/ghin.js
 * ──────────────────────────────────────────────────────────────────────────
 * Proxy routes between Caddie app and GHIN API.
 *
 * Routes:
 *   POST /api/ghin/login          — authenticate, returns token + golfer state
 *   GET  /api/ghin/search         — search golfers by name or GHIN (state-scoped)
 *   GET  /api/ghin/golfer/:ghin   — fetch single golfer
 *   GET  /api/ghin/health         — token validity check
 */

const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

const GHIN_BASE = process.env.GHIN_API_BASE || 'https://api.ghin.com/api/v1';

// Helper: fetch from GHIN and parse JSON
async function ghinFetch(url, options = {}) {
  const res  = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); }
  catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

// Helper: extract Bearer token from Authorization header
function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// Helper: normalize a raw GHIN golfer object into a consistent shape
function normalizeGolfer(g) {
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

// ── POST /api/ghin/login ────────────────────────────────────────────────────
// Body: { email_or_ghin, password }
// Returns: { token, golfer, state }
//   state is auto-detected from the logged-in golfer's profile
//   and returned so the client can use it to scope future searches
router.post('/login', async (req, res, next) => {
  try {
    const { email_or_ghin, password } = req.body;
    if (!email_or_ghin || !password) {
      return res.status(400).json({ error: true, message: 'email_or_ghin and password are required' });
    }

    const { ok, status, body } = await ghinFetch(
      `${GHIN_BASE}/golfer_login.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          user: { email_or_ghin, password, remember_me: 'true' },
          token: '123'
        })
      }
    );

    if (!ok) {
      console.warn(`GHIN login failed (HTTP ${status}):`, JSON.stringify(body));
      return res.status(401).json({ error: true, message: 'GHIN authentication failed. Check your credentials.', ghin_status: status });
    }

    const token  = body?.golfer_user?.golfer_user_token;
    const golfer = body?.golfer_user?.golfers?.[0] || null;

    if (!token) {
      console.warn('GHIN returned ok but no token:', JSON.stringify(body));
      return res.status(401).json({ error: true, message: 'GHIN did not return a token.' });
    }

    // Auto-detect state from the logged-in golfer's profile
    const state = golfer?.State || golfer?.state || '';
    console.log(`Login success — golfer state: "${state}"`);

    return res.json({
      token,
      state,  // returned so client can scope all future searches to this state
      golfer: golfer ? normalizeGolfer(golfer) : null
    });

  } catch (err) {
    err.detail = 'Error contacting GHIN login endpoint';
    next(err);
  }
});

// ── GET /api/ghin/search ────────────────────────────────────────────────────
// Query params:
//   ?q=John Smith    — name or GHIN number
//   ?state=CA        — state code (auto-passed by client after login)
//   ?per_page=8      — max results (default 8, max 20)
// Header: Authorization: Bearer <token>
router.get('/search', async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: true, message: 'Authorization token required' });
    }

    const q        = (req.query.q || '').trim();
    const state    = (req.query.state || '').trim().toUpperCase();
    const per_page = Math.min(parseInt(req.query.per_page) || 10, 20);

    if (!q) {
      return res.status(400).json({ error: true, message: 'Query parameter ?q is required' });
    }

    // Build GHIN search params
    const params = new URLSearchParams({
      per_page,
      page: 1,
      status: 'Active',
      sorting_criteria: 'last_name',
      order: 'ASC'
    });

    // Scope to state when available — greatly improves result relevance
    if (state) {
      params.set('state', state);
    }

    const isGhinNumber = /^\d+$/.test(q);
    if (isGhinNumber) {
      params.set('golfer_id', q);
      params.set('sorting_criteria', 'id');
      params.delete('state'); // GHIN number search doesn't need state
    } else {
      const parts    = q.split(/\s+/);
      const lastName = parts[parts.length - 1];
      const firstName = parts.length > 1 ? parts[0] : '';
      params.set('last_name', lastName);
      if (firstName) params.set('first_name', firstName);
    }

    console.log(`GHIN search: "${q}" state="${state}" → ${GHIN_BASE}/golfers/search.json?${params}`);

    const { ok, status, body } = await ghinFetch(
      `${GHIN_BASE}/golfers/search.json?${params.toString()}`,
      { headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` } }
    );

    if (!ok) {
      if (status === 401) {
        return res.status(401).json({ error: true, message: 'GHIN token expired. Please log in again.' });
      }
      return res.status(status).json({ error: true, message: 'GHIN search failed', ghin_status: status });
    }

    const golfers = (body?.golfers || []).map(normalizeGolfer);
    console.log(`GHIN search returned ${golfers.length} results`);
    return res.json({ golfers });

  } catch (err) {
    err.detail = 'Error contacting GHIN search endpoint';
    next(err);
  }
});

// ── GET /api/ghin/golfer/:ghinNumber ────────────────────────────────────────
// Fetch a single golfer by GHIN number.
// Header: Authorization: Bearer <token>
router.get('/golfer/:ghinNumber', async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: true, message: 'Authorization token required' });

    const { ghinNumber } = req.params;
    if (!/^\d+$/.test(ghinNumber)) {
      return res.status(400).json({ error: true, message: 'Invalid GHIN number format' });
    }

    const params = new URLSearchParams({ per_page: 1, page: 1, golfer_id: ghinNumber, status: 'Active' });
    const { ok, status, body } = await ghinFetch(
      `${GHIN_BASE}/golfers/search.json?${params.toString()}`,
      { headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` } }
    );

    if (!ok) {
      if (status === 401) return res.status(401).json({ error: true, message: 'GHIN token expired.' });
      return res.status(status).json({ error: true, message: 'Golfer lookup failed' });
    }

    const golfer = body?.golfers?.[0];
    if (!golfer) return res.status(404).json({ error: true, message: `No active golfer found with GHIN ${ghinNumber}` });
    return res.json({ golfer: normalizeGolfer(golfer) });

  } catch (err) {
    err.detail = 'Error fetching golfer from GHIN';
    next(err);
  }
});

// ── GET /api/ghin/health ─────────────────────────────────────────────────────
// Token validity check. Header: Authorization: Bearer <token>
router.get('/health', async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return res.json({ valid: false, message: 'No token provided' });

    const { ok, status } = await ghinFetch(
      `${GHIN_BASE}/golfers/search.json?per_page=1&page=1&last_name=Smith&status=Active`,
      { headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` } }
    );

    if (ok) return res.json({ valid: true });
    if (status === 401) return res.json({ valid: false, message: 'Token expired' });
    return res.json({ valid: false, message: `GHIN returned ${status}` });

  } catch (err) {
    err.detail = 'Error checking token health';
    next(err);
  }
});

module.exports = router;
