import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/', requirePermission('roles', 'read'), async (req, res) => {
  const roles = await prisma.role.findMany({
    include: { permissions: { include: { permission: true } } },
  });
  res.json({ success: true, data: roles });
});

router.get('/permissions', requirePermission('roles', 'read'), async (req, res) => {
  const permissions = await prisma.permission.findMany({ orderBy: [{ resource: 'asc' }, { action: 'asc' }] });
  res.json({ success: true, data: permissions });
});

export default router;
