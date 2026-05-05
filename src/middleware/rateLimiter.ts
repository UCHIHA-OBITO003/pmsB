import rateLimit from 'express-rate-limit';
import { config } from '../utils/config';

/** No throttling in development, or when DISABLE_RATE_LIMIT=true (e.g. prod-like local runs). */
function skipRateLimit(): boolean {
  if (config.nodeEnv === 'development') return true;
  return process.env.DISABLE_RATE_LIMIT === 'true';
}

export const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipRateLimit(),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
});

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => skipRateLimit(),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many login attempts' } },
});
