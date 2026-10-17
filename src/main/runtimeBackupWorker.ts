import { parentPort, workerData } from 'worker_threads';
import { BackupWorkerJob, describeRuntimeBackup, writeRuntimeBackup } from './targets/runtimeBackup';
import { writeDistroBackupOnThisComputer } from './targets/windowsReset';

const job = workerData as BackupWorkerJob;

async function main(): Promise<void> {
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
  if (job.op === 'write-distro') {
    // The zip comes from the ElastOS Linux environment. Checking it is CPU work, so it runs here.
    parentPort?.postMessage({ ok: true, value: await writeDistroBackupOnThisComputer(job.home) });
    return;
  }
  throw new Error('The copy of your data could not be saved.');
}

main().catch((err) => {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
});
