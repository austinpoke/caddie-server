**
 * routes/ghin.js — GHIN API proxy for Caddie
 *
 * POST /api/ghin/login        - authenticate with GHIN
 * GET  /api/ghin/search       - search golfers by name or GHIN number  
 * GET  /api/ghin/golfer/:id   - fetch single golfer
 * GET  /api/ghin/health       - token validity check
 */

const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

const GHIN_BASE = process.env.GHIN_API_BASE || 'https://api.ghin.com/api/v1';

// Fetch from GHIN and parse response
async function ghinFetch(url, options) {
  var res  = await fetch(url, options || {});
  var text = await res.text();
  var body;
  try { body = JSON.parse(text); }
  catch (e) { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body: body };
}

// Extract Bearer token from Authorization header
function extractToken(req) {
  var auth = req.headers['authorization'] || '';
  return auth.indexOf('Bearer ') === 0 ? auth.slice(7) : null;
}

// Normalize golfer object to consistent shape
function normalizeGolfer(g) {
  var firstName = g.FirstName  || g.first_name  || '';
  var lastName  = g.LastName   || g.last_name   || '';
  var fullName  = g.player_name || (firstName + ' ' + lastName).trim();
  var hcp = 0;
  if (g.handicap_index !== undefined && g.handicap_index !== null) hcp = parseFloat(g.handicap_index);
  else if (g.HandicapIndex !== undefined && g.HandicapIndex !== null) hcp = parseFloat(g.HandicapIndex);
  return {
    name:           fullName,
    first_name:     firstName,
    last_name:      lastName,
    ghin:           String(g.ghin || g.ghin_number || g.GhinNumber || g.id || ''),
    handicap_index: hcp,
    club_name:      g.club_name  || g.ClubName  || '',
    state:          g.primary_club_state || g.State || g.state || '',
    low_hi:         g.low_hi_display || g.low_hi || null,
    revision_date:  g.rev_date || g.hi_last_revised || null
  };
}

// ── POST /api/ghin/login ────────────────────────────────────────────────────
router.post('/login', async function(req, res, next) {
  try {
    var email_or_ghin = req.body.email_or_ghin;
    var password      = req.body.password;

    if (!email_or_ghin || !password) {
      return res.status(400).json({ error: true, message: 'email_or_ghin and password are required' });
    }

    var result = await ghinFetch(
      GHIN_BASE + '/golfer_login.json',
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body:    JSON.stringify({
          user:  { email_or_ghin: email_or_ghin, password: password, remember_me: 'true' },
          token: '123'
        })
      }
    );

    if (!result.ok) {
      console.warn('GHIN login failed HTTP ' + result.status + ': ' + JSON.stringify(result.body));
      return res.status(401).json({ error: true, message: 'GHIN authentication failed. Check your credentials.' });
    }

    var gu     = result.body && result.body.golfer_user ? result.body.golfer_user : null;
    var token  = gu ? gu.golfer_user_token : null;
    var golfer = gu && gu.golfers && gu.golfers.length > 0 ? gu.golfers[0] : null;

    if (!token) {
      console.warn('No token in GHIN response: ' + JSON.stringify(result.body));
      return res.status(401).json({ error: true, message: 'GHIN did not return a token.' });
    }

    var state = golfer ? (golfer.primary_club_state || golfer.State || golfer.state || '') : '';
    var assoc_id = golfer ? String(golfer.primary_golf_association_id || '') : '';

    console.log('GHIN login OK - state: ' + state + ' assoc_id: ' + assoc_id);

    return res.json({
      token:          token,
      state:          state,
      association_id: assoc_id,
      golfer:         golfer ? normalizeGolfer(golfer) : null
    });

  } catch (err) {
    console.error('Login exception: ' + err.message);
    next(err);
  }
});

