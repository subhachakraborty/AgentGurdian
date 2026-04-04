// src/routes/connections.ts — Service Connection Routes
import { Router, Request, Response } from 'express';
import { requireAuth, getUserId } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { auth0Management } from '../config/auth0';
import { emitConnectionRevoked } from '../services/notificationService';
import { SERVICE_CONNECTION_MAP } from '@agent-guardian/shared';
import { DeleteUserIdentityByUserIdProviderEnum } from 'auth0';

const router = Router();

// GET /api/v1/connections — List all connections for current user
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const auth0UserId = getUserId(req);
    if (!auth0UserId) return res.status(401).json({ error: 'No user ID' });

    const user = await prisma.user.findUnique({ where: { auth0UserId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const connections = await prisma.serviceConnection.findMany({
      where: { userId: user.id },
      orderBy: { connectedAt: 'desc' },
    });

    // Include all supported services (even unconnected ones)
    const allServices = ['GMAIL', 'GITHUB', 'SLACK', 'NOTION'];
    const result = allServices.map((service) => {
      const conn = connections.find((c: any) => c.service === service);
      return {
        service,
        status: conn?.status || 'NOT_CONNECTED',
        connectionId: conn?.id || null,
        connectedAt: conn?.connectedAt || null,
        lastUsedAt: conn?.lastUsedAt || null,
        revokedAt: conn?.revokedAt || null,
      };
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// GET /api/v1/connections/:service/authorize — Start OAuth flow via Token Vault
router.get('/:service/authorize', requireAuth, async (req: Request, res: Response) => {
  try {
    const { service } = req.params;
    const auth0UserId = getUserId(req);
    if (!auth0UserId) return res.status(401).json({ error: 'No user ID' });

    const connectionName = SERVICE_CONNECTION_MAP[service.toUpperCase() as keyof typeof SERVICE_CONNECTION_MAP];
    if (!connectionName) {
      return res.status(400).json({ error: 'Invalid service', message: `Unknown service: ${service}` });
    }

    // Generate Auth0 authorization URL for Token Vault connection
    // redirect_uri MUST point to the BACKEND callback handler — NOT the frontend.
    // The backend processes state, upserts the DB, then redirects to the frontend.
    const callbackUrl = `${env.API_BASE_URL}/api/v1/connections/callback`;
    const authUrl = `https://${env.AUTH0_DOMAIN}/authorize?` +
      `response_type=code&` +
      `client_id=${env.AUTH0_CLIENT_ID}&` +
      `connection=${connectionName}&` +
      `redirect_uri=${encodeURIComponent(callbackUrl)}&` +
      `scope=openid profile email&` +
      `state=${encodeURIComponent(JSON.stringify({ service: service.toUpperCase(), userId: auth0UserId }))}`;

    res.json({ authUrl });
  } catch (err: any) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// GET /api/v1/connections/callback — OAuth callback from Token Vault
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const { state, code, error } = req.query;

    if (error) {
      logger.error('OAuth callback error', { error });
      return res.redirect(`${env.FRONTEND_URL}/connections?error=${error}`);
    }

    if (!state) {
      return res.redirect(`${env.FRONTEND_URL}/connections?error=missing_state`);
    }

    const stateData = JSON.parse(decodeURIComponent(state as string));
    const { service, userId: auth0UserId } = stateData;

    // Find user
    const user = await prisma.user.findUnique({ where: { auth0UserId } });
    if (!user) {
      return res.redirect(`${env.FRONTEND_URL}/connections?error=user_not_found`);
    }

    // Upsert service connection
    await prisma.serviceConnection.upsert({
      where: { userId_service: { userId: user.id, service } },
      update: { status: 'ACTIVE', connectedAt: new Date(), revokedAt: null },
      create: { userId: user.id, service, status: 'ACTIVE' },
    });

    logger.info('Service connected', { userId: user.id, service });
    res.redirect(`${env.FRONTEND_URL}/connections?connected=${service}`);
  } catch (err: any) {
    logger.error('Connection callback error', { error: err.message });
    res.redirect(`${env.FRONTEND_URL}/connections?error=callback_failed`);
  }
});

// DELETE /api/v1/connections/:service — Revoke connection
router.delete('/:service', requireAuth, async (req: Request, res: Response) => {
  try {
    const { service } = req.params;
    const auth0UserId = getUserId(req);
    if (!auth0UserId) return res.status(401).json({ error: 'No user ID' });

    const user = await prisma.user.findUnique({ where: { auth0UserId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Update DB status
    const connection = await prisma.serviceConnection.updateMany({
      where: { userId: user.id, service: service.toUpperCase() as any, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    if (connection.count === 0) {
      return res.status(404).json({ error: 'no_active_connection', message: `No active ${service} connection found.` });
    }

    // Revoke from Auth0 Token Vault
    const connectionProviderMap: Record<string, string> = {
      GMAIL: 'google-oauth2',
      GITHUB: 'github',
      SLACK: 'slack',
      NOTION: 'notion',
    };

    try {
      const provider = connectionProviderMap[service.toUpperCase()];
      if (provider) {
        const auth0User = await auth0Management.users.get({ id: auth0UserId });
        if (auth0User.data && auth0User.data.identities) {
          const identityToUnlink = auth0User.data.identities.find(i => i.provider === provider);
          if (identityToUnlink) {
            await auth0Management.users.unlink({
              id: auth0UserId,
              provider: provider as DeleteUserIdentityByUserIdProviderEnum,
              user_id: identityToUnlink.user_id
            });
            logger.info('Auth0 Token Vault connection revoked', { auth0UserId, service });
          }
        }
      }
    } catch (err: any) {
      logger.warn('Failed to revoke Auth0 Token Vault connection', { error: err.message, service });
    }

    // Emit real-time update
    emitConnectionRevoked(auth0UserId, service.toUpperCase());

    logger.info('Service connection revoked', { userId: user.id, service });
    res.json({ status: 'revoked', service: service.toUpperCase() });
  } catch (err: any) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

export default router;
