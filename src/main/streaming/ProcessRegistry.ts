/**
 * Tracks the PIDs of FFmpeg processes this app has spawned.
 *
 * If the app is killed abnormally -- a crash, a `Ctrl+C` during development, a
 * forced renderer reload -- FFmpeg keeps running and holds the camera open. On
 * the next start we read the recorded PIDs back and reap only those, after
 * verifying the PID still belongs to an `ffmpeg.exe`, so we can never kill an
 * unrelated process that happens to have reused the number.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REGISTRY_FILE = 'ffmpeg-processes.json';

interface RegistryFile {
  pids: number[];
  updatedAt: string;
}

export interface ProcessRegistryOptions {
  directory: string;
  onLog?: (message: string) => void;
}

export class ProcessRegistry {
  private readonly path: string;
  private readonly live = new Set<number>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ProcessRegistryOptions) {
    this.path = join(options.directory, REGISTRY_FILE);
  }

  add(pid: number | undefined): void {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
    this.live.add(pid);
    this.persist();
  }

  remove(pid: number | undefined): void {
    if (typeof pid !== 'number') return;
    this.live.delete(pid);
    this.persist();
  }

  /** PIDs currently believed to be running. */
  current(): number[] {
    return [...this.live];
  }

  private persist(): void {
    const snapshot: RegistryFile = {
      pids: [...this.live],
      updatedAt: new Date().toISOString(),
    };
    // Serialise writes so two rapid add/remove calls cannot interleave.
    this.writeQueue = this.writeQueue
      .then(() => writeFile(this.path, JSON.stringify(snapshot), 'utf8'))
      .catch(() => undefined);
  }

  /**
   * Kills any FFmpeg process left over from a previous run.
   * Returns the PIDs that were actually terminated.
   */
  async reapOrphans(): Promise<number[]> {
    if (process.platform !== 'win32') return [];

    let recorded: number[];
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as RegistryFile).pids)
      ) {
        return [];
      }
      recorded = (parsed as RegistryFile).pids.filter(
        (pid) => typeof pid === 'number' && Number.isInteger(pid) && pid > 0,
      );
    } catch {
      return [];
    }

    const killed: number[] = [];

    for (const pid of recorded) {
      if (!(await this.isFfmpegProcess(pid))) continue;
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
        });
        killed.push(pid);
        this.options.onLog?.(`Reaped orphaned FFmpeg process ${pid} from a previous run.`);
      } catch {
        // Already gone, or not ours to kill.
      }
    }

    this.live.clear();
    this.persist();
    return killed;
  }

  /**
   * Confirms a PID is still an `ffmpeg.exe`. Without this check a recycled PID
   * could point at something completely unrelated.
   */
  private async isFfmpegProcess(pid: number): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { windowsHide: true },
      );
      return /^"ffmpeg\.exe"/i.test(stdout.trim());
    } catch {
      return false;
    }
  }
}
