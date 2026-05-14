import { Router } from 'express';
import { z } from 'zod';
import { loginUser, registerUser, refreshTokens, logoutUser, LoginSchema, RegisterSchema } from '../services/auth.service';
import { authRateLimiter } from '../middleware/rateLimiter';
import { requestPasswordResetOtp, verifyOtpAndResetPassword } from '../services/password-reset.service';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Login with email and password
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Login successful
 */
router.post('/login', authRateLimiter, async (req, res) => {
  const data = LoginSchema.parse(req.body);
  const result = await loginUser(data.email, data.password);
  res.json({ success: true, data: result });
});

router.post('/password-reset/request', authRateLimiter, async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const result = await requestPasswordResetOtp(email);
  res.json({
    success: true,
    message: 'If an account exists, a reset code has been sent.',
    data: {
      expiresInMinutes: result.expiresInMinutes ?? 15,
      resendCooldownSeconds: result.resendCooldownSeconds ?? 60,
      queued: result.queued ?? true,
    },
  });
});

router.post('/password-reset/confirm', authRateLimiter, async (req, res) => {
  const { email, otp, newPassword } = z
    .object({
      email: z.string().email(),
      otp: z.string().regex(/^[0-9]{6}$/),
      newPassword: z.string().min(8),
    })
    .parse(req.body);

  await verifyOtpAndResetPassword(email, otp, newPassword);
  res.json({ success: true, message: 'Password updated. Sign in with your new password.' });
});

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new user
 *     security: []
 */
router.post('/register', authRateLimiter, async (req, res) => {
  const data = RegisterSchema.parse(req.body);
  const result = await registerUser(data);
  res.status(201).json({ success: true, data: result });
});

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Refresh access token
 *     security: []
 */
router.post('/refresh', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  const result = await refreshTokens(refreshToken);
  res.json({ success: true, data: result });
});

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Logout and revoke refresh token
 */
router.post('/logout', authenticate, async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  await logoutUser(refreshToken);
  res.json({ success: true, message: 'Logged out' });
});

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get current user profile
 */
router.get('/me', authenticate, async (req: AuthRequest, res) => {
  res.json({ success: true, data: req.user });
});

export default router;
