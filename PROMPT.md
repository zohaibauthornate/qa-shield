# QA Shield 🛡️ — Build Spec

## What We're Building
A Chrome Extension + Next.js backend that automates the QA lifecycle for a Web3 development team.

## Architecture

### Chrome Extension (Manifest V3)
- **Content Script for Linear** (`linear.app/creatorfun/*`):
  - Injects a sidebar panel on issue pages
  - Shows AI-generated: test cases, edge cases, scope analysis, impacted areas, responsiveness checklist
  - "Verify Fix" button that triggers automated QA checks
  - Displays pass/fail verification results inline
  
- **Content Script for Staging** (`dev.creator.fun`):
  - Floating QA widget for quick visual checks
  - Screenshot capture with annotation
  - Console error capture
  - Network request monitoring
  
- **Popup**: Quick status dashboard, recent verifications, alerts
- **Background Service Worker**: Deploy monitoring, scheduled security scans

### Backend API (Next.js App Router)
- `/api/enrich` — Takes a Linear ticket ID, analyzes it with AI, returns:
  - Issue type classification (UI/Backend/API/Mixed)
  - Priority recommendation
  - Root cause analysis ("issues caused by")
  - Scope & impact analysis
  - Auto-generated test cases with steps
  - Edge cases to verify
  - Impacted areas (other pages/components that use the same code)
  - Responsiveness checklist
  
- `/api/verify` — Runs verification checks:
  - Takes ticket ID + staging URL
  - Runs through test cases
  - Screenshots key states
  - Reports pass/fail per test case
  
- `/api/security/scan` — Security scanning endpoint:
  - CORS policy validation
  - Auth gap detection
  - Exposed data checks
  
- `/api/monitor/health` — Degradation tracking:
  - API response times
  - Error rates
  - WebSocket health

## Tech Stack
- **Extension**: TypeScript, Manifest V3, React (for popup/sidebar UI)
- **Backend**: Next.js 14+ (App Router), TypeScript
- **AI**: OpenAI/Anthropic API for ticket enrichment
- **Database**: SQLite (via better-sqlite3) for local state tracking
- **Styling**: Tailwind CSS

## Linear Integration
- **API Endpoint**: https://api.linear.app/graphql
- **Team**: Creator (CRX)
- **Team ID**: e3694bc3-ea88-4efc-9fbc-0ddc27e42e41

### Workflow States
| State | ID |
|---|---|
| Backlog | bea79174-c83e-4ffd-bb8e-20ea97cfeed1 |
| Todo | df732ad6-44c6-4ccc-8247-a3b32c76a959 |
| In Progress | 7ec69ab4-f4a4-44a0-b2d0-816d77e16ef6 |
| In Review | 8aa91362-4b1c-407f-9314-9e7d80b1d651 |
| Done | 1d39a7b1-213c-4323-9eed-788c27bc588a |
| Canceled | 24c13ec7-f346-4d4f-840d-0ec374132a1f |

### Labels
| Label | ID |
|---|---|
| Bug | dc54ea90-03f6-48e7-baae-15306da57a56 |
| Feature | b63d902a-5ee0-477b-9e24-ffc0e2539010 |
| QA-ReCheck | c7199040-3fb2-441a-bda1-07012e5d67a4 |
| Frontend | f09ae1f9-f0dc-4229-9958-4929296416ce |
| Backend | fcefe1f0-859f-4076-b6ab-10ae1b42c1b9 |

## Project Structure
```
qa-shield/
├── extension/           # Chrome Extension
│   ├── manifest.json
│   ├── src/
│   │   ├── background/  # Service worker
│   │   ├── content/     # Content scripts
│   │   │   ├── linear/  # Linear overlay
│   │   │   └── staging/ # Staging site overlay
│   │   ├── popup/       # Extension popup
│   │   └── shared/      # Shared utilities
│   ├── public/          # Icons, assets
│   └── package.json
├── backend/             # Next.js API
│   ├── src/
│   │   ├── app/
│   │   │   └── api/
│   │   │       ├── enrich/
│   │   │       ├── verify/
│   │   │       ├── security/
│   │   │       └── monitor/
│   │   ├── lib/
│   │   │   ├── linear.ts    # Linear GraphQL client
│   │   │   ├── ai.ts        # AI enrichment logic
│   │   │   └── scanner.ts   # Security scanner
│   │   └── types/
│   ├── package.json
│   └── next.config.js
└── README.md
```

## MVP Priority
1. **Phase 1**: Chrome extension with Linear content script + backend `/api/enrich` endpoint
   - When user opens a Linear ticket, sidebar shows AI-enriched analysis
   - Test cases, scope, impact, edge cases auto-generated
   - Write enrichment back to ticket as a comment
2. **Phase 2**: Verification flow (`/api/verify`)
3. **Phase 3**: Security scanning + degradation monitoring

## Build Instructions
1. Start with the backend — set up Next.js with the `/api/enrich` endpoint
2. Build the Linear GraphQL client (`lib/linear.ts`)
3. Build the AI enrichment engine (`lib/ai.ts`)  
4. Build the Chrome extension manifest and content script for Linear
5. Wire the extension to call the backend API
6. Build the popup UI with status/recent activity

## Important Notes
- Use Manifest V3 (not V2)
- Extension should work on `https://linear.app/creatorfun/*`
- Backend should be configurable (env vars for API keys)
- Keep the UI clean and minimal — devs hate cluttered tools
- TypeScript everywhere
