// src/services/tokenVault.ts — Token Vault wrapper with error handling (Section 16.7)
import { auth0Management } from '../config/auth0';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const serviceConnectionMap: Record<string, string> = {
  gmail: 'google-gmail',
  github: 'github',
  slack: 'slack',
  notion: 'notion',
};

// Custom error classes for clean upstream handling
export class ServiceNotConnectedError extends Error {
  constructor(public service: string) {
    super(`Service '${service}' is not connected for this user.`);
    this.name = 'ServiceNotConnectedError';
  }
}

export class TokenExpiredError extends Error {
  constructor(public service: string) {
    super(`Refresh token for '${service}' is expired. User must reconnect.`);
    this.name = 'TokenExpiredError';
  }
}

export async function getServiceToken(
  userId: string,
  service: 'gmail' | 'github' | 'slack' | 'notion'
): Promise<string> {
  try {
    // Auth0 Token Vault API — returns short-lived access token
    const connection = serviceConnectionMap[service];
    if (!connection) {
      throw new ServiceNotConnectedError(service);
    }

    // In production, this calls auth0Management.users.getTokenVaultToken()
    // We attempt explicit calls and catch SDK incompatibilities gracefully
    try {
      const response = await (auth0Management as any).tokenVault.getToken({
        userId,
        connection,
      });
      
      if (!response?.access_token) {
        throw new Error('Token Vault returned an empty or invalid access token');
      }
      
      return response.access_token;
    } catch (err: any) {
      // With Auth0 Node SDK v4, IDP access tokens are retrieved from the user's identities array
      if (err instanceof TypeError || (err.message && err.message.includes('not a function')) || err.message?.includes('tokenVault is undefined')) {
        const userResp = await auth0Management.users.get({ id: userId });
        const user = userResp.data;
        
        const identity = user.identities?.find(i => i.provider === connection || i.connection === connection);
        
        if (!identity?.access_token) {
          logger.warn(`No access_token found in identity for ${connection}. Token may be expired or Auth0 Management API lacks read:user_idp_tokens scope.`);
          throw new Error('Token Vault returned an empty or missing access token on fallback');
        }
        
        // Also ensure Auth0 passes down the token (requires Management API setup)
        return identity.access_token;
      }
      
      throw err; // Valid Auth0 Error!
    }
  } catch (err: any) {
    logger.error('Token Vault error', {
      service,
      userId,
      error: err.message,
      statusCode: err.statusCode,
    });

    if (err instanceof ServiceNotConnectedError) throw err;
    if (err instanceof TokenExpiredError) throw err;

    if (err.statusCode === 404) {
      throw new ServiceNotConnectedError(service);
    }
    if (err.statusCode === 401) {
      // Refresh token invalid — user must reconnect
      await markConnectionRevoked(userId, service);
      throw new TokenExpiredError(service);
    }
    throw err;
  }
}

async function markConnectionRevoked(userId: string, service: string): Promise<void> {
  try {
    await prisma.serviceConnection.updateMany({
      where: {
        userId,
        service: service.toUpperCase() as any,
        status: 'ACTIVE',
      },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
      },
    });
    logger.warn('Service connection marked as revoked', { userId, service });
  } catch (err: any) {
    logger.error('Failed to mark connection as revoked', { error: err.message });
  }
}
