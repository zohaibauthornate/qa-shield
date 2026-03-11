# QA Shield — GitHub Integration Plan
**Author:** Chief QA 🛡️  
**Date:** March 12, 2026

---

## Why This Matters

Right now when QA Shield enriches a ticket, the AI only has:
- Ticket title + description
- Developer comments
- Generic platform context ("Next.js + React + TypeScript...")

With GitHub integration it will have:
- The **actual component code** that's broken (e.g., `TokenChartHeader.tsx` with real prop names)
- The **actual API handler** (e.g., `src/app/api/token/route.ts` with real field names)
- **Recent commits** mentioning the ticket ID (what changed = what broke)
- **Type definitions** (exact interfaces, field names, data shapes)

**Result:** Test cases go from generic → surgical:

❌ Before:
```
TC-1: "Verify market cap displays correctly"
Steps: 1. Navigate to token page 2. Check market cap value
```

✅ After (with code context):
```
TC-1: "Verify mcap.usd field renders in TokenChartHeader MKT CAP span"
Steps:
1. Navigate to /details/Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG
2. Inspect element: <span class="mkt-cap-value"> inside <TokenChartHeader>
3. Cross-check: GET /api/token?address=... → response.data.mcap.usd
4. Assert DOM text matches API value within 1% tolerance
```

---

## Architecture

```
Linear Ticket (CRX-XXX)
    ↓
enrich/route.ts
    ↓ new step
github.ts → getCodeContext(ticket)
    ├── inferRelevantPaths(ticket)     ← keyword → file path heuristics
    ├── searchCodeViaAPI(keywords)     ← GitHub Search API
    ├── fetchFileContents(paths[])     ← GitHub Contents API
    └── getRelatedCommits(ticketId)    ← GitHub Commits API (search by CRX-XXX)
    ↓
CodeContext { files[], commits[], summary }
    ↓
buildEnrichmentPrompt(issue, codeContext)   ← updated in ai.ts
    ↓ injected as:
    RELEVANT CODE FILES:
    --- src/components/token/TokenChartHeader.tsx ---
    [actual file content, max 200 lines]
    --- src/app/api/token/route.ts ---
    [actual file content, max 200 lines]
    ↓
Claude AI → far better analysis
```

---

## New File: `backend/src/lib/github.ts`

### Interface
```typescript
export interface CodeFile {
  path: string;
  content: string;
  lines: number;
  url: string;
}

export interface CommitContext {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
  filesChanged: string[];
}

export interface CodeContext {
  files: CodeFile[];
  commits: CommitContext[];
  tokenUsed: number;
  filesSearched: number;
}
```

### Functions
```typescript
// Main entry — called from enrich/route.ts
getCodeContext(ticket: LinearIssue): Promise<CodeContext>

// 1. Infer likely file paths from ticket keywords
inferFilePaths(ticket: LinearIssue): string[]

// 2. Search GitHub code for matches
searchCodeFiles(keywords: string[], label: string): Promise<string[]>

// 3. Fetch file contents (max 5 files, 200 lines each)
fetchFileContents(paths: string[]): Promise<CodeFile[]>

// 4. Find commits mentioning this ticket
getRelatedCommits(ticketId: string): Promise<CommitContext[]>
```

---

## File Path Inference Logic

Based on ticket labels and keywords:

```
IF label = "Frontend" OR title mentions:
  - "page", "component", "UI", "button", "modal", "chart"
  → search: src/components/, src/app/(pages)/

IF label = "Backend" OR title mentions:
  - "API", "endpoint", "route", "response", "query"
  → search: src/app/api/, src/lib/

IF label = "Onchain" OR title mentions:
  - "transaction", "wallet", "SOL", "buy", "sell", "trade"
  → search: src/lib/solana/, src/hooks/useTransaction*

ALWAYS include if mentioned in title:
  - Component names (e.g., "TokenChartHeader" → src/components/token/TokenChartHeader.tsx)
  - Route paths (e.g., "/details" → src/app/(pages)/details/)
  - API paths (e.g., "/api/token" → src/app/api/token/route.ts)
```

---

## GitHub Search API Strategy

Three layers of file discovery:

**Layer 1: Title keyword extraction**
```
"TokenChartHeader market cap layout" 
→ keywords: ["TokenChartHeader", "market cap", "mcap"]
→ GitHub code search: repo:org/repo "TokenChartHeader" extension:tsx
```

**Layer 2: Path heuristics from labels**
```
Label: Frontend → search src/components/
Label: Backend → search src/app/api/
Label: Onchain → search src/lib/solana/
```

**Layer 3: Recent commits**
```
GitHub commits API: ?q=CRX-828 in commit messages
→ shows exactly what files were changed for this ticket
```

**Priority ranking:**
1. Files mentioned in commit messages for this ticket ID
2. Files matching component/function name from ticket title
3. Files matching route path from ticket title
4. Files in the label-relevant directory

---

## Token Budget Management

Claude Haiku context: 200K tokens
Each file: ~500–2000 tokens (200 lines × 5–10 tokens/line)

