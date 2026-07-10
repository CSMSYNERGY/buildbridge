import { Router } from 'express';
import { requireAuth } from '../core/auth/jwt.js';
import { authLimiter } from '../core/middleware/rateLimiter.js';
import {
  connectQuickBooks,
  handleQuickBooksCallback,
} from '../controllers/quickbooksController.js';

const router = Router();

// GET /auth/quickbooks/connect → (authenticated) redirect to Intuit OAuth
router.get('/connect', authLimiter, requireAuth, connectQuickBooks);

// GET /auth/quickbooks/callback → exchange code + realmId, store credentials
router.get('/callback', authLimiter, handleQuickBooksCallback);

export default router;
