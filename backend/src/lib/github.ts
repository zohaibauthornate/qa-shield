/**
 * GitHub Integration for QA Shield
 * Fetches commit context, diffs, and changed files for Linear tickets
 * Repos: creatorfun/frontend, creatorfun/backend-persistent, creatorfun/backend-realtime
 * Branch: staging
 */

const GITHUB_API = 'https://api.github.com';
const REPOS = (process.env.GITHUB_REPOS || 'creatorfun/frontend,creatorfun/backend-persistent,creatorfun/backend-realtime').split(',');
const BRANCH = process.env.GITHUB_BRANCH || 'staging';

function getToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');
  return token;
}

function githubHeaders() {
  return {
    'Authorization': `Bearer ${getToken()}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };
}

// ============ Types ============

export interface GitHubCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  repo: string;
  url: string;
  filesChanged: GitHubFile[];
}

export interface GitHubFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string; // diff patch (may be truncated for large files)
}

export interface GitHubContext {
  ticketId: string;
  commits: GitHubCommit[];
  allFilesChanged: GitHubFile[];
  repos: string[];
  branch: string;
  summary: string;
  impactedAreas: string[];
  hasChanges: boolean;
}

// ============ Core: Find commits for a ticket ============

/**
 * Search all 3 repos for commits mentioning the ticket ID on the staging branch
 * Devs use format: "CRX-782: Description" or "CRX-782 - Description"
 */
export async function getTicketContext(ticketIdentifier: string): Promise<GitHubContext> {
  const commits: GitHubCommit[] = [];

  await Promise.all(
    REPOS.map(async (repo) => {
      try {
        const repoCommits = await findCommitsForTicket(repo, ticketIdentifier);
        commits.push(...repoCommits);
      } catch (err) {
        console.error(`[GitHub] Error fetching from ${repo}:`, err);
      }
    })
  );

  // Sort by date, newest first
  commits.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Aggregate all unique changed files
  const fileMap = new Map<string, GitHubFile>();
  for (const commit of commits) {
    for (const file of commit.filesChanged) {
      // Keep the latest version if file appears in multiple commits
      if (!fileMap.has(file.filename)) {
        fileMap.set(file.filename, file);
      }
    }
  }
  const allFilesChanged = Array.from(fileMap.values());

  // Classify impacted areas based on file paths
  const impactedAreas = classifyImpactedAreas(allFilesChanged);

  const summary = buildSummary(ticketIdentifier, commits, allFilesChanged);

  return {
    ticketId: ticketIdentifier,
    commits,
    allFilesChanged,
    repos: [...new Set(commits.map(c => c.repo))],
    branch: BRANCH,
    summary,
    impactedAreas,
    hasChanges: commits.length > 0,
  };
}

/**
 * Find commits on staging branch that mention the ticket ID
 * Scans last 200 commits across 2 pages — covers ~2 weeks of development
 * Note: GitHub Commit Search API is unreliable for private repos, so we scan directly
 */
async function findCommitsForTicket(repo: string, ticketId: string): Promise<GitHubCommit[]> {
  // Fetch 2 pages of 100 commits from staging branch in parallel
  const pages = await Promise.all([1, 2].map(async (page) => {
    const url = `${GITHUB_API}/repos/${repo}/commits?sha=${BRANCH}&per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      if (res.status === 404) return []; // branch or repo not found
      console.error(`[GitHub] ${repo} page ${page}: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }));

  const allCommits = pages.flat();

  // Match commits that mention the ticket ID (e.g. "CRX-782:" or "CRX 782" or "crx-782")
  const ticketPattern = new RegExp(ticketId.replace('-', '[\\-\\s]?'), 'i');
  const matchingCommits = allCommits.filter((c: any) =>
    ticketPattern.test(c.commit?.message || '')
  );

  // Fetch full diff for each matching commit (cap at 5 to avoid rate limits)
  const detailedCommits = await Promise.all(
    matchingCommits.slice(0, 5).map(async (c: any) => getCommitDetails(repo, c))
  );

  return detailedCommits;
}

/**
 * Get full commit details including file changes and diffs
 */
async function getCommitDetails(repo: string, commit: any): Promise<GitHubCommit> {
  const url = `${GITHUB_API}/repos/${repo}/commits/${commit.sha}`;

  const res = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    // Return basic info without diff
    return {
      sha: commit.sha,
      shortSha: commit.sha.substring(0, 8),
      message: commit.commit.message,
      author: commit.commit.author.name,
      date: commit.commit.author.date,
      repo,
      url: commit.html_url || `https://github.com/${repo}/commit/${commit.sha}`,
      filesChanged: [],
    };
  }

  const detail = await res.json();
  const filesChanged: GitHubFile[] = (detail.files || []).map((f: any) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions || 0,
    deletions: f.deletions || 0,
    patch: f.patch ? f.patch.substring(0, 2000) : undefined, // truncate large diffs
  }));

  return {
    sha: commit.sha,
    shortSha: commit.sha.substring(0, 8),
    message: commit.commit.message.split('\n')[0], // first line only
    author: commit.commit.author.name || detail.commit?.author?.name || 'Unknown',
    date: commit.commit.author.date,
    repo,
    url: commit.html_url || `https://github.com/${repo}/commit/${commit.sha}`,
    filesChanged,
  };
}

