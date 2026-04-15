# Caddie Server — GHIN API Proxy

A lightweight Node.js/Express backend that proxies requests between the **Caddie** golf pairing app (web and iOS) and the USGA GHIN API. It solves the browser CORS restriction and adds rate limiting, security headers, and a clean normalized API for clients.

---

## Why a proxy?

The GHIN API (`api.ghin.com`) does not allow direct browser requests — it blocks them via CORS policy. A server-side proxy is the standard solution: your app talks to **this server**, and this server talks to GHIN.

---

## Quick Start

### 1. Install dependencies
```bash
cd caddie-server
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env — set your PORT and ALLOWED_ORIGINS
```

### 3. Run
```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

The server starts on `http://localhost:3001` by default.

---

## API Endpoints

### `POST /api/ghin/login`
Authenticate with GHIN using a golfer's email and password.

**Request body:**
```json
{
  "email_or_ghin": "your@email.com",
  "password": "your_password"
}
```

**Success response:**
```json
{
  "token": "abc123...",
  "golfer": {
    "name": "John Smith",
    "ghin": "1234567",
    "handicap_index": 8.4,
    "club_name": "Pineview GC",
    "state": "CA"
  }
}
```

**Error response:**
```json
{
  "error": true,
  "message": "GHIN authentication failed. Check your email/GHIN number and password."
}
```

---

### `GET /api/ghin/search?q=<query>`
Search for golfers by name or GHIN number. Requires a Bearer token.

**Query params:**
| Param | Required | Description |
|-------|----------|-------------|
| `q` | ✅ | Name (e.g. `Smith` or `John Smith`) or GHIN number |
| `per_page` | ❌ | Results to return, max 20 (default 8) |

**Header:** `Authorization: Bearer <token>`

**Success response:**
```json
{
  "golfers": [
    {
      "name": "John Smith",
      "ghin": "1234567",
      "handicap_index": 8.4,
      "club_name": "Pineview GC",
      "low_hi": "6.2",
      "revision_date": "2026-04-01"
    }
  ]
}
```

---

### `GET /api/ghin/golfer/:ghinNumber`
Fetch a single golfer by GHIN number. Requires Bearer token.

---

### `GET /api/ghin/health`
Check if a token is still valid. Requires Bearer token.

```json
{ "valid": true }
```

---

### `GET /health`
Server health check — no auth required. Good for uptime monitoring.

```json
{
  "status": "ok",
  "service": "caddie-server",
  "version": "1.0.0",
  "timestamp": "2026-04-14T12:00:00.000Z"
}
```

---

## Deployment

This server can be deployed to any Node.js host. Recommended free/low-cost options:

| Platform | Notes |
|----------|-------|
| **Railway** | `railway up` — easiest, free tier available |
| **Render** | Free tier, auto-deploys from GitHub |
| **Fly.io** | `fly deploy` — generous free tier |
| **Heroku** | Classic option, paid plans only now |
| **Your own VPS** | Use PM2: `pm2 start server.js --name caddie` |

### Environment variables to set in production:
```
PORT=3001
ALLOWED_ORIGINS=https://yourcaddieapp.com,https://www.yourcaddieapp.com
GHIN_API_BASE=https://api.ghin.com/api/v1
SESSION_SECRET=<long random string>
```

---

## iOS App Integration

When building the Swift/SwiftUI iOS app, point all GHIN calls at this server instead of directly at `api.ghin.com`. Since iOS apps don't have CORS restrictions, you could call GHIN directly — but using this proxy keeps credentials off the device and gives you one centralized place to handle token refresh, caching, and rate limiting.

**Swift example:**
```swift
// Login
let url = URL(string: "https://yourserver.com/api/ghin/login")!
var request = URLRequest(url: url)
request.httpMethod = "POST"
request.setValue("application/json", forHTTPHeaderField: "Content-Type")
request.httpBody = try JSONEncoder().encode(["email_or_ghin": email, "password": password])

// Search
let searchURL = URL(string: "https://yourserver.com/api/ghin/search?q=\(query)")!
var searchRequest = URLRequest(url: searchURL)
searchRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
```

---

## Project Structure

```
caddie-server/
├── server.js              # Entry point — Express app setup
├── routes/
│   └── ghin.js            # All GHIN proxy routes
├── middleware/
│   ├── errorHandler.js    # Centralized error formatting
│   └── requestLogger.js   # Request/response logging
├── .env.example           # Environment variable template
├── package.json
└── README.md
```

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| `/api/ghin/login` | 10 requests per 15 min per IP |
| `/api/ghin/search` | 60 requests per min per IP |

---

## Security Notes

- Credentials are **never stored** on the server — only forwarded to GHIN and discarded
- GHIN tokens are held client-side (in memory, not localStorage)
- Helmet.js sets security headers on all responses
- CORS is locked to your specified `ALLOWED_ORIGINS`
