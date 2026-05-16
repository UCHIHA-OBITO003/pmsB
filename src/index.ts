import app from './app';
import { config } from './utils/config';
import { logger } from './utils/logger';
import { prisma } from './utils/prisma';
import { redis } from './utils/redis';
import { startCrons } from './crons';
import { startHttpKeepalive, stopHttpKeepalive } from './utils/httpKeepalive';
import { startImportWorker, stopImportWorker } from './queues/workers/import.worker';
import { startEmailWorker, stopEmailWorker } from './queues/workers/email.worker';
import { startLegacySyncWorker, stopLegacySyncWorker } from './queues/workers/legacy-sync.worker';
import { startGitHubWorker, stopGitHubWorker } from './queues/workers/github.worker';
import { getQueueMode, probeRedis, shouldRunBullWorkers } from './queues/queue-runtime';

async function bootstrap() {
  try {
    // Test DB connection
    await prisma.$connect();
    logger.info('✅ PostgreSQL connected');

    const redisOk = await probeRedis(redis);
    if (redisOk) {
      logger.info('✅ Redis connected');
    } else if (config.queues.redisOptional || getQueueMode() === 'inline') {
      logger.warn(
        { queueMode: getQueueMode() },
        'Redis unavailable — API will use inline job processing (no BullMQ workers)',
      );
    } else {
      throw new Error('Redis ping failed. Set REDIS_OPTIONAL=true or QUEUE_MODE=inline to start without Redis.');
    }

    // Start scheduled jobs
    startCrons();
    logger.info('✅ Cron jobs started');

    if (shouldRunBullWorkers()) {
      startImportWorker();
      startEmailWorker();
      startLegacySyncWorker();
      startGitHubWorker();
      logger.info('✅ BullMQ workers started');
    } else {
      logger.info(
        { queueMode: getQueueMode(), workersEnabled: config.queues.workersEnabled },
        'BullMQ workers not started — jobs run inline when enqueued',
      );
    }

    // Start server
    app.listen(config.port, () => {
      logger.info(`🚀 Server running on http://localhost:${config.port}`);
      logger.info(`📚 API Docs: http://localhost:${config.port}/api-docs`);
      startHttpKeepalive();
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    await prisma.$disconnect();
    process.exit(1);
  }
}

async function shutdown() {
  logger.info('Shutdown signal received — draining workers…');
  stopHttpKeepalive();
  // Wait for in-flight jobs to finish before exiting
  await Promise.all([stopImportWorker(), stopEmailWorker(), stopLegacySyncWorker(), stopGitHubWorker()]);
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

bootstrap();