// ── GET /api/ghin/search ────────────────────────────────────────────────────
// Query: ?q=name or GHIN number, ?per_page=10
// Header: Authorization: Bearer <token>
router.get('/search', async function(req, res, next) {
  try {
    var token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: true, message: 'Authorization token required' });
    }

    var q        = (req.query.q || '').trim();
    var per_page = Math.min(parseInt(req.query.per_page) || 10, 20);

    if (!q) {
      return res.status(400).json({ error: true, message: 'Query parameter ?q is required' });
    }

    var params = new URLSearchParams();
    params.set('per_page', per_page);
    params.set('page', '1');
    params.set('status', 'Active');

    // GHIN requires: last_name + state, OR last_name + country, OR association_id, OR club_id
    var state        = (req.query.state || '').trim();
    var association_id = (req.query.association_id || '').trim();

    var isGhinNumber = /^\d+$/.test(q);
    if (isGhinNumber) {
      params.set('golfer_id', q);
    } else {
      var parts     = q.split(/\s+/);
      var lastName  = parts[parts.length - 1];
      var firstName = parts.length > 1 ? parts[0] : '';
      params.set('last_name', lastName);
      if (firstName) params.set('first_name', firstName);

      // Add required scope — use association_id if available, otherwise state
      if (association_id) {
        params.set('association_id', association_id);
      } else if (state) {
        params.set('state', state);
      } else {
        // Fallback to country if neither available
        params.set('country', 'US');
      }
    }

    var searchUrl = GHIN_BASE + '/golfers/search.json?' + params.toString();
    console.log('GHIN search: ' + searchUrl);

    var result = await ghinFetch(searchUrl, {
      headers: {
        'Accept':        'application/json',
        'Authorization': 'Bearer ' + token
      }
    });

    if (!result.ok) {
      console.error('GHIN search HTTP ' + result.status + ' body: ' + JSON.stringify(result.body));
      if (result.status === 401) {
        return res.status(401).json({ error: true, message: 'GHIN token expired. Please log in again.' });
      }
      return res.status(result.status).json({
        error:      true,
        message:    'GHIN search failed (HTTP ' + result.status + ')',
        ghin_error: result.body
      });
    }

    var golfers = (result.body && result.body.golfers ? result.body.golfers : []).map(normalizeGolfer);
    console.log('GHIN search returned ' + golfers.length + ' golfers');
    return res.json({ golfers: golfers });

  } catch (err) {
    console.error('Search exception: ' + err.message);
    next(err);
  }
});

// ── GET /api/ghin/golfer/:ghinNumber ────────────────────────────────────────
router.get('/golfer/:ghinNumber', async function(req, res, next) {
  try {
    var token = extractToken(req);
    if (!token) return res.status(401).json({ error: true, message: 'Authorization token required' });

    var ghinNumber = req.params.ghinNumber;
    if (!/^\d+$/.test(ghinNumber)) {
      return res.status(400).json({ error: true, message: 'Invalid GHIN number' });
    }

    var url = GHIN_BASE + '/golfers/search.json?per_page=1&page=1&golfer_id=' + ghinNumber + '&status=Active';
    var result = await ghinFetch(url, {
      headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token }
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: true, message: 'Golfer lookup failed' });
    }

    var golfer = result.body && result.body.golfers && result.body.golfers.length > 0 ? result.body.golfers[0] : null;
    if (!golfer) return res.status(404).json({ error: true, message: 'Golfer not found: ' + ghinNumber });
    return res.json({ golfer: normalizeGolfer(golfer) });

  } catch (err) {
    next(err);
  }
});

// ── GET /api/ghin/health ─────────────────────────────────────────────────────
router.get('/health', async function(req, res, next) {
  try {
    var token = extractToken(req);
    if (!token) return res.json({ valid: false, message: 'No token' });

    var url = GHIN_BASE + '/golfers/search.json?per_page=1&page=1&last_name=Smith&status=Active';
    var result = await ghinFetch(url, {
      headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token }
    });

    if (result.ok)            return res.json({ valid: true });
    if (result.status === 401) return res.json({ valid: false, message: 'Token expired' });
    return res.json({ valid: false, message: 'GHIN returned ' + result.status });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
