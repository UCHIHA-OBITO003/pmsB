/**
 * BullMQ queue definitions.
 *
 * All queues share the existing ioredis connection (lazyConnect=true so it
 * doesn't force-open a socket at module load time — BullMQ calls connect
 * only when it first needs to).
 */
import { Queue } from 'bullmq';
import { redis } from '../utils/redis';

/** Connection options passed to every Queue / Worker constructor. */
export const bullConnection = { client: redis } as const;

// ─── Import queue ─────────────────────────────────────────────────────────────

export type ImportJobData =
  | {
      type: 'google-sheet';
      sheetId: string;
      projectId: string;
      userId: string;
      configId?: string;
      columnMapping?: Record<string, string>;
      legacyTicketProjectId?: string | null;
    }
  | {
      type: 'excel-file';
      filePath: string;
      projectId: string;
      userId: string;
      columnMapping?: Record<string, string>;
    };

/**
 * Jobs are processed by at most `concurrency` workers at once.
 * Sheet syncs and file imports are slow DB-heavy work, so a low concurrency
 * cap prevents them from starving the event loop.
 */
export const importQueue = new Queue<ImportJobData>('import-job', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});

// ─── Email queue ──────────────────────────────────────────────────────────────

export type EmailJobData = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export const emailQueue = new Queue<EmailJobData>('email-job', {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 100 },
  },
});

// ─── Convenience helpers ──────────────────────────────────────────────────────

/** Enqueue a Google Sheet sync and return the created job. */
export async function enqueueSheetSync(data: Extract<ImportJobData, { type: 'google-sheet' }>) {
  return importQueue.add('sheet-sync', data, { priority: 10 });
}

/** Enqueue an Excel/CSV file import and return the created job. */
export async function enqueueFileImport(data: Extract<ImportJobData, { type: 'excel-file' }>) {
  return importQueue.add('file-import', data, { priority: 5 });
}

/** Enqueue an outgoing email. Safe to call even when SMTP is unconfigured —
 *  the worker will discard it gracefully. */
export async function enqueueEmail(data: EmailJobData) {
  return emailQueue.add('send-email', data);
}

/** Snapshot of queue metrics for the system overview endpoint. */
export async function getQueueMetrics() {
  const [importCounts, emailCounts] = await Promise.all([
    importQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    emailQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
  ]);
  return {
    'import-job': importCounts,
    'email-job': emailCounts,
  };
}
