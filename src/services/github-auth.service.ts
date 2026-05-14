import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { AppError } from '../middleware/errorHandler';
import { config } from '../utils/config';

export function githubAppConfigured(): boolean {
  return Boolean(config.github.appId && config.github.privateKey && config.github.webhookSecret);
}

export function assertGitHubAppConfigured() {
  if (!githubAppConfigured()) {
    throw new AppError(503, 'GitHub integration is not configured on the server', 'GITHUB_NOT_CONFIGURED');
  }
}

export function buildGitHubInstallUrl(projectId?: string): string {
  const base =
    config.github.appSlug
      ? `https://github.com/apps/${config.github.appSlug}/installations/new`
      : config.github.installationUrl;
  if (!projectId) return base;
  const url = new URL(base);
  url.searchParams.set('state', projectId);
  return url.toString();
}

export function signGitHubAppJwt() {
  assertGitHubAppConfigured();
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iat: now - 60,
      exp: now + 9 * 60,
      iss: config.github.appId,
    },
    config.github.privateKey,
    { algorithm: 'RS256' },
  );
}

export function verifyGitHubWebhookSignature(rawBody: Buffer, signatureHeader?: string | string[] | undefined): boolean {
  assertGitHubAppConfigured();
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', config.github.webhookSecret).update(rawBody).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
