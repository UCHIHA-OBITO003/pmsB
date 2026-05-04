import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/bottlenecks', async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  const bottlenecks = await prisma.bottleneckEvent.findMany({
    where: { ...(projectId ? { projectId } : {}), resolved: false },
    orderBy: { staleDays: 'desc' },
    take: 20,
  });
  res.json({ success: true, data: bottlenecks });
});

router.get('/predictions', async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  const risks = await prisma.predictiveRisk.findMany({
    where: { ...(projectId ? { projectId } : {}), resolved: false },
    orderBy: [{ severity: 'desc' }, { score: 'desc' }],
    take: 20,
  });
  res.json({ success: true, data: risks });
});

router.get('/confidence-score', async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  const score = await prisma.confidenceScore.findFirst({
    where: projectId ? { projectId } : {},
    orderBy: { computedAt: 'desc' },
  });
  res.json({ success: true, data: score });
});

router.get('/feed', async (req, res) => {
  const { projectId } = req.query as { projectId?: string };
  const events = await prisma.insightEvent.findMany({
    where: { ...(projectId ? { projectId } : {}), isRead: false },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  res.json({ success: true, data: events });
});

export default router;