// ============ Analysis Helpers ============

/**
 * Classify which areas of the platform are impacted by changed files
 */
function classifyImpactedAreas(files: GitHubFile[]): string[] {
  const areas = new Set<string>();

  for (const file of files) {
    const f = file.filename.toLowerCase();

    // Frontend areas
    if (f.includes('tradingview') || f.includes('chart')) areas.add('TradingView Charts');
    if (f.includes('trade') || f.includes('buy') || f.includes('sell')) areas.add('Trading Flow');
    if (f.includes('leaderboard')) areas.add('Leaderboard');
    if (f.includes('portfolio') || f.includes('pnl') || f.includes('holdings')) areas.add('Portfolio/PnL');
    if (f.includes('wallet')) areas.add('Wallet/Balance');
    if (f.includes('token') && f.includes('detail')) areas.add('Token Detail Page');
    if (f.includes('discover') || f.includes('dashboard')) areas.add('Discover/Dashboard');
    if (f.includes('profile')) areas.add('User Profile');
    if (f.includes('chat')) areas.add('Chat System');
    if (f.includes('create')) areas.add('Token Creation');
    if (f.includes('auth') || f.includes('login')) areas.add('Authentication');
    if (f.includes('popup') || f.includes('modal')) areas.add('Modals/Popups');
    if (f.includes('sidebar')) areas.add('Sidebar Components');
    if (f.includes('header') || f.includes('navbar')) areas.add('Header/Navigation');
    if (f.includes('notification') || f.includes('toast')) areas.add('Notifications/Toasts');
    if (f.includes('types/') || f.includes('.types.')) areas.add('Type Definitions (broad impact)');
    if (f.includes('utils/') || f.includes('helpers/') || f.includes('lib/')) areas.add('Shared Utilities (broad impact)');
    if (f.includes('hooks/')) areas.add('React Hooks');
    if (f.includes('context/') || f.includes('store/') || f.includes('state/')) areas.add('Global State');

    // Backend areas
    if (f.includes('api/token')) areas.add('Token API');
    if (f.includes('api/trade') || f.includes('api/swap')) areas.add('Trade API');
    if (f.includes('api/user') || f.includes('api/profile')) areas.add('User/Profile API');
    if (f.includes('api/leaderboard')) areas.add('Leaderboard API');
    if (f.includes('api/reward') || f.includes('api/fee')) areas.add('Rewards/Fees API');
    if (f.includes('api/chat')) areas.add('Chat API');
    if (f.includes('websocket') || f.includes('ws/') || f.includes('socket')) areas.add('WebSocket/Real-time');
    if (f.includes('middleware')) areas.add('API Middleware (broad impact)');
    if (f.includes('cors') || f.includes('auth') || f.includes('security')) areas.add('Security/Auth Middleware');
    if (f.includes('database') || f.includes('db/') || f.includes('prisma') || f.includes('schema')) areas.add('Database Layer');

    // Styles
    if (f.endsWith('.css') || f.endsWith('.scss')) areas.add('Stylesheets');
    if (f.includes('tailwind') || f.includes('globals.css')) areas.add('Global Styles (broad impact)');
  }

  return Array.from(areas).sort();
}

/**
 * Build a human-readable summary of the GitHub context
 */
