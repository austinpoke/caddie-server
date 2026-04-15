/**
 * routes/ghin.js
 * Proxy routes between Caddie app and GHIN API.
 *
 * POST /api/ghin/login        - authenticate, returns token + state
 * GET  /api/ghin/search       - search golfers by name or GHIN (state-scoped)
 * GET  /api/ghin/golfer/:ghin - fetch single golfer
 * GET  /api/ghin/health       - token validity check
 */

const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

const GHIN_BASE = process.env.GHIN_API_BASE || 'https://api.ghin.com/api/v1';

// Fetch from GHIN and parse JSON
async function ghinFetch(url, options) {
  options = options || {};
  var res  = await fetch(url, options);
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

// Normalize a raw GHIN golfer object
function normalizeGolfer(g) {
  var firstName = g.FirstName  || g.first_name  || '';
  var lastName  = g.LastName   || g.last_name   || '';
  var fullName  = g.player_name || (firstName + ' ' + lastName).trim();
  var hcp = parseFloat(g.handicap_index !== undefined ? g.handicap_index : (g.HandicapIndex !== undefined ? g.HandicapIndex : 0));
  return {
    name:             fullName,
    first_name:       firstName,
    last_name:        lastName,
    ghin:             String(g.ghin || g.GhinNumber || g.ghin_number || g.id || ''),
    handicap_index:   hcp,
    club_name:        g.club_name  || g.ClubName  || '',
    association_name: g.golf_association_name || g.association_name || '',
    state:            g.primary_club_state || g.State || g.state || '',
    status:           g.Status || g.status || 'Active',
    low_hi:           g.low_hi_display || g.low_hi || null,
    revision_date:    g.hi_last_revised || null
  };
}

// POST /api/ghin/login
// Body: { email_or_ghin, password }
// Returns: { token, state, golfer }
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          user: { email_or_ghin: email_or_ghin, password: password, remember_me: 'true' },
          token: '123'
        })
      }
    );

    if (!result.ok) {
      console.warn('GHIN login failed HTTP ' + result.status + ': ' + JSON.stringify(result.body));
      return res.status(401).json({ error: true, message: 'GHIN authentication failed. Check your credentials.' });
    }

    var golfer_user = result.body && result.body.golfer_user ? result.body.golfer_user : null;
    var token  = golfer_user ? golfer_user.golfer_user_token : null;
    var golfer = golfer_user && golfer_user.golfers && golfer_user.golfers.length > 0 ? golfer_user.golfers[0] : null;

    if (!token) {
      return res.status(401).json({ error: true, message: 'GHIN did not return a token.' });
    }

    // State field confirmed as primary_club_state
    // Extract state and association info from golfer profile
    var state          = '';
    var association_id = '';
    if (golfer) {
      state          = golfer.primary_club_state || golfer.State || golfer.state || '';
      association_id = golfer.primary_golf_association_id || golfer.golf_association_id || '';
    }

    console.log('Login success - state: "' + state + '" assoc_id: "' + association_id + '"');

    return res.json({
      token:          token,
      state:          state,
      association_id: String(association_id),
      golfer:         golfer ? normalizeGolfer(golfer) : null
    });

  } catch (err) {
    err.detail = 'Error contacting GHIN login endpoint';
    next(err);
  }
});

// GET /api/ghin/search
// Query: ?q=name or GHIN, ?state=CA, ?per_page=10
// Header: Authorization: Bearer <token>
router.get('/search', async function(req, res, next) {
  try {
    var token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: true, message: 'Authorization token required' });
    }

    var q        = (req.query.q || '').trim();
    var state    = (req.query.state || '').trim().toUpperCase();
    var per_page = Math.min(parseInt(req.query.per_page) || 10, 20);

    if (!q) {
      return res.status(400).json({ error: true, message: 'Query parameter ?q is required' });
    }

    // Also accept association_id for tighter scoping
    var association_id = (req.query.association_id || '').trim();

    var params = new URLSearchParams({
      per_page: per_page,
      page: 1,
      status: 'Active',
      sorting_criteria: 'last_name',
      order: 'ASC'
    });

    var isGhinNumber = /^\d+$/.test(q);
    if (isGhinNumber) {
      // GHIN number search â no filters needed
      params.set('golfer_id', q);
      params.set('sorting_criteria', 'id');
    } else {
      var parts     = q.split(/\s+/);
      var lastName  = parts[parts.length - 1];
      var firstName = parts.length > 1 ? parts[0] : '';
      params.set('last_name', lastName);
      if (firstName) params.set('first_name', firstName);

      // Scope by association_id (more reliable than state code in GHIN API)
      if (association_id) {
        params.set('golf_association_id', association_id);
      }
    }

    var searchUrl = GHIN_BASE + '/golfers/search.json?' + params.toString();
    console.log('GHIN search URL: ' + searchUrl);

    var result = await ghinFetch(
      GHIN_BASE + '/golfers/search.json?' + params.toString(),
      { headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token } }
    );

    if (!result.ok) {
      if (result.status === 401) {
        return res.status(401).json({ error: true, message: 'GHIN token expired. Please log in again.' });
      }
      return res.status(result.status).json({ error: true, message: 'GHIN search failed' });
    }

    var golfers = (result.body && result.body.golfers ? result.body.golfers : []).map(normalizeGolfer);
    console.log('GHIN search returned ' + golfers.length + ' results');
    return res.json({ golfers: golfers });

  } catch (err) {
    err.detail = 'Error contacting GHIN search endpoint';
    next(err);
  }
});

// GET /api/ghin/golfer/:ghinNumber
router.get('/golfer/:ghinNumber', async function(req, res, next) {
  try {
    var token = extractToken(req);
    if (!token) return res.status(401).json({ error: true, message: 'Authorization token required' });

    var ghinNumber = req.params.ghinNumber;
    if (!/^\d+$/.test(ghinNumber)) {
      return res.status(400).json({ error: true, message: 'Invalid GHIN number format' });
    }

    var params = new URLSearchParams({ per_page: 1, page: 1, golfer_id: ghinNumber, status: 'Active' });
    var result = await ghinFetch(
      GHIN_BASE + '/golfers/search.json?' + params.toString(),
      { headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token } }
    );

    if (!result.ok) {
      if (result.status === 401) return res.status(401).json({ error: true, message: 'GHIN token expired.' });
      return res.status(result.status).json({ error: true, message: 'Golfer lookup failed' });
    }

    var golfer = result.body && result.body.golfers && result.body.golfers.length > 0 ? result.body.golfers[0] : null;
    if (!golfer) return res.status(404).json({ error: true, message: 'No active golfer found with GHIN ' + ghinNumber });
    return res.json({ golfer: normalizeGolfer(golfer) });

  } catch (err) {
    err.detail = 'Error fetching golfer from GHIN';
    next(err);
  }
});

// GET /api/ghin/health
router.get('/health', async function(req, res, next) {
  try {
    var token = extractToken(req);
    if (!token) return res.json({ valid: false, message: 'No token provided' });

    var result = await ghinFetch(
      GHIN_BASE + '/golfers/search.json?per_page=1&page=1&last_name=Smith&status=Active',
      { headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + token } }
    );

    if (result.ok) return res.json({ valid: true });
    if (result.status === 401) return res.json({ valid: false, message: 'Token expired' });
    return res.json({ valid: false, message: 'GHIN returned ' + result.status });

  } catch (err) {
    err.detail = 'Error checking token health';
    next(err);
  }
});

module.exports = router;