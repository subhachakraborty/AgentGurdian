// src/services/executors/notion.ts — Notion API executor
import { logger } from '../../lib/logger';
import type { ExecutionResult } from './index';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export async function executeNotionAction(
  actionType: string,
  accessToken: string,
  payload?: Record<string, unknown>
): Promise<ExecutionResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION,
  };

  switch (actionType) {
    case 'notion.read_pages': {
      const res = await fetch(`${NOTION_API}/search`, {
        method: 'POST', headers,
        body: JSON.stringify({
          filter: { value: 'page', property: 'object' },
          page_size: payload?.pageSize ?? 20,
        }),
      });
      if (!res.ok) throw new Error(`Notion API error: ${res.status}`);
      const data = (await res.json()) as any;
      return { success: true, data: data.results, metadata: { pageCount: data.results?.length ?? 0 } };
    }

    case 'notion.update_page': {
      const pageId = payload?.pageId as string;
      const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ properties: payload?.properties }),
      });
      if (!res.ok) throw new Error(`Notion API error: ${res.status}`);
      const data = (await res.json()) as any;
      return { success: true, data, metadata: { pageId } };
    }

    case 'notion.create_page': {
      const res = await fetch(`${NOTION_API}/pages`, {
        method: 'POST', headers,
        body: JSON.stringify({
          parent: payload?.parent,
          properties: payload?.properties,
          children: payload?.children,
        }),
      });
      if (!res.ok) throw new Error(`Notion API error: ${res.status}`);
      const data = (await res.json()) as any;
      return { success: true, data, metadata: { newPageId: data.id } };
    }

    case 'notion.delete_page': {
      const pageId = payload?.pageId as string;
      const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ archived: true }),
      });
      if (!res.ok) throw new Error(`Notion API error: ${res.status}`);
      return { success: true, metadata: { pageId, archived: true } };
    }

    case 'notion.share_page': {
      logger.warn('Notion share_page requires workspace-level API access');
      return { success: true, metadata: { note: 'Sharing requires admin permissions' } };
    }

    default:
      throw new Error(`Unknown Notion action: ${actionType}`);
  }
}
