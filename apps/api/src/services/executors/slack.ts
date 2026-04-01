// src/services/executors/slack.ts — Slack API executor
import { logger } from '../../lib/logger';
import type { ExecutionResult } from './index';

const SLACK_API = 'https://slack.com/api';

export async function executeSlackAction(
  actionType: string,
  accessToken: string,
  payload?: Record<string, unknown>
): Promise<ExecutionResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  switch (actionType) {
    case 'slack.read_channels': {
      const res = await fetch(`${SLACK_API}/conversations.list?types=public_channel&limit=50`, { headers });
      if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
      const data = (await res.json()) as any;
      if (!data.ok) throw new Error(`Slack error: ${data.error}`);
      return { success: true, data: data.channels, metadata: { channelCount: data.channels?.length ?? 0 } };
    }

    case 'slack.read_dms': {
      const res = await fetch(`${SLACK_API}/conversations.list?types=im&limit=50`, { headers });
      if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
      const data = (await res.json()) as any;
      if (!data.ok) throw new Error(`Slack error: ${data.error}`);
      return { success: true, data: data.channels, metadata: { dmCount: data.channels?.length ?? 0 } };
    }

    case 'slack.post_to_channel':
    case 'slack.post_to_general': {
      const res = await fetch(`${SLACK_API}/chat.postMessage`, {
        method: 'POST', headers,
        body: JSON.stringify({
          channel: payload?.channel as string,
          text: payload?.text as string,
        }),
      });
      if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
      const data = (await res.json()) as any;
      if (!data.ok) throw new Error(`Slack error: ${data.error}`);
      return { success: true, data, metadata: { channel: payload?.channel } };
    }

    case 'slack.send_dm': {
      const res = await fetch(`${SLACK_API}/chat.postMessage`, {
        method: 'POST', headers,
        body: JSON.stringify({
          channel: payload?.userId as string,
          text: payload?.text as string,
        }),
      });
      if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
      const data = (await res.json()) as any;
      if (!data.ok) throw new Error(`Slack error: ${data.error}`);
      return { success: true, data, metadata: { dmTo: payload?.userId } };
    }

    case 'slack.create_channel': {
      const res = await fetch(`${SLACK_API}/conversations.create`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: payload?.name as string }),
      });
      if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
      const data = (await res.json()) as any;
      if (!data.ok) throw new Error(`Slack error: ${data.error}`);
      return { success: true, data: data.channel, metadata: { channelName: payload?.name } };
    }

    default:
      throw new Error(`Unknown Slack action: ${actionType}`);
  }
}
