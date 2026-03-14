/**
 * Codex AI Provider for QA Shield
 * Uses Codex CLI (ChatGPT Plus subscription) — no API credits needed
 * Spawns `codex exec` as subprocess and extracts JSON from output
 *
 * NOTE: Codex with ChatGPT account uses gpt-5.4 (reasoning model) only.
 * We use compact prompts to keep latency under 90s.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { which } from './which-util';

const execFileAsync = promisify(execFile);

/**
 * Extract JSON from codex exec output.
 * Output format:
 *   ... header ...
 *   user
 *   <prompt>
 *   mcp startup: no servers
 *   codex
 *   <response>
 *   tokens used
 *   <count>
 *   <response again>
 */
function extractJSON(output: string): string {
  // Strategy 1: Extract what comes after "tokens used\n<number>\n" — the final clean response
  const tokensUsedMatch = output.match(/tokens used\s*\n\s*[\d,]+\s*\n([\s\S]+)$/);
  if (tokensUsedMatch) {
    const candidate = tokensUsedMatch[1].trim();
    if (candidate.startsWith('{')) return candidate;
  }

  // Strategy 2: Extract what comes after "codex\n" section (between codex\n and tokens used)
  const codexSectionMatch = output.match(/\ncodex\n([\s\S]*?)\ntokens used/);
  if (codexSectionMatch) {
    const candidate = codexSectionMatch[1].trim();
    if (candidate.startsWith('{')) return candidate;
  }

  // Strategy 3: Find last standalone JSON block starting at line start
  const lines = output.split('\n');
  let jsonStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('{')) { jsonStart = i; break; }
  }
  if (jsonStart >= 0) {
    const candidate = lines.slice(jsonStart).join('\n').trim();
    // Try to parse to validate
    JSON.parse(candidate); // throws if invalid
    return candidate;
  }

  throw new Error('No JSON found in Codex output');
}

/**
 * Run a prompt through Codex CLI and return parsed JSON.
 * Uses stdin to avoid shell argument length limits on large prompts.
 * @param prompt - The prompt to send to Codex
 * @param timeoutMs - Timeout in ms (default 90s)
 */
export async function callCodex<T = any>(prompt: string, timeoutMs = 90_000): Promise<T> {
  const codexPath = await which('codex');
  if (!codexPath) {
    throw new Error('Codex CLI not found. Run: npm install -g @openai/codex && codex login');
  }

  const { spawn } = await import('child_process');

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const child = spawn(codexPath, ['exec', '-'], {
      env: { ...process.env, HOME: process.env.HOME || '/Users/zohaibmac-mini' },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        // stdout = clean JSON response, stderr = session header/token info
        const sources = [stdout.trim(), stderr.trim(), (stdout + stderr).trim()];
        for (const src of sources) {
          if (!src) continue;
          // Find the outermost JSON object by locating first { and last }
          const start = src.indexOf('{');
          const end = src.lastIndexOf('}');
          if (start === -1 || end === -1 || end <= start) continue;
          const candidate = src.slice(start, end + 1);
          try {
            resolve(JSON.parse(candidate) as T);
            return;
          } catch {
            // try next source
          }
        }
        reject(new Error(`No valid JSON in Codex output. stdout: "${stdout.slice(0, 300)}"`));
      } catch (e) {
        reject(e);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Write prompt to stdin and close
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

/**
 * Check if Codex CLI is available and authenticated
 */
export async function isCodexAvailable(): Promise<boolean> {
  try {
    const codexPath = await which('codex');
    if (!codexPath) return false;
    // Check auth file exists
    const fs = await import('fs');
    const authPath = `${process.env.HOME || '/Users/zohaibmac-mini'}/.codex/auth.json`;
    return fs.existsSync(authPath);
  } catch {
    return false;
  }
}
