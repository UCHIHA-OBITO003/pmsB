import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res) => {
  const { page = '1', limit = '20' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [notifications, total] = await prisma.$transaction([
    prisma.notification.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
    }),
    prisma.notification.count({ where: { userId: req.user!.id } }),
  ]);

  const unread = await prisma.notification.count({ where: { userId: req.user!.id, isRead: false } });

  res.json({ success: true, data: { notifications, total, unread, page: parseInt(page) } });
});

router.patch('/:id/read', async (req: AuthRequest, res) => {
  await prisma.notification.updateMany({
    where: { id: req.params.id, userId: req.user!.id },
    data: { isRead: true, readAt: new Date() },
  });
  res.json({ success: true });
});

router.patch('/read-all', async (req: AuthRequest, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.user!.id, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  res.json({ success: true });
});

export default router;
