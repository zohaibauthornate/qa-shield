# 🛡️ QA Shield

**Automated QA lifecycle platform for Creator.fun**

QA Shield automates the entire QA workflow — from ticket enrichment to fix verification, security scanning, and performance benchmarking against competitors.

---

## How It Works

```
Ticket Created → AI Enriches → Dev Fixes → AI Verifies → Done/Rejected
```

### Phase 1: Ticket Enrichment
When a Linear ticket is created or moves to review, QA Shield analyzes it and posts a structured comment with:
- **Classification** — UI / Backend / API / Mixed
- **Priority & severity** recommendation with reasoning
- **Root cause analysis** — what caused the issue and which component
- **Scope & impact** — affected pages, components, and API endpoints
- **Test cases** — step-by-step verification steps (must / should / nice priority)
- **Edge cases** — tricky scenarios devs might miss
- **Impacted areas** — other pages/components that could break from this change
- **Responsiveness checklist** — mobile, tablet, desktop breakpoints
- **Security checks** — auth, CORS, data exposure risks
- **Performance benchmarks** — thresholds vs axiom.trade & pump.fun

### Phase 2: Dev Fixes
Devs work with crystal-clear scope — no guessing what to test, what might break, or what the acceptance criteria are.

### Phase 3: AI Verification
When the fix is ready, QA Shield runs:
- ✅ Functional verification against all test cases
- 🔒 Security scan (CORS, auth gaps, data exposure, missing headers)
- ⚡ Performance benchmark against axiom.trade & pump.fun
- 📱 Responsiveness validation

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                Chrome Extension (MV3)                │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Linear       │  │ Staging      │  │ Popup      │ │
│  │ Sidebar      │  │ Widget       │  │ Dashboard  │ │
│  │ - Enrich     │  │ - Screenshot │  │ - Health   │ │
│  │ - Verify     │  │ - Errors     │  │ - Stats    │ │
│  │ - Scan       │  │ - Scan       │  │ - Actions  │ │
│  │ - Benchmark  │  │ - Health     │  │            │ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘ │
│         └──────────────────┼────────────────┘        │
└────────────────────────────┼─────────────────────────┘
                             │ HTTP
                    ┌────────▼────────┐
                    │  Backend (Next.js)│
                    │                  │
                    │  /api/enrich     │──→ Linear API (GraphQL)
                    │  /api/verify     │──→ Claude AI (Anthropic)
                    │  /api/security   │──→ Staging APIs
                    │  /api/monitor    │──→ Competitor URLs
                    └──────────────────┘
```

---

## Quick Start

### Prerequisites
- Node.js 18+
- Chrome browser
- Anthropic API key (for AI enrichment)
- Linear API key (for ticket integration)

### 1. Backend Setup

```bash
cd backend
cp .env.example .env.local
# Edit .env.local with your API keys
npm install
npm run dev
```

Backend runs at `http://localhost:3000`

### 2. Chrome Extension Setup

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. QA Shield icon appears in your toolbar

### 3. Environment Variables

```env
# Required
LINEAR_API_KEY=lin_api_xxx          # Linear API token
LINEAR_TEAM_ID=xxx                   # Linear team UUID
ANTHROPIC_API_KEY=sk-ant-xxx         # Anthropic API key for Claude

# Staging
STAGING_URL=https://dev.creator.fun
STAGING_API_URL=https://dev.bep.creator.fun

# Competitors (for benchmarking)
COMPETITOR_URLS=https://axiom.trade,https://pump.fun
```

---

## API Endpoints

### `POST /api/enrich`
AI-enriches a Linear ticket and optionally posts the analysis as a comment.

```bash
curl -X POST http://localhost:3000/api/enrich \
  -H "Content-Type: application/json" \
  -d '{"identifier": "CRX-834", "postComment": true}'
```

**Response:**
```json
{
  "success": true,
  "identifier": "CRX-834",
  "enrichment": {
    "issueType": "backend",
    "priorityRecommendation": { "level": "urgent", "reasoning": "..." },
    "rootCause": { "summary": "...", "causedBy": "...", "category": "..." },
    "scope": { "affectedPages": [...], "affectedEndpoints": [...] },
    "impact": { "severity": "critical", "securityImpact": true },
    "testCases": [...],
    "edgeCases": [...],
    "securityChecks": [...],
    "performanceBenchmarks": [...]
  },
  "commentPosted": true
}
```

### `POST /api/security/scan`
Scans API endpoints for security vulnerabilities.

