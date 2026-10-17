import { parentPort, workerData } from 'worker_threads';
import { BackupWorkerJob, describeRuntimeBackup, writeRuntimeBackup } from './targets/runtimeBackup';

const job = workerData as BackupWorkerJob;

function main(): void {
  if (!job || typeof job.dataDir !== 'string' || typeof job.home !== 'string') {
    throw new Error('The copy of your data could not be saved.');
  }
  if (job.op === 'describe') {
    parentPort?.postMessage({ ok: true, value: describeRuntimeBackup({ dataDir: job.dataDir, home: job.home }) });
    return;
  }
  if (job.op === 'write') {
    parentPort?.postMessage({ ok: true, value: writeRuntimeBackup({ dataDir: job.dataDir, home: job.home }) });
    return;
  }
  throw new Error('The copy of your data could not be saved.');
}

try {
  main();
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