function buildSummary(ticketId: string, commits: GitHubCommit[], files: GitHubFile[]): string {
  if (commits.length === 0) {
    return `No commits found on staging branch mentioning ${ticketId}. Fix may not be deployed yet.`;
  }

  const repoNames = [...new Set(commits.map(c => c.repo.split('/')[1]))];
  const fileCount = files.length;
  const addedFiles = files.filter(f => f.status === 'added').length;
  const modifiedFiles = files.filter(f => f.status === 'modified').length;
  const removedFiles = files.filter(f => f.status === 'removed').length;

  let summary = `${commits.length} commit(s) found in [${repoNames.join(', ')}] on staging. `;
  summary += `${fileCount} file(s) changed`;
  const parts = [];
  if (modifiedFiles > 0) parts.push(`${modifiedFiles} modified`);
  if (addedFiles > 0) parts.push(`${addedFiles} added`);
  if (removedFiles > 0) parts.push(`${removedFiles} removed`);
  if (parts.length > 0) summary += ` (${parts.join(', ')})`;
  summary += '.';

  return summary;
}

// ============ Format for AI Prompt ============

/**
 * Format GitHub context as a compact string for injecting into AI prompts
 */
export function formatGitHubContextForAI(ctx: GitHubContext): string {
  if (!ctx.hasChanges) {
    return `GITHUB CONTEXT: No commits found on staging branch for ${ctx.ticketId}. Fix may not be deployed yet.`;
  }

  let out = `GITHUB CONTEXT (staging branch — what the developer actually changed):\n`;
  out += `Summary: ${ctx.summary}\n\n`;

  // List commits
  out += `Commits:\n`;
  for (const commit of ctx.commits) {
    out += `- [${commit.shortSha}] ${commit.repo.split('/')[1]}: "${commit.message}" by ${commit.author} on ${commit.date.substring(0, 10)}\n`;
  }
  out += '\n';

  // List changed files
  out += `Files Changed:\n`;
  for (const file of ctx.allFilesChanged) {
    const icon = file.status === 'added' ? '➕' : file.status === 'removed' ? '➖' : '✏️';
    out += `${icon} ${file.filename} (+${file.additions}/-${file.deletions})\n`;
  }
  out += '\n';

  // Impacted areas
  if (ctx.impactedAreas.length > 0) {
    out += `Potentially Impacted Areas:\n`;
    ctx.impactedAreas.forEach(area => { out += `- ${area}\n`; });
    out += '\n';
  }

  // Include diffs for key files (first 3 with patches, truncated)
  const filesWithPatches = ctx.allFilesChanged.filter(f => f.patch && f.patch.length > 10).slice(0, 3);
  if (filesWithPatches.length > 0) {
    out += `Key Diffs (for verification context):\n`;
    for (const file of filesWithPatches) {
      out += `\n--- ${file.filename} ---\n`;
      out += `${file.patch!.substring(0, 800)}\n`;
      if (file.patch!.length > 800) out += `[... diff truncated ...]\n`;
    }
  }

  return out;
}

// ============ Format for Linear Comment ============

/**
 * Format GitHub context as a Linear comment section
 */
export function formatGitHubContextForComment(ctx: GitHubContext): string {
  if (!ctx.hasChanges) {
    return `### 📦 GitHub Context\n\n⚠️ No commits found on \`staging\` branch mentioning \`${ctx.ticketId}\`. Fix may not be deployed yet or commit message doesn't include the ticket ID.\n`;
  }

  let c = `### 📦 GitHub Context\n\n`;
  c += `**Branch:** \`staging\` | **${ctx.summary}**\n\n`;

  // Commits
  c += `**Commits:**\n`;
  for (const commit of ctx.commits) {
    const repoShort = commit.repo.split('/')[1];
    c += `- [\`${commit.shortSha}\`](${commit.url}) \`${repoShort}\` — ${commit.message} *(${commit.author}, ${commit.date.substring(0, 10)})*\n`;
  }
  c += '\n';

  // Changed files table
  if (ctx.allFilesChanged.length > 0) {
    c += `**Files Changed:**\n`;
    c += `| File | Status | +/- |\n`;
    c += `|------|--------|-----|\n`;
    for (const file of ctx.allFilesChanged.slice(0, 20)) { // cap at 20 files
      const icon = file.status === 'added' ? '➕' : file.status === 'removed' ? '➖' : '✏️';
      c += `| \`${file.filename}\` | ${icon} ${file.status} | +${file.additions}/-${file.deletions} |\n`;
    }
    if (ctx.allFilesChanged.length > 20) {
      c += `| *(${ctx.allFilesChanged.length - 20} more files)* | | |\n`;
    }
    c += '\n';
  }

  // Impacted areas
  if (ctx.impactedAreas.length > 0) {
    c += `**Potentially Impacted Areas (regression watch):**\n`;
    ctx.impactedAreas.forEach(area => { c += `- ⚠️ ${area}\n`; });
    c += '\n';
  }

  return c;
}
