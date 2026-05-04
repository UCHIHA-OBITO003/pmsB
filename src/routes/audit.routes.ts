import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/', requirePermission('audit', 'read'), async (req, res) => {
  const { resource, actorId, page = '1', limit = '50' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where: any = {};
  if (resource) where.resource = resource;
  if (actorId) where.actorId = actorId;

  const [logs, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.json({ success: true, data: { logs, total, page: parseInt(page) } });
});

export default router;
