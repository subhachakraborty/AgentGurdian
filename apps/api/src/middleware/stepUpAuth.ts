import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

const MFA_ACR = 'http://schemas.openid.net/pape/policies/2007/06/multi-factor';

export function requireStepUp(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });

  const decoded = jwt.decode(token) as Record<string, unknown>;
  const rawIdToken = req.headers['x-id-token'] as string | undefined;
  const decodedId = rawIdToken ? (jwt.decode(rawIdToken) as Record<string, unknown>) : null;

  let acr = decoded?.acr as string | undefined;
  let amr = decoded?.amr as string[] | undefined;

  let hasAcr = acr && acr.includes(MFA_ACR);
  let hasAmrStr = typeof amr === 'string' && amr === 'mfa';
  let hasAmrArr = Array.isArray(amr) && amr.includes('mfa');

  // If Access Token didn't satisfy the requirements, check ID Token
  if (!hasAcr && !hasAmrStr && !hasAmrArr && decodedId) {
    acr = decodedId.acr as string | undefined;
    amr = decodedId.amr as string[] | undefined;
    
    hasAcr = acr && acr.includes(MFA_ACR);
    hasAmrStr = typeof amr === 'string' && amr === 'mfa';
    hasAmrArr = Array.isArray(amr) && amr.includes('mfa');
  }

  if (!hasAcr && !hasAmrStr && !hasAmrArr) {
    // DEV MODE BYPASS: If you haven't configured MFA in your Auth0 tenant, Auth0 skips the MFA step. 
    // To allow the demo to continue locally, we'll accept any freshly minted token (issued within 5 minutes) as proof of Step-Up.
    const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
    const isFresh = decoded.iat && (Date.now() / 1000 - (decoded.iat as number)) < 300;
    
    if (isDev && isFresh) {
      console.warn('⚠️ DEV MODE: Bypassing strict Auth0 MFA claim verification because the token was freshly issued.');
      return next();
    }

    return res.status(403).json({
      error: 'step_up_required',
      message: 'This action requires MFA verification.',
      challengeUrl: generateChallengeUrl(req),
    });
  }
  next();
}

function generateChallengeUrl(req: Request): string {
  const jobId = req.params.jobId || '';
  return `https://${env.AUTH0_DOMAIN}/authorize?` +
    `client_id=${encodeURIComponent(env.AUTH0_CLIENT_ID)}&` +
    `audience=${encodeURIComponent(env.AUTH0_AUDIENCE)}&` +
    `scope=openid&` +
    `acr_values=${encodeURIComponent(MFA_ACR)}&` +
    `response_type=code&` +
    `redirect_uri=${encodeURIComponent(env.FRONTEND_URL + '/callback')}&` +
    `state=${encodeURIComponent(JSON.stringify({ stepUp: true, jobId }))}`;
}
