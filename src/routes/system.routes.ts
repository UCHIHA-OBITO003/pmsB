import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth';
import { buildSystemOverview } from '../services/system-overview.service';
import { getCodemagenEnabled, setCodemagenEnabled } from '../utils/system-settings';

const router = Router();

router.use(authenticate);
router.get('/feature-flags', async (_req, res) => {
  res.json({ success: true, data: { codemagenEnabled: await getCodemagenEnabled() } });
});

router.get('/overview', requireRole('admin'), async (_req, res) => {
  const data = await buildSystemOverview();
  res.json({ success: true, data });
});

router.patch('/feature-flags', requireRole('admin'), async (req, res) => {
  const body = z
    .object({
      codemagenEnabled: z.boolean(),
    })
    .parse(req.body ?? {});

  const codemagenEnabled = await setCodemagenEnabled(body.codemagenEnabled);
  res.json({ success: true, data: { codemagenEnabled } });
});

export default router;
