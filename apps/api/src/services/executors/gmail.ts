// src/services/executors/gmail.ts — Gmail API executor
import { logger } from '../../lib/logger';
import type { ExecutionResult } from './index';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export async function executeGmailAction(
  actionType: string,
  accessToken: string,
  payload?: Record<string, unknown>
): Promise<ExecutionResult> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  switch (actionType) {
    case 'gmail.read_emails': {
      const res = await fetch(`${GMAIL_API_BASE}/messages?maxResults=${payload?.maxResults ?? 10}`, { headers });
      if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
      const data = (await res.json()) as any;
      return {
        success: true,
        data: data.messages || [],
        metadata: { messageCount: data.messages?.length ?? 0 },
      };
    }

    case 'gmail.search_emails': {
      const query = encodeURIComponent((payload?.query as string) || '');
      const res = await fetch(`${GMAIL_API_BASE}/messages?q=${query}&maxResults=20`, { headers });
      if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
      const data = (await res.json()) as any;
      return {
        success: true,
        data: data.messages || [],
        metadata: { query: payload?.query, resultCount: data.messages?.length ?? 0 },
      };
    }

    case 'gmail.send_email':
    case 'gmail.reply_email':
    case 'gmail.send_to_external':
    case 'gmail.send_bulk': {
      // Construct email
      const to = payload?.to as string;
      const subject = payload?.subject as string;
      const body = payload?.body as string;

      const rawEmail = btoa(
        `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
      ).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const res = await fetch(`${GMAIL_API_BASE}/messages/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ raw: rawEmail }),
      });

      if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
      const data = (await res.json()) as any;
      return {
        success: true,
        data,
        metadata: { to, subject: subject?.substring(0, 50) },
      };
    }

    case 'gmail.delete_email': {
      const messageId = payload?.messageId as string;
      const res = await fetch(`${GMAIL_API_BASE}/messages/${messageId}/trash`, {
        method: 'POST',
        headers,
      });
      if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
      return { success: true, metadata: { messageId, action: 'trashed' } };
    }

    case 'gmail.read_attachments': {
      const messageId = payload?.messageId as string;
      const res = await fetch(`${GMAIL_API_BASE}/messages/${messageId}?format=full`, { headers });
      if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
      const data = (await res.json()) as any;
      return {
        success: true,
        data,
        metadata: { messageId, hasAttachments: data.payload?.parts?.some((p: any) => p.filename) },
      };
    }

    default:
      logger.warn('Unknown Gmail action', { actionType });
      throw new Error(`Unknown Gmail action: ${actionType}`);
  }
}
