// src/services/executors/github.ts — GitHub API executor
import { logger } from '../../lib/logger';
import type { ExecutionResult } from './index';

const GITHUB_API = 'https://api.github.com';

export async function executeGithubAction(
  actionType: string,
  accessToken: string,
  payload?: Record<string, unknown>
): Promise<ExecutionResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  let owner = (payload?.owner as string) || '';
  const repo = (payload?.repo as string) || '';

  // AUTO-RESOLVE OWNER: If the LLM doesn't know the owner, use the github token to figure out exactly who is logged in!
  if (!owner) {
    const userRes = await fetch(`${GITHUB_API}/user`, { headers });
    if (!userRes.ok) throw new Error(`Could not auto-resolve GitHub user: ${userRes.status}`);
    const userData: any = await userRes.json();
    owner = userData.login;
    logger.info(`Auto-resolved GitHub owner dynamically to: ${owner}`);
  }

  switch (actionType) {
    case 'github.read_repositories': {
      // Fetches repos for the authenticated user (bound to the acting userId token)
      const res = await fetch(`${GITHUB_API}/user/repos?per_page=100`, { headers });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data: any = await res.json();
      return { success: true, data, metadata: { repoCount: data.length } };
    }

    case 'github.read_issues': {
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues?state=open&per_page=20`, { headers });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data: any = await res.json();
      return { success: true, data, metadata: { issueCount: data.length } };
    }

    case 'github.read_prs': {
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&per_page=20`, { headers });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data: any = await res.json();
      return { success: true, data, metadata: { prCount: data.length } };
    }

    case 'github.read_code': {
      const path = (payload?.path as string) || 'README.md';
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, { headers });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data: any = await res.json();
      return { success: true, data, metadata: { filePath: path } };
    }

    case 'github.read_branches': {
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/branches?per_page=100`, { headers });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data: any = await res.json();
      return { success: true, data, metadata: { branchCount: data.length } };
    }

    case 'github.create_issue': {
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues`, {
        method: 'POST', headers,
        body: JSON.stringify({ title: payload?.title, body: payload?.body, labels: payload?.labels }),
      });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data: any = await res.json();
      return { success: true, data, metadata: { issueNumber: data.number } };
    }

    case 'github.comment_issue': {
      const issueNumber = payload?.issueNumber as number;
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
        method: 'POST', headers,
        body: JSON.stringify({ body: payload?.body }),
      });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data: any = await res.json();
      return { success: true, data, metadata: { issueNumber } };
    }

    case 'github.open_pr': {
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls`, {
        method: 'POST', headers,
        body: JSON.stringify({
          title: payload?.title,
          body: payload?.body,
          head: payload?.head,
          base: payload?.base || 'main',
        }),
      });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data: any = await res.json();
      return { success: true, data, metadata: { prNumber: data.number } };
    }

    case 'github.merge_pr':
    case 'github.merge_to_main': {
      const prNumber = payload?.prNumber as number;
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
        method: 'PUT', headers,
        body: JSON.stringify({ merge_method: payload?.mergeMethod || 'merge' }),
      });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data: any = await res.json();
      return { success: true, data, metadata: { prNumber, merged: true } };
    }

    case 'github.delete_branch': {
      const branch = payload?.branch as string;
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        method: 'DELETE', headers,
      });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      return { success: true, metadata: { branch, deleted: true } };
    }

    case 'github.close_issue': {
      const issueNumber = payload?.issueNumber as number;
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ state: 'closed' }),
      });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data: any = await res.json();
      return { success: true, data, metadata: { issueNumber, closed: true } };
    }

    case 'github.push_code': {
      logger.warn('github.push_code requires git operations — not directly supported via REST');
      return { success: true, metadata: { note: 'Push operations require git client' } };
    }

    default:
      throw new Error(`Unknown GitHub action: ${actionType}`);
  }
}
