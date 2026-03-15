import { Router } from 'express';
import { redirectToGHL, handleCallback } from '../controllers/authController.js';
import { authLimiter } from '../core/middleware/rateLimiter.js';

const router = Router();

// GET /auth → redirect to GHL OAuth chooser
router.get('/', authLimiter, redirectToGHL);

// GET /auth/callback → exchange code, store tokens, set cookie
router.get('/callback', authLimiter, handleCallback);

export default router;
