import { Worker, Job } from 'bullmq';
import { redis } from '../../utils/redis';
import { logger } from '../../utils/logger';
import { ImportJobData } from '../index';

let worker: Worker<ImportJobData> | null = null;

async function processImportJob(job: Job<ImportJobData>) {
  const { data } = job;
  logger.info({ jobId: job.id, type: data.type }, 'import-worker: processing job');

  // Lazy-import the heavy service modules so they are only loaded when a
  // worker actually runs, not at queue-definition time.
  if (data.type === 'google-sheet') {
    const { excelImportService } = await import('../../services/excel-import.service');
    const result = await excelImportService.syncGoogleSheet(
      data.sheetId,
      data.projectId,
      data.userId,
      (data.columnMapping ?? {}) as any,
      data.configId,
      { legacyTicketProjectId: data.legacyTicketProjectId },
    );
    logger.info({ jobId: job.id, result }, 'import-worker: google-sheet sync complete');
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
    logger.info({ jobId: job.id, result }, 'import-worker: file import complete');
    return result;
  }

  throw new Error(`import-worker: unknown job type ${(data as any).type}`);
}

export function startImportWorker() {
  if (worker) return worker;

  worker = new Worker<ImportJobData>('import-job', processImportJob, {
    connection: redis,
    concurrency: 2,
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
