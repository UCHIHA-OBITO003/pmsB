import app from './app';
import { config } from './utils/config';
import { logger } from './utils/logger';
import { prisma } from './utils/prisma';
import { redis } from './utils/redis';
import { startCrons } from './crons';
import { startHttpKeepalive, stopHttpKeepalive } from './utils/httpKeepalive';

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

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  stopHttpKeepalive();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
});

bootstrap();
