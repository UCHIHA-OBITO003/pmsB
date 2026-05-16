import { Worker, Job } from 'bullmq';
import { redis } from '../../utils/redis';
import { logger } from '../../utils/logger';
import type { ImportJobData } from '../job-types';
import { bullWorkerPollOptions, shouldRunBullWorkers } from '../queue-runtime';

let worker: Worker<ImportJobData> | null = null;

export async function runImportJobInline(data: ImportJobData) {
  logger.info({ type: data.type }, 'import: processing inline job');

  if (data.type === 'google-sheet') {
    const { excelImportService } = await import('../../services/excel-import.service');
    const result = await excelImportService.syncGoogleSheet(
      data.sheetId,
      data.projectId,
      data.userId,
      (data.columnMapping ?? {}) as Record<string, string>,
      data.configId,
      { legacyTicketProjectId: data.legacyTicketProjectId },
    );
    logger.info({ result }, 'import: google-sheet sync complete');
    return result;
  }

  if (data.type === 'excel-file') {
    const { excelImportService } = await import('../../services/excel-import.service');
    const result = await excelImportService.importFile(
      data.filePath,
      data.projectId,
      data.columnMapping ?? {},
      data.userId,
    );
    logger.info({ result }, 'import: file import complete');
    return result;
  }

  throw new Error(`import: unknown job type ${(data as { type: string }).type}`);
}

async function processImportJob(job: Job<ImportJobData>) {
  return runImportJobInline(job.data);
}

export function startImportWorker() {
  if (worker) return worker;
  if (!shouldRunBullWorkers()) {
    logger.info('import-worker: skipped (inline queue mode or Redis unavailable)');
    return null;
  }

  worker = new Worker<ImportJobData>('import-job', processImportJob, {
    connection: redis,
    concurrency: 2,
    ...bullWorkerPollOptions(),
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'import-worker: job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, name: job?.name, err }, 'import-worker: job failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'import-worker: worker error');
  });

  logger.info('✅ BullMQ import-job worker started (concurrency=2)');
  return worker;
}

export async function stopImportWorker() {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('import-worker: stopped');
  }
}
