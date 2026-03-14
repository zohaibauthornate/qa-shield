/**
 * Cross-platform `which` utility — finds executable path
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [cmd]);
    return stdout.trim() || null;
  } catch {
    // Try common paths
    const paths = [
      `/usr/local/bin/${cmd}`,
      `/usr/bin/${cmd}`,
      `/opt/homebrew/bin/${cmd}`,
    ];
    const fs = await import('fs');
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
}
