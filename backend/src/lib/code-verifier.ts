/**
 * code-verifier.ts
 * Verifies that specific code changes are actually present in the GitHub repo.
 * Used as Stage 1 of unified verification — confirms fix is merged before running live tests.
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;

export interface CodeCheck {
  description: string;
  file: string;
  /** removed/not-contains: pattern must NOT be in file. added/contains: pattern MUST be in file */
  type: 'removed' | 'added' | 'contains' | 'not-contains';
  pattern: string;
  status?: 'pass' | 'fail' | 'warn' | 'skip';
  details?: string;
}

export interface CodeVerifyResult {
  checks: CodeCheck[];
  allPassed: boolean;
  someWarned: boolean;
  repo: string;
  branch: string;
}

/** Fetch a file's content from GitHub. Returns null on 404, throws on other errors. */
async function fetchFileContent(repo: string, branch: string, filepath: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${repo}/contents/${filepath}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${filepath}`);
  const data = await res.json();
  if (!data.content) return null;
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

/** Run code-level checks against the GitHub repo on a given branch */
export async function verifyCodeChanges(
  repo: string,
  branch: string,
  checks: CodeCheck[]
): Promise<CodeVerifyResult> {
  // Group checks by file to avoid redundant fetches
  const fileGroups: Record<string, CodeCheck[]> = {};
  for (const check of checks) {
    if (!fileGroups[check.file]) fileGroups[check.file] = [];
    fileGroups[check.file].push(check);
  }

  const results: CodeCheck[] = [];

  for (const [filepath, fileChecks] of Object.entries(fileGroups)) {
    let content: string | null = null;
    let fetchError: string | null = null;

    try {
      content = await fetchFileContent(repo, branch, filepath);
    } catch (err: any) {
      fetchError = err.message;
    }

    for (const check of fileChecks) {
      const result: CodeCheck = { ...check };

      if (fetchError) {
        result.status = 'warn';
        result.details = `Could not fetch file: ${fetchError}`;
        results.push(result);
        continue;
      }

      if (content === null) {
        result.status = 'warn';
        result.details = `File not found on branch \`${branch}\` — may have been renamed or deleted`;
        results.push(result);
        continue;
      }

      const patternPresent = content.includes(check.pattern);

      if (check.type === 'removed' || check.type === 'not-contains') {
        result.status = patternPresent ? 'fail' : 'pass';
        result.details = patternPresent
          ? `Pattern still present in \`${filepath}\` — not removed`
          : `Pattern not found in \`${filepath}\` ✓ (correctly removed)`;
      } else {
        // 'added' | 'contains'
        result.status = patternPresent ? 'pass' : 'fail';
        result.details = patternPresent
          ? `Pattern found in \`${filepath}\` ✓`
          : `Pattern NOT found in \`${filepath}\` — change may not be merged`;
      }

      results.push(result);
    }
  }

  const allPassed = results.every(r => r.status === 'pass' || r.status === 'warn');
  const someWarned = results.some(r => r.status === 'warn');

  return { checks: results, allPassed, someWarned, repo, branch };
}

/**
 * Infer GitHub repo from changed file paths.
 * src/pages/, src/hooks/, src/components/ → frontend
 * Otherwise → backend-persistent
 */
export function inferRepo(filenames: string[]): string {
  const frontendPatterns = ['src/pages/', 'src/hooks/', 'src/components/', 'src/styles/', 'src/lib/', 'src/context/'];
  const hasFrontend = filenames.some(f => frontendPatterns.some(p => f.startsWith(p)));
  const hasBackend = filenames.some(f => f.includes('server') || f.includes('api/') || f.includes('routes/') || f.includes('controllers/'));
  if (hasFrontend && !hasBackend) return 'creatorfun/frontend';
  if (hasBackend && !hasFrontend) return 'creatorfun/backend-persistent';
  // Default to frontend if mixed
  return 'creatorfun/frontend';
}
