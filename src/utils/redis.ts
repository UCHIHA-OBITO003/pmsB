import Redis from 'ioredis';
import { config } from './config';
import { logger } from './logger';
import { isRedisQuotaOrUnavailableError, markRedisUnusable } from '../queues/queue-runtime';

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

redis.on('error', (err) => {
  if (isRedisQuotaOrUnavailableError(err)) {
    markRedisUnusable(err, 'redis.on(error)');
    logger.warn({ err }, 'Redis error (quota or connection) — BullMQ fallbacks active');
    return;
  }
  logger.error({ err }, 'Redis error');
});

redis.on('connect', () => {
  logger.debug('Redis connected');
});
