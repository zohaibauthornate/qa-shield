/**
 * Linear GraphQL Client for QA Shield
 * Handles all Linear API interactions: read tickets, update status, post comments
 */

const LINEAR_API = 'https://api.linear.app/graphql';

interface LinearConfig {
  apiKey: string;
  teamId: string;
}

function getConfig(): LinearConfig {
  const apiKey = process.env.LINEAR_API_KEY;
  const teamId = process.env.LINEAR_TEAM_ID;
  if (!apiKey || !teamId) throw new Error('LINEAR_API_KEY and LINEAR_TEAM_ID required');
  return { apiKey, teamId };
}

async function linearQuery(query: string, variables?: Record<string, unknown>) {
  const { apiKey } = getConfig();
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// ============ Issue Queries ============

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number;
  state: { id: string; name: string; type: string };
  assignee?: { id: string; name: string; email: string };
  labels: { nodes: { id: string; name: string }[] };
  comments: { nodes: { id: string; body: string; user: { name: string }; createdAt: string }[] };
  createdAt: string;
  updatedAt: string;
  url: string;
}

export async function getIssue(issueId: string): Promise<LinearIssue> {
  const data = await linearQuery(`
    query GetIssue($id: String!) {
      issue(id: $id) {
        id identifier title description priority url createdAt updatedAt
        state { id name type }
        assignee { id name email }
        labels { nodes { id name } }
        comments { nodes { id body createdAt user { name } } }
      }
    }
  `, { id: issueId });
  return data.issue;
}

export async function getIssueByIdentifier(identifier: string): Promise<LinearIssue> {
  const [teamKey, numberStr] = identifier.split('-');
  const number = parseInt(numberStr, 10);
  const { teamId } = getConfig();
  const data = await linearQuery(`
    query SearchIssue($teamId: String!, $number: Float!) {
      team(id: $teamId) {
        issues(filter: { number: { eq: $number } }, first: 1) {
          nodes {
            id identifier title description priority url createdAt updatedAt
            state { id name type }
            assignee { id name email }
            labels { nodes { id name } }
            comments { nodes { id body createdAt user { name } } }
          }
        }
      }
    }
  `, { teamId, number });
  const issues = data.team.issues.nodes;
  if (!issues || issues.length === 0) throw new Error(`Issue ${identifier} not found`);
  return issues[0];
}

// ============ Issue Mutations ============

export async function addComment(issueId: string, body: string): Promise<string> {
  const data = await linearQuery(`
    mutation AddComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
        comment { id }
      }
    }
  `, { issueId, body });
  return data.commentCreate.comment.id;
}

export async function updateIssueState(issueId: string, stateId: string): Promise<boolean> {
  const data = await linearQuery(`
    mutation UpdateState($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        success
      }
    }
  `, { issueId, stateId });
  return data.issueUpdate.success;
}

export async function updateIssuePriority(issueId: string, priority: number): Promise<boolean> {
  const data = await linearQuery(`
    mutation UpdatePriority($issueId: String!, $priority: Int!) {
      issueUpdate(id: $issueId, input: { priority: $priority }) {
        success
      }
    }
  `, { issueId, priority });
  return data.issueUpdate.success;
}

export async function addLabel(issueId: string, labelIds: string[]): Promise<boolean> {
  const data = await linearQuery(`
    mutation AddLabels($issueId: String!, $labelIds: [String!]!) {
      issueUpdate(id: $issueId, input: { labelIds: $labelIds }) {
        success
      }
    }
  `, { issueId, labelIds });
  return data.issueUpdate.success;
}

export async function createIssue(input: {
  title: string;
  description: string;
  priority?: number;
  labelIds?: string[];
  stateId?: string;
  assigneeId?: string;
}): Promise<{ identifier: string; title: string; url: string; id: string }> {
  const { teamId } = getConfig();
  const data = await linearQuery(`
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id identifier title url
        }
      }
    }
  `, {
    input: {
      teamId,
      title: input.title,
      description: input.description,
      priority: input.priority || 0,
      labelIds: input.labelIds || [],
      stateId: input.stateId || WORKFLOW_STATES.TODO,
    },
  });

  if (!data.issueCreate.success) throw new Error('Failed to create issue');
  return data.issueCreate.issue;
}

// ============ Duplicate Detection ============

export async function findSimilarIssue(titleKeywords: string): Promise<LinearIssue | null> {
  const { teamId } = getConfig();
  // Extract key words (3+ chars) for search
  const words = titleKeywords.toLowerCase().split(/[\s\[\]\(\):\-,]+/).filter(w => w.length >= 3);
  const searchTerms = words.slice(0, 5).join(' ');

  try {
    const data = await linearQuery(`
      query SearchIssues($teamId: String!, $search: String!) {
        searchIssues(term: $search, filter: { team: { id: { eq: $teamId } } }, first: 5) {
          nodes {
            id identifier title description priority url createdAt updatedAt
            state { id name type }
            assignee { id name email }
            labels { nodes { id name } }
            comments { nodes { id body createdAt user { name } } }
          }
        }
      }
    `, { teamId, search: searchTerms });

    const matches = data.searchIssues?.nodes || [];
    if (matches.length === 0) return null;

    // Check for close title match (>60% word overlap)
    for (const match of matches) {
      const matchWords = match.title.toLowerCase().split(/[\s\[\]\(\):\-,]+/).filter((w: string) => w.length >= 3);
      const overlap = words.filter(w => matchWords.includes(w)).length;
      const similarity = overlap / Math.max(words.length, 1);
      if (similarity >= 0.5) return match;
    }

    return null;
  } catch (err) {
    console.error('findSimilarIssue error:', err);
    return null;
  }
}

// ============ Team Queries ============

export async function getTeamIssues(stateFilter?: string, limit = 50) {
  const { teamId } = getConfig();
  const stateClause = stateFilter ? `, filter: { state: { name: { eq: "${stateFilter}" } } }` : '';
  const data = await linearQuery(`
    query TeamIssues($teamId: String!, $limit: Int!) {
      team(id: $teamId) {
        issues(first: $limit, orderBy: updatedAt ${stateClause}) {
          nodes {
            id identifier title priority url createdAt updatedAt
            state { id name type }
            assignee { name email }
            labels { nodes { name } }
          }
        }
      }
    }
  `, { teamId, limit });
  return data.team.issues.nodes;
}

// ============ Webhook Helpers ============

export const WORKFLOW_STATES = {
  BACKLOG: 'bea79174-c83e-4ffd-bb8e-20ea97cfeed1',
  TODO: 'df732ad6-44c6-4ccc-8247-a3b32c76a959',
  IN_PROGRESS: '7ec69ab4-f4a4-44a0-b2d0-816d77e16ef6',
  IN_REVIEW: '8aa91362-4b1c-407f-9314-9e7d80b1d651',
  DONE: '1d39a7b1-213c-4323-9eed-788c27bc588a',
  CANCELED: '24c13ec7-f346-4d4f-840d-0ec374132a1f',
} as const;

export const LABELS = {
  BUG: 'dc54ea90-03f6-48e7-baae-15306da57a56',
  FEATURE: 'b63d902a-5ee0-477b-9e24-ffc0e2539010',
  QA_RECHECK: 'c7199040-3fb2-441a-bda1-07012e5d67a4',
  FRONTEND: 'f09ae1f9-f0dc-4229-9958-4929296416ce',
  BACKEND: 'fcefe1f0-859f-4076-b6ab-10ae1b42c1b9',
} as const;
