import app from './app';
import { config } from './utils/config';
import { logger } from './utils/logger';
import { prisma } from './utils/prisma';
import { redis } from './utils/redis';
import { startCrons } from './crons';
import { startHttpKeepalive, stopHttpKeepalive } from './utils/httpKeepalive';
import { startImportWorker, stopImportWorker } from './queues/workers/import.worker';
import { startEmailWorker, stopEmailWorker } from './queues/workers/email.worker';

async function bootstrap() {
  try {
    // Test DB connection
    await prisma.$connect();
    logger.info('✅ PostgreSQL connected');

    // Test Redis connection
    await redis.ping();
    logger.info('✅ Redis connected');

    // Start scheduled jobs
    startCrons();
    logger.info('✅ Cron jobs started');

    // Mount BullMQ workers (import-job + email-job)
    startImportWorker();
    startEmailWorker();

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
  await Promise.all([stopImportWorker(), stopEmailWorker()]);
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

bootstrap();