**Budget allocation per enrich call:**
```
System prompt:          ~500 tokens
Ticket content:         ~300 tokens
Code context:           ~8,000 tokens max (5 files × ~1,600 tokens each)
AI response:            ~2,000 tokens (enrichment JSON)
────────────────────────────────
TOTAL:                  ~10,800 tokens per call
```

**File selection rules:**
- Max 5 files per enrichment call
- Max 200 lines per file (hard truncate with notice)
- Prefer smaller, focused files over large index files
- Strip comments and blank lines to save tokens
- Always include TypeScript interfaces/types when found

---

## Environment Variables Needed

```bash
# .env.local additions
GITHUB_TOKEN=ghp_xxxx          # Fine-grained PAT: read:contents + read:code
GITHUB_REPO=org/repo-name      # e.g. creatorfun/creator-fun
GITHUB_BRANCH=main             # or develop/staging
```

**Token permissions needed (Fine-grained PAT):**
- Repository: Contents → Read
- Repository: Code search → Read

---

## Enrich Route Changes (`enrich/route.ts`)

New Step 0.5 between "Fetch ticket" and "AI analysis":

```typescript
// ── Step 0.5: Fetch GitHub code context ──
send('step', { step: 1, status: 'active', label: 'Fetching code context from GitHub...' });

let codeContext: CodeContext | null = null;
if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
  codeContext = await getCodeContext(issue);
  const summary = `${codeContext.files.length} files, ${codeContext.commits.length} related commits`;
  send('step', { step: 1, status: 'done', label: `Code context: ${summary}` });
  send('github_context', {
    files: codeContext.files.map(f => ({ path: f.path, lines: f.lines })),
    commits: codeContext.commits.map(c => ({ sha: c.sha.substring(0,7), message: c.message.substring(0,60) })),
  });
} else {
  send('step', { step: 1, status: 'warn', label: 'GitHub not configured — using ticket context only' });
}

// ── Step 1: AI analysis (now with code context) ──
const prompt = buildEnrichmentPrompt(issue, codeContext);  // ← passes code context
```

---

## AI Prompt Changes (`ai.ts`)

Updated `buildEnrichmentPrompt(issue, codeContext?)`:

```typescript
RELEVANT CODE FILES:
${codeContext.files.map(f => `
--- ${f.path} (${f.lines} lines) ---
\`\`\`typescript
${f.content}
\`\`\`
`).join('\n')}

RELATED COMMITS (what was recently changed):
${codeContext.commits.map(c => `- [${c.sha}] ${c.message} by ${c.author}`).join('\n')}
```

When code context is provided, add these instructions:
```
Use the actual code files above to:
1. Reference real component prop names, not guesses
2. Reference real API response field names (e.g., mcap.usd not market_cap)
3. Reference real CSS class names for DOM checks
4. Reference real function/hook names in reproducible steps
5. Identify the exact lines that are likely causing the issue
```

---

## Extension UI Changes

New live update in the enrich flow:
```
→ [GitHub] 3 files fetched — TokenChartHeader.tsx, token.ts, useTokenData.ts
→ [GitHub] 2 related commits — abc1234: Fix mcap display, def5678: Update TokenChart
```

In the enrichment results, add a "Code Context" section:
```
📂 Code Context
  - src/components/token/TokenChartHeader.tsx (142 lines)
  - src/app/api/token/route.ts (89 lines)
  - src/hooks/useTokenData.ts (67 lines)
  - [commit abc1234] Fix mcap display in header
```

---

## What This Unlocks

**Before GitHub integration:**
- `filesLikelyInvolved: ["src/components/...", "src/api/..."]` — generic guesses
- Test cases: "Verify market cap displays correctly"
- Validation checks: generic DOM selector `.mkt-cap` (may not exist)

**After GitHub integration:**
- `filesLikelyInvolved: ["src/components/token/TokenChartHeader.tsx:89", "src/app/api/token/route.ts:234"]` — exact lines
- Test cases: "Verify `mcap.usd` from `/api/token?address=X` matches `data-mcap` attribute in `<div class="qs-mkt-cap">` inside `<TokenChartHeader>`"
- Validation checks: real CSS selectors from actual component code

---

## Implementation Order

1. Create `backend/src/lib/github.ts` with all functions
2. Add env vars to `.env.local` (need GITHUB_TOKEN + GITHUB_REPO from Master)
3. Update `enrich/route.ts` — add GitHub fetch step
4. Update `ai.ts` — `buildEnrichmentPrompt` accepts optional `codeContext`
5. Update extension — add `github_context` SSE event handler + results section
6. Test with CRX-892 (mcap.sol mislabeled) — should detect the exact API field

---

## What I Need From You

1. **GITHUB_TOKEN** — Fine-grained PAT with `read:contents` on the creator.fun repo
2. **GITHUB_REPO** — The repo name (e.g., `creatorfun/creator-fun` or `creatorfun/app`)
3. **GITHUB_BRANCH** — Main branch name (`main`, `develop`, `master`)

Once you give me those 3, I can implement the full integration in one session.

---

*Planned by Chief QA 🛡️ — March 12, 2026*
