import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { buildGitHubInstallUrl, githubAppConfigured } from '../services/github-auth.service';
import {
  listGitHubInstallations,
  listGitHubInstallationProjects,
  listGitHubInstallationRepositories,
  processGitHubWebhook,
} from '../services/github.service';

const router = Router();

router.post('/webhooks', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));

  const result = await processGitHubWebhook(rawBody, req.headers as Record<string, unknown>);
  res.json({ success: true, data: result });
});

router.use(authenticate);

router.get('/app/status', requirePermission('projects', 'read'), async (_req, res) => {
  res.json({
    success: true,
    data: {
      configured: githubAppConfigured(),
      installUrl: buildGitHubInstallUrl(),
    },
  });
});

router.get('/install-url', requirePermission('projects', 'update'), async (req, res) => {
  const { projectId } = z
    .object({ projectId: z.string().uuid().optional() })
    .parse(req.query ?? {});

  res.json({ success: true, data: { url: buildGitHubInstallUrl(projectId) } });
});

router.get('/installations', requirePermission('projects', 'update'), async (_req, res) => {
  const data = await listGitHubInstallations();
  res.json({ success: true, data });
});

router.get('/installations/:installationId/repositories', requirePermission('projects', 'update'), async (req, res) => {
  const data = await listGitHubInstallationRepositories(req.params.installationId);
  res.json({ success: true, data });
});

router.get('/installations/:installationId/projects', requirePermission('projects', 'update'), async (req, res) => {
  const { ownerLogin } = z
    .object({ ownerLogin: z.string().min(1) })
    .parse(req.query ?? {});

  const data = await listGitHubInstallationProjects(req.params.installationId, ownerLogin);
  res.json({ success: true, data });
});

router.use((_req, _res, next) => {
  next(new AppError(404, 'GitHub endpoint not found', 'NOT_FOUND'));
});

export default router;
