import type { Redis } from 'ioredis';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

export type QueueMode = 'redis' | 'inline';

let redisUsable = config.queues.mode === 'redis';
let quotaWarned = false;

export function getQueueMode(): QueueMode {
  return config.queues.mode;
}

export function isRedisUsable(): boolean {
  return config.queues.mode === 'redis' && redisUsable;
}

export function shouldRunBullWorkers(): boolean {
  return config.queues.workersEnabled && isRedisUsable();
}

export function isRedisQuotaOrUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /max requests limit exceeded/i.test(msg) ||
    /ERR max requests/i.test(msg) ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Connection is closed/i.test(msg) ||
    /READONLY|OOM|LOADING/i.test(msg)
  );
}

export function markRedisUnusable(err: unknown, context?: string): void {
  if (!redisUsable) return;
  redisUsable = false;
  if (!quotaWarned) {
    quotaWarned = true;
    logger.warn(
      {
        err,
        context,
        queueMode: config.queues.mode,
        hint: 'Set QUEUE_MODE=inline and DISABLE_BULLMQ_WORKERS=true on Render, or upgrade Upstash / wait for monthly reset.',
      },
      'Redis unavailable for BullMQ — switching enqueue fallbacks to inline processing',
    );
  }
}

export async function probeRedis(redis: Redis): Promise<boolean> {
  if (config.queues.mode === 'inline') {
    redisUsable = false;
    return false;
  }
  try {
    const pong = await redis.ping();
    redisUsable = pong === 'PONG';
    return redisUsable;
  } catch (err) {
    markRedisUnusable(err, 'probeRedis');
    return false;
  }
}

/** BullMQ worker options — longer stalledInterval = fewer Upstash commands. */
export function bullWorkerPollOptions() {
  return {
    stalledInterval: config.queues.stalledIntervalMs,
    maxStalledCount: 1,
    lockDuration: Math.max(config.queues.stalledIntervalMs, 30_000),
  };
}
