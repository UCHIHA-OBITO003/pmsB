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
  deliveryId: string;
  userId?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  templateKey: string;
  eventType: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
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

// ─── GitHub sync queue ─────────────────────────────────────────────────────────

export type GitHubJobData = {
  type: 'sync-project-link';
  projectGitHubLinkId: string;
  forceFull?: boolean;
  lookbackDays?: number;
  requestedBy?: string;
} | {
  type: 'remap-project-identity';
  projectId: string;
  userId: string;
  lookbackDays?: number;
  requestedBy?: string;
};

export const githubQueue = new Queue<GitHubJobData>('github-job', {
  connection: redis,
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: 'exponential', delay: 20_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});

// ─── Legacy Codemagen re-sync queue ───────────────────────────────────────────

export type LegacySyncJobData = { ticketId: string };

export const legacySyncQueue = new Queue<LegacySyncJobData>('legacy-sync-job', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 20_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
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

export async function enqueueGitHubProjectSync(data: GitHubJobData) {
  if (data.type !== 'sync-project-link') {
    throw new Error('enqueueGitHubProjectSync only supports sync-project-link jobs');
  }
  return githubQueue.add('sync-project-link', data, {
    jobId: `${data.projectGitHubLinkId}--${data.forceFull ? 'full' : 'delta'}--${data.lookbackDays ?? 'auto'}`,
  });
}

export async function enqueueGitHubIdentityRemap(data: Extract<GitHubJobData, { type: 'remap-project-identity' }>) {
  return githubQueue.add('remap-project-identity', data, {
    jobId: `${data.projectId}--${data.userId}--remap--${data.lookbackDays ?? 'auto'}`,
  });
}

/** Enqueue Codemagen legacy sync jobs for many ticket IDs (returns BullMQ job ids). */
export async function enqueueLegacySyncJobs(ticketIds: string[]) {
  const jobs = await Promise.all(
    ticketIds.map((ticketId) => legacySyncQueue.add('codemagen-sync', { ticketId })),
  );
  return jobs.map((j) => j.id);
}

/** Snapshot of queue metrics for the system overview endpoint. */
export async function getQueueMetrics() {
  const [importCounts, emailCounts, legacyCounts, githubCounts] = await Promise.all([
    importQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    emailQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    legacySyncQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    githubQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
  ]);
  return {
    'import-job': importCounts,
    'email-job': emailCounts,
    'legacy-sync-job': legacyCounts,
    'github-job': githubCounts,
  };
}