```bash
curl -X POST http://localhost:3000/api/security/scan \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Checks performed:**
- CORS policy validation (origin reflection, credentials)
- Authentication gaps (unauthenticated access to protected data)
- Security headers (HSTS, X-Content-Type-Options, X-Frame-Options)
- Data exposure (sensitive patterns in responses)

### `GET /api/monitor/health`
Quick health check of all staging API endpoints.

```bash
curl http://localhost:3000/api/monitor/health
```

### `GET /api/monitor/health?mode=benchmark`
Comparative performance benchmark against competitors.

```bash
curl "http://localhost:3000/api/monitor/health?mode=benchmark"
```

**Benchmarks against:**
- axiom.trade — response times, TTFB
- pump.fun — response times, TTFB

---

## Chrome Extension Usage

### On Linear (linear.app/creatorfun/*)

When you open any CRX ticket, a sidebar appears with 4 actions:

| Button | What it does |
|--------|-------------|
| 🔍 **Enrich Ticket** | AI analyzes the ticket → generates test cases, scope, edge cases → posts to Linear comment |
| ✅ **Verify Fix** | Runs all test cases + security scan + performance benchmark |
| 🔒 **Security Scan** | Scans all API endpoints for vulnerabilities |
| ⚡ **Benchmark** | Compares our performance against axiom.trade & pump.fun |

### On Staging (dev.creator.fun)

A floating 🛡️ button appears with:

| Button | What it does |
|--------|-------------|
| 📸 **Capture Screenshot** | Takes a full-page screenshot for bug reports |
| 🐛 **Console Errors** | Shows captured console errors with timestamps |
| 🔒 **Quick Security Scan** | Runs security scan on all default endpoints |
| ⚡ **Health Check** | Checks API health and response times |

### Popup Dashboard

Click the QA Shield icon in the toolbar to see:
- Scan/enrichment/issue counts
- System health status
- Quick action buttons
- Backend URL configuration

---

## What Gets Posted to Linear

When you click "Enrich Ticket", a structured comment is posted directly on the Linear ticket:

```markdown
## 🛡️ QA Shield — Ticket Enrichment

### 📋 Classification
- Type: BACKEND
- Priority: URGENT — Critical security vulnerability...
- Severity: CRITICAL
- Security impact: 🔴 Yes

### 🔍 Root Cause
- Caused by: Backend API CORS configuration
- Category: Security misconfiguration

### ✅ Test Cases
🔴 TC-1: Verify CORS origin reflection [MUST]
1. Send request with malicious Origin header
2. Check response headers
Expected: Origin should NOT be reflected

### ⚡ Edge Cases
[HIGH] Subdomain bypass attempt using creator.fun subdomains

### 🗺️ Impacted Areas (Regression Check)
⚠️ Trading dashboard → API calls: All authenticated requests vulnerable

### 🔒 Security Checks
🔴 [CORS] /api/*: Verify origin allowlist is enforced

### ⚡ Performance Benchmarks
| Metric | Competitor | Threshold |
|--------|-----------|-----------|
| API response | axiom.trade | Under 500ms |
```

This means **every dev sees the full QA analysis**, even without the extension installed.

---

## Project Structure

```
qa-shield/
├── backend/                    # Next.js API server
│   ├── src/
│   │   ├── app/api/
│   │   │   ├── enrich/         # Ticket enrichment endpoint
│   │   │   ├── security/scan/  # Security scanning endpoint
│   │   │   └── monitor/health/ # Health & benchmark endpoint
│   │   └── lib/
│   │       ├── linear.ts       # Linear GraphQL client
│   │       ├── ai.ts           # AI enrichment engine + prompt
│   │       └── scanner.ts      # Security scanner & benchmarker
│   ├── .env.example
│   └── package.json
├── extension/                  # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── content/
│   │   ├── linear.js + .css    # Linear sidebar overlay
│   │   └── staging.js + .css   # Staging site widget
│   ├── popup/
│   │   ├── popup.html + .js    # Extension popup dashboard
│   └── background/
│       └── worker.js           # Service worker
└── README.md
```

---

## Roadmap

- [x] AI ticket enrichment with Claude
- [x] Enrichment posted as Linear comments
- [x] Security scanner (CORS, auth, headers, data exposure)
- [x] Performance benchmarking vs competitors
- [x] Chrome extension with Linear sidebar
- [x] Staging site QA widget
- [ ] Linear webhooks for auto-enrichment on ticket creation
- [ ] Visual regression testing (before/after screenshots)
- [ ] Automated verification when tickets move to "In Review"
- [ ] Deploy backend to Vercel
- [ ] Publish extension to Chrome Web Store
- [ ] Slack integration for scan alerts
- [ ] Historical tracking dashboard

---

## Team

Built by the Creator.fun QA team to automate the development lifecycle and make everyone's life easier.

**Stack:** Next.js · TypeScript · Claude AI · Chrome Extension MV3 · Linear GraphQL API

---

*QA Shield 🛡️ — Nothing broken reaches production.*
