import dotenv from 'dotenv';
dotenv.config();

function envFlag(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((raw || '').trim());
}

function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/^['"]|['"]$/g, '').replace(/\/$/, '');
}

function normalizeMultilineSecret(raw: string | undefined): string {
  return (raw || '').replace(/\\n/g, '\n').trim();
}

/** Upstash / Render: paste only `rediss://...` or `redis://...`, not `redis-cli --tls -u ...` */
function normalizeRedisUrl(raw: string | undefined): string {
  const fallback = 'redis://localhost:6379';
  if (!raw?.trim()) return fallback;
  let s = raw.trim().replace(/^['"]|['"]$/g, '');
  const match = s.match(/(rediss?:\/\/\S+)/);
  if (match) {
    let url = match[1];
    if (url.endsWith('/') && url.split('@').length > 1) {
      url = url.slice(0, -1);
    }
    return url;
  }
  return s.split(/\s+/).pop() || fallback;
}

export const config = {
  /** Render and other hosts set `PORT`; local default 3001. */
  port: parseInt(process.env.PORT || '3001'),
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => normalizeOrigin(s))
    .filter((s) => Boolean(s) && s !== '*'),
  /** When true, reflect any browser Origin (works with credentials; less safe for production). */
  corsAllowAll:
    envFlag(process.env.CORS_ALLOW_ALL) ||
    (process.env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => normalizeOrigin(s))
      .includes('*'),

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-prod',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  db: {
    url: process.env.DATABASE_URL || '',
  },

  redis: {
    url: normalizeRedisUrl(process.env.REDIS_URL),
  },

  /**
   * BullMQ / Upstash: workers poll Redis constantly and can exhaust free-tier command quotas.
   * - QUEUE_MODE=inline — never enqueue to Redis; process jobs in-process (best when quota exceeded).
   * - DISABLE_BULLMQ_WORKERS=true — do not start workers (use with inline or another worker process).
   * - REDIS_OPTIONAL=true — API boots even if Redis ping fails (forces inline fallbacks).
   */
  queues: {
    mode: (() => {
      const raw = (process.env.QUEUE_MODE || '').trim().toLowerCase();
      if (raw === 'inline' || raw === 'redis') return raw as 'inline' | 'redis';
      if (envFlag(process.env.DISABLE_REDIS_QUEUES)) return 'inline' as const;
      return 'redis' as const;
    })(),
    workersEnabled: !envFlag(process.env.DISABLE_BULLMQ_WORKERS),
    redisOptional: envFlag(process.env.REDIS_OPTIONAL) || envFlag(process.env.DISABLE_REDIS_QUEUES),
    /** Worker stalled check interval — higher = fewer Redis commands (default 2 min in production). */
    stalledIntervalMs: parseInt(
      process.env.BULL_STALLED_INTERVAL_MS ||
        (process.env.NODE_ENV === 'production' ? '120000' : '60000'),
      10,
    ),
    /** Recover QUEUED email rows stuck after Redis outage (cron interval in definitions). */
    emailDrainBatchSize: parseInt(process.env.EMAIL_DRAIN_BATCH_SIZE || '5', 10),
  },

  ai: {
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    claudeModel: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
  },

  github: {
    appId: (process.env.GITHUB_APP_ID || '').trim(),
    appSlug: (process.env.GITHUB_APP_SLUG || '').trim(),
    clientId: (process.env.GITHUB_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GITHUB_CLIENT_SECRET || '').trim(),
    privateKey: normalizeMultilineSecret(process.env.GITHUB_PRIVATE_KEY),
    webhookSecret: (process.env.GITHUB_WEBHOOK_SECRET || '').trim(),
    installationUrl:
      (process.env.GITHUB_APP_INSTALL_URL || 'https://github.com/apps').trim().replace(/\/$/, ''),
    apiBaseUrl: (process.env.GITHUB_API_BASE_URL || 'https://api.github.com').trim().replace(/\/$/, ''),
  },

  email: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || 'noreply@pms.local',
    /** TCP + SMTP greeting; raise on slow cloud egress (ETIMEDOUT during CONN). */
    connectionTimeoutMs: parseInt(
      process.env.SMTP_CONNECTION_TIMEOUT_MS ||
        (process.env.NODE_ENV === 'production' ? '90000' : '45000'),
      10,
    ),
    greetingTimeoutMs: parseInt(
      process.env.SMTP_GREETING_TIMEOUT_MS || (process.env.NODE_ENV === 'production' ? '90000' : '45000'),
      10,
    ),
    socketTimeoutMs: parseInt(process.env.SMTP_SOCKET_TIMEOUT_MS || '120000', 10),
    /** Prefer IPv4 when the host resolves to IPv6 that your host cannot route (fixes some ETIMEDOUT on CONN). */
    forceIpv4:
      process.env.SMTP_FORCE_IPV4 === 'true' ||
      (process.env.NODE_ENV === 'production' && process.env.SMTP_FORCE_IPV4 !== 'false'),
    /** Limit parallel SMTP jobs — burst sends (owner reports) often time out on PaaS hosts. */
    workerConcurrency: parseInt(
      process.env.SMTP_WORKER_CONCURRENCY || (process.env.NODE_ENV === 'production' ? '1' : '3'),
      10,
    ),
    /** Reuse one connection at a time when pooling (reduces Gmail connection storms). */
    poolMaxConnections: parseInt(process.env.SMTP_POOL_MAX_CONNECTIONS || '1', 10),
  },

  google: {
    serviceAccountPath: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    sheetId: process.env.GOOGLE_SHEET_ID || '',
  },

  /** Codemagen (Redmine JSON API) — HTTP Basic only; used by sheet-less sync, legacy ticket refresh, mass extraction */
  codemagen: {
    baseUrl: (process.env.CODEMAGEN_BASE_URL || 'https://pms.codemagen.net').replace(/\/$/, ''),
    username: (
      process.env.CODEMAGEN_USERNAME ||
      process.env.REDMINE_USERNAME ||
      ''
    ).trim(),
    password: (process.env.CODEMAGEN_PASSWORD || process.env.REDMINE_PASSWORD || '').trim(),
  },

  upload: {
    dir: process.env.UPLOAD_DIR || './uploads',
    maxSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '50'),
  },

  app: {
    baseUrl: (process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(
      /\/$/,
      '',
    ),
  },

  features: {
    ai: process.env.ENABLE_AI_FEATURES === 'true',
    googleSheets: process.env.ENABLE_GOOGLE_SHEETS_SYNC === 'true',
    email: process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true',
    github: process.env.ENABLE_GITHUB_INTEGRATION === 'true',
  },

  /** Project `key` used when sheet rows reference Codemagen issues (e.g. EEP). */
  legacyTicketProjectKey: (process.env.LEGACY_TICKET_PROJECT_KEY || 'EEP').trim(),
};
