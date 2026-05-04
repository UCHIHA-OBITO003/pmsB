import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { buildSystemOverview } from '../services/system-overview.service';

const router = Router();

router.use(authenticate);
router.get('/overview', requireRole('admin'), async (_req, res) => {
  const data = await buildSystemOverview();
  res.json({ success: true, data });
});

export default router;
