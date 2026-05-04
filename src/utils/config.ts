import dotenv from 'dotenv';
dotenv.config();

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
  port: parseInt(process.env.PORT || '3001'),
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

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

  ai: {
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    claudeModel: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
  },

  email: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || 'noreply@pms.local',
    /** TCP + SMTP greeting; raise on slow cloud egress (ETIMEDOUT during CONN). */
    connectionTimeoutMs: parseInt(process.env.SMTP_CONNECTION_TIMEOUT_MS || '45000', 10),
    greetingTimeoutMs: parseInt(process.env.SMTP_GREETING_TIMEOUT_MS || '45000', 10),
    socketTimeoutMs: parseInt(process.env.SMTP_SOCKET_TIMEOUT_MS || '120000', 10),
    /** Prefer IPv4 when the host resolves to IPv6 that your host cannot route (fixes some ETIMEDOUT on CONN). */
    forceIpv4: process.env.SMTP_FORCE_IPV4 === 'true',
  },

  google: {
    serviceAccountPath: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    sheetId: process.env.GOOGLE_SHEET_ID || '',
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
  },
};
