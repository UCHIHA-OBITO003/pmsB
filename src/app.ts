import 'express-async-errors';
import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { config } from './utils/config';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import { rateLimiter } from './middleware/rateLimiter';
import { countApiHits } from './middleware/apiHits.middleware';
import { swaggerSpec } from './utils/swagger';

// Routes
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import roleRoutes from './routes/role.routes';
import projectRoutes from './routes/project.routes';
import ticketRoutes from './routes/ticket.routes';
import sprintRoutes from './routes/sprint.routes';
import boardRoutes from './routes/board.routes';
import excelRoutes from './routes/excel.routes';
import notificationRoutes from './routes/notification.routes';
import auditRoutes from './routes/audit.routes';
import analyticsRoutes from './routes/analytics.routes';
import insightRoutes from './routes/insight.routes';
import aiRoutes from './routes/ai.routes';
import timesheetRoutes from './routes/timesheet.routes';
import systemRoutes from './routes/system.routes';
import organisationRoutes from './routes/organisation.routes';
import companyRoutes from './routes/company.routes';
import teamRoutes from './routes/team.routes';

const app = express();

// Security
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (config.corsAllowAll) {
        callback(null, true);
        return;
      }
      const normalizedOrigin = origin.replace(/\/$/, '');
      if (config.corsOrigins.includes(normalizedOrigin)) {
        callback(null, true);
        return;
      }
      logger.warn({ origin, allowedOrigins: config.corsOrigins, allowAll: config.corsAllowAll }, 'CORS origin not allowed');
      callback(null, false);
    },
    credentials: true,
  }),
);
app.use(compression());

// Logging
app.use(pinoHttp({ logger }));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
app.use('/api/', rateLimiter);
app.use('/api/', countApiHits);

// API Docs
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'EEP API Docs',
  customCss: '.swagger-ui .topbar { display: none }',
}));

// Root — avoids 404 spam from load balancers / probes (API lives under /api).
app.get('/', (_req, res) => {
  res.status(200).json({ ok: true, health: '/health', apiDocs: '/api-docs' });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', env: config.nodeEnv });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/sprints', sprintRoutes);
app.use('/api/board', boardRoutes);
app.use('/api/excel', excelRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/insights', insightRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/timesheets', timesheetRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/organisations', organisationRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/teams', teamRoutes);
app.use('/uploads', express.static(path.resolve(config.upload.dir)));

// Error handler (must be last)
app.use(errorHandler);

export default app;
