import { parentPort, workerData } from 'worker_threads';
import { discoverLegacyPc2, probeThisComputer, removeLegacyPc2InProcess } from './legacyPc2Removal';

interface Pc2WorkerJob {
  op: 'describe' | 'remove';
  home: string;
  platform: string;
  backup?: boolean;
  paths?: string[];
  downloadsDir?: string;
}

const job = workerData as Pc2WorkerJob;

function pauseForProbeBudget(): void {
  const delay = Number(process.env.ELASTOS_PC2_PROBE_DELAY_MS || '0');
  if (!Number.isFinite(delay) || delay <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delay, 5000));
}

async function main(): Promise<void> {
  pauseForProbeBudget();
  if (!job || (job.op !== 'describe' && job.op !== 'remove')) {
    throw new Error('PC2 removal failed.');
  }
  if (job.op === 'describe') {
    const items = discoverLegacyPc2(probeThisComputer(job.home, job.platform, process.env));
    parentPort?.postMessage({ ok: true, items });
    return;
  }
  const result = await removeLegacyPc2InProcess({
    backup: job.backup === true,
    paths: Array.isArray(job.paths) ? job.paths : [],
    home: job.home,
    platform: job.platform,
    env: process.env,
    downloadsDir: job.downloadsDir,
  });
  parentPort?.postMessage({ ok: true, result });
}

main().catch((err: unknown) => {
  const error = err instanceof Error ? err.message : String(err);
  parentPort?.postMessage({ ok: false, error });
});
