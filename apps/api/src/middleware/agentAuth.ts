// src/middleware/agentAuth.ts — Agent Identity (Section 16.1.4)
import { Request, Response, NextFunction } from 'express';
import { auth0Management } from '../config/auth0';
import { prisma } from '../lib/prisma';

const USER_ID_CLAIM  = 'https://agentguardian.com/userId';
const AGENT_ID_CLAIM = 'https://agentguardian.com/agentId';
const AGENT_SCOPE    = 'agent:act';

export function requireAgentAuth(
  req: Request, res: Response, next: NextFunction
) {
  const payload = (req as any).auth?.payload;
  if (!payload) {
    return res.status(401).json({ error: 'No token presented' });
  }

  // Verify this is an M2M agent token, not a human user token
  const scopes = ((payload.scope as string) ?? '').split(' ');
  if (!scopes.includes(AGENT_SCOPE)) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'This endpoint requires agent:act scope.',
    });
  }

  // Extract the userId the agent is acting on behalf of
  let userId  = payload[USER_ID_CLAIM] as string | undefined;
  const agentId = (payload[AGENT_ID_CLAIM] as string | undefined) || 'demo-agent-1';

  if (!userId) {
    if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
      const requestedAuth0UserId = req.header('x-agent-auth0-user-id');
      const requestedEmail = req.header('x-agent-user-email');

      if (!requestedAuth0UserId && !requestedEmail) {
        return res.status(403).json({
          error: 'forbidden',
          message: 'Agent token is missing user binding. Set x-agent-auth0-user-id or x-agent-user-email in development, or configure the Auth0 M2M Action.',
        });
      }

      return resolveDevelopmentAgentUser(requestedAuth0UserId, requestedEmail).then((matchedUser: any) => {
        if (!matchedUser) {
          return res.status(403).json({
            error: 'forbidden',
            message: requestedEmail
              ? `No user found for email ${requestedEmail}. Try AGENT_ACTING_AUTH0_USER_ID if your DB profile was created without an email claim.`
              : `No user found for ID ${requestedAuth0UserId}.`,
          });
        }

        (req as any).actingUserId = matchedUser.auth0UserId;
        (req as any).agentId = agentId;
        next();
      }).catch((err: any) => {
        return res.status(500).json({ error: 'internal_error', message: err.message });
      });
    }

    return res.status(403).json({
      error: 'forbidden',
      message: 'Agent token is missing user binding. Check Auth0 M2M Action.',
    });
  }

  // Attach to request for downstream handlers
  (req as any).actingUserId = userId;
  (req as any).agentId = agentId;
  next();
}

// Helper to get acting user ID (works for both human and agent requests)
export function getActingUserId(req: Request): string {
  return (req as any).actingUserId ?? (req as any).auth?.payload?.sub;
}

export function getAgentId(req: Request): string | undefined {
  return (req as any).agentId;
}

async function resolveDevelopmentAgentUser(
  requestedAuth0UserId?: string,
  requestedEmail?: string
) {
  if (requestedAuth0UserId) {
    return prisma.user.findFirst({
      where: {
        OR: [
          { auth0UserId: requestedAuth0UserId },
          { id: requestedAuth0UserId },
        ],
      },
    });
  }

  if (!requestedEmail) {
    return null;
  }

  const directEmailMatch = await prisma.user.findFirst({
    where: {
      email: {
        equals: requestedEmail,
        mode: 'insensitive',
      },
    },
  });

  if (directEmailMatch) {
    return directEmailMatch;
  }

  const auth0Users = await auth0Management.usersByEmail.getByEmail({ email: requestedEmail });
  const auth0UserIds = (auth0Users.data || [])
    .map((user: any) => user.user_id)
    .filter(Boolean);

  if (auth0UserIds.length === 0) {
    return null;
  }

  return prisma.user.findFirst({
    where: {
      auth0UserId: {
        in: auth0UserIds,
      },
    },
  });
}
