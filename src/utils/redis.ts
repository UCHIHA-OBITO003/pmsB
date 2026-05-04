import Redis from 'ioredis';
import { config } from './config';
import { logger } from './logger';

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis error');
});

redis.on('connect', () => {
  logger.debug('Redis connected');
});
