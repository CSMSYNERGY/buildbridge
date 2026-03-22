import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { requestLogger } from './core/middleware/logger.js';
import { generalLimiter } from './core/middleware/rateLimiter.js';
import { errorHandler } from './core/middleware/errorHandler.js';
import { env } from './core/env.js';

// Routes
import authRoutes from './routes/authRoutes.js';
import actionsRoutes from './routes/actionsRoutes.js';
import webApiRoutes from './routes/webApiRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';
import adminRoutes from './routes/adminRoutes.js';

console.log('[index] All imports resolved. Configuring Express...');
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Trust Railway's proxy (needed for rate limiting and correct IP detection)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      // Allow GHL to embed in an iframe (removes the default 'self' restriction)
      frameAncestors: false,
    },
  },
  // Also disable X-Frame-Options header for iframe embedding
  frameguard: false,
}));

// CORS
app.use(cors({
  origin: env.SMARTBUILD_BASE_URL,
  credentials: true,
}));

// Body parsing — capture rawBody for webhook signature verification
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Logging
app.use(requestLogger);

// Rate limiting
app.use(generalLimiter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// API Routes
app.use('/auth', authRoutes);
app.use('/actions', actionsRoutes);
app.use('/api', webApiRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/admin', adminRoutes);

// Serve React frontend at /buildbridge
app.use('/buildbridge', express.static(join(__dirname, '..', 'frontend', 'dist')));
app.get('/buildbridge/*splat', (_req, res) => {
  res.sendFile(join(__dirname, '..', 'frontend', 'dist', 'index.html'));
});

// Global error handler (must be last)
app.use(errorHandler);

console.log('[index] Starting listener on port', env.PORT);
app.listen(env.PORT, () => {
  console.log(`[index] BuildBridge v2 listening on port ${env.PORT} [${env.NODE_ENV}]`);
});

export default app;
