import crypto from 'crypto';
import axios, { type AxiosRequestConfig } from 'axios';
import type { GitHubAccountType, GitHubEventType, GitHubIdentitySource, Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { config } from '../utils/config';
import {
  assertGitHubAppConfigured,
  buildGitHubInstallUrl,
  signGitHubAppJwt,
  verifyGitHubWebhookSignature,
} from './github-auth.service';

const GITHUB_ACCEPT = 'application/vnd.github+json';
const GITHUB_API_VERSION = '2022-11-28';

type JsonRecord = Record<string, unknown>;

type GitHubInstallationApiRow = {
  id: number | string;
  target_type?: string;
  app_slug?: string;
  repository_selection?: string;
  permissions?: Record<string, string>;
  account?: {
    id?: number | string;
    login?: string;
    type?: string;
  };
};

type GitHubRepositoryRow = {
  id: number | string;
  node_id?: string;
  name: string;
  full_name: string;
  default_branch?: string;
  private?: boolean;
  html_url?: string;
  owner?: {
    login?: string;
    type?: string;
  };
};

type GitHubActorInput = {
  githubUserId?: string | number | null;
  login?: string | null;
  displayName?: string | null;
  email?: string | null;
};

type GitHubActorSuggestion = {
  githubUserId: string | null;
  login: string | null;
  displayName: string | null;
  email: string | null;
  seen: number;
  reason: string;
  confidence: number;
  matchedOn: string[];
  lastSeenAt: Date;
  canAutoMap: boolean;
};

type GitHubActorBucket = {
  githubUserId: string | null;
  login: string | null;
  displayName: string | null;
  email: string | null;
  seen: number;
  lastSeenAt: Date;
  mappedUserIds: Set<string>;
};

type GitHubEventUpsertInput = {
  projectGitHubLinkId: string;
  githubDeliveryId?: string;
  eventType: GitHubEventType;
  action?: string | null;
  externalId: string;
  actor: GitHubActorInput;
  branch?: string | null;
  title?: string | null;
  body?: string | null;
  url?: string | null;
  commitSha?: string | null;
  occurredAt: Date;
  payload?: JsonRecord;
};

function normalizeValue(value?: string | null) {
  return value?.trim().toLowerCase() || '';
}

function normalizeName(value?: string | null) {
  return normalizeValue(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function compactToken(value?: string | null) {
  return normalizeName(value).replace(/\s+/g, '');
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function githubApiHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: GITHUB_ACCEPT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

async function githubRequest<T>(request: AxiosRequestConfig, token: string): Promise<T> {
  const response = await axios.request<T>({
    baseURL: config.github.apiBaseUrl,
    ...request,
    headers: {
      ...githubApiHeaders(token),
      ...(request.headers ?? {}),
    },
  });
  return response.data;
}

async function githubGraphQlRequest<T>(
  query: string,
  variables: Record<string, unknown>,
  token: string,
): Promise<T> {
  const response = await axios.post<{ data?: T; errors?: Array<{ message?: string }> }>(
    `${config.github.apiBaseUrl}/graphql`,
    { query, variables },
    {
      headers: {
        ...githubApiHeaders(token),
        'Content-Type': 'application/json',
      },
    },
  );

  if (response.data.errors?.length) {
    throw new AppError(
      502,
      response.data.errors.map((error) => error.message || 'GraphQL error').join('; '),
      'GITHUB_GRAPHQL_ERROR',
    );
  }

  if (!response.data.data) {
    throw new AppError(502, 'GitHub GraphQL returned no data', 'GITHUB_GRAPHQL_EMPTY');
  }

  return response.data.data;
}

async function getGitHubInstallationAccessToken(internalInstallationId: string) {
  const installation = await prisma.gitHubInstallation.findUnique({
    where: { id: internalInstallationId },
  });
  if (!installation) {
    throw new AppError(404, 'GitHub installation not found', 'GITHUB_INSTALLATION_NOT_FOUND');
  }

  const appJwt = signGitHubAppJwt();
  const payload = await githubRequest<{ token: string }>(
    {
      method: 'POST',
      url: `/app/installations/${installation.githubInstallationId}/access_tokens`,
    },
    appJwt,
  );

  return { installation, token: payload.token };
}

function normalizeAccountType(raw?: string | null): GitHubAccountType {
  return raw === 'User' ? 'USER' : 'ORGANIZATION';
}

async function upsertGitHubInstallation(row: GitHubInstallationApiRow) {
  const githubInstallationId = String(row.id);
  const accountLogin = row.account?.login?.trim();
  if (!accountLogin) {
    throw new AppError(502, 'GitHub installation payload missing account login', 'GITHUB_BAD_INSTALLATION');
  }

  return prisma.gitHubInstallation.upsert({
    where: { githubInstallationId },
    create: {
      githubInstallationId,
      accountId: row.account?.id != null ? String(row.account.id) : null,
      accountLogin,
      accountType: normalizeAccountType(row.account?.type),
      appSlug: row.app_slug ?? null,
      targetType: row.target_type ?? null,
      repositorySelection: row.repository_selection ?? null,
      permissions: row.permissions ?? undefined,
    },
    update: {
      accountId: row.account?.id != null ? String(row.account.id) : null,
      accountLogin,
      accountType: normalizeAccountType(row.account?.type),
      appSlug: row.app_slug ?? null,
      targetType: row.target_type ?? null,
      repositorySelection: row.repository_selection ?? null,
      permissions: row.permissions ?? undefined,
    },
  });
}

async function resolveMappedUserId(projectId: string, actor: GitHubActorInput) {
  if (actor.githubUserId != null) {
    const identity = await prisma.userGitHubIdentity.findUnique({
      where: { githubUserId: String(actor.githubUserId) },
      select: { userId: true },
    });
    if (identity) return identity.userId;
  }

  if (actor.login) {
    const identity = await prisma.userGitHubIdentity.findFirst({
      where: { login: { equals: actor.login, mode: 'insensitive' } },
      select: { userId: true },
    });
    if (identity) return identity.userId;
  }

  if (actor.email) {
    const identity = await prisma.userGitHubIdentity.findFirst({
      where: { primaryEmail: { equals: actor.email, mode: 'insensitive' } },
      select: { userId: true },
    });
    if (identity) return identity.userId;

    const projectMember = await prisma.projectMember.findFirst({
      where: {
        projectId,
        user: { email: { equals: actor.email, mode: 'insensitive' }, deletedAt: null },
      },
      select: { userId: true },
    });
    if (projectMember) return projectMember.userId;
  }

  return null;
}

async function upsertGitHubActivityEvent(input: GitHubEventUpsertInput) {
  const link = await prisma.projectGitHubLink.findUnique({
    where: { id: input.projectGitHubLinkId },
    select: { id: true, projectId: true },
  });
  if (!link) return;

  const mappedUserId = await resolveMappedUserId(link.projectId, input.actor);
  const action = input.action?.trim() || '';
  const actorLogin = input.actor.login?.trim() || null;
  const actorEmail = input.actor.email?.trim() || null;

  await prisma.gitHubActivityEvent.upsert({
    where: {
      projectGitHubLinkId_eventType_externalId_action: {
        projectGitHubLinkId: input.projectGitHubLinkId,
        eventType: input.eventType,
        externalId: input.externalId,
        action,
      },
    },
    create: {
      projectGitHubLinkId: input.projectGitHubLinkId,
      githubDeliveryId: input.githubDeliveryId,
      eventType: input.eventType,
      action,
      externalId: input.externalId,
      actorGithubUserId: input.actor.githubUserId != null ? String(input.actor.githubUserId) : null,
      actorLogin,
      actorDisplayName: input.actor.displayName?.trim() || null,
      actorEmail,
      branch: input.branch?.trim() || null,
      title: input.title?.trim() || null,
      body: input.body?.trim() || null,
      url: input.url?.trim() || null,
      commitSha: input.commitSha?.trim() || null,
      occurredAt: input.occurredAt,
      mappedUserId,
      payload: input.payload as Prisma.InputJsonValue | undefined,
    },
    update: {
      githubDeliveryId: input.githubDeliveryId,
      actorGithubUserId: input.actor.githubUserId != null ? String(input.actor.githubUserId) : null,
      actorLogin,
      actorDisplayName: input.actor.displayName?.trim() || null,
      actorEmail,
      branch: input.branch?.trim() || null,
      title: input.title?.trim() || null,
      body: input.body?.trim() || null,
      url: input.url?.trim() || null,
      commitSha: input.commitSha?.trim() || null,
      occurredAt: input.occurredAt,
      mappedUserId,
      payload: input.payload as Prisma.InputJsonValue | undefined,
    },
  });
}

async function loadRelevantLinksForWebhook(payload: JsonRecord) {
  const installationId =
    typeof payload.installation === 'object' && payload.installation && 'id' in payload.installation
      ? String((payload.installation as JsonRecord).id)
      : null;
  if (!installationId) return [];

  const repository =
    typeof payload.repository === 'object' && payload.repository ? (payload.repository as JsonRecord) : null;
  const repoId = repository?.id != null ? String(repository.id) : null;
  const projectNodeId =
    (typeof payload.projects_v2_item === 'object' && payload.projects_v2_item && 'project_node_id' in payload.projects_v2_item
      ? String((payload.projects_v2_item as JsonRecord).project_node_id)
      : null) ||
    (typeof payload.projects_v2 === 'object' && payload.projects_v2 && 'node_id' in payload.projects_v2
      ? String((payload.projects_v2 as JsonRecord).node_id)
      : null);
  if (!repoId && !projectNodeId) return [];

  const [repoLinks, boardLinks] = await Promise.all([
    repoId ?
      prisma.projectGitHubLink.findMany({
        where: {
          installation: { githubInstallationId: installationId },
          repositoryId: repoId,
        },
        orderBy: [{ createdAt: 'asc' }],
        select: { id: true, projectId: true },
      })
    : Promise.resolve([]),
    projectNodeId ?
      prisma.projectGitHubLink.findMany({
        where: {
          project: {
            githubProjectId: projectNodeId,
            githubBoardInstallation: { githubInstallationId: installationId },
          },
        },
        orderBy: [{ projectId: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, projectId: true },
      })
    : Promise.resolve([]),
  ]);

  const links = new Map<string, { id: string }>();
  const matchedProjects = new Set<string>();

  for (const link of repoLinks) {
    links.set(link.id, { id: link.id });
    matchedProjects.add(link.projectId);
  }

  const boardProjectSeen = new Set<string>();
  for (const link of boardLinks) {
    if (matchedProjects.has(link.projectId) || boardProjectSeen.has(link.projectId)) continue;
    links.set(link.id, { id: link.id });
    boardProjectSeen.add(link.projectId);
  }

  return [...links.values()];
}

function senderActor(payload: JsonRecord): GitHubActorInput {
  const sender =
    typeof payload.sender === 'object' && payload.sender ? (payload.sender as JsonRecord) : null;
  return {
    githubUserId: sender?.id != null ? String(sender.id) : null,
    login: typeof sender?.login === 'string' ? sender.login : null,
    displayName: typeof sender?.login === 'string' ? sender.login : null,
  };
}

function parseDate(raw: unknown, fallback = new Date()) {
  if (typeof raw === 'string' || raw instanceof Date) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return fallback;
}

function buildPushCommitActor(payload: JsonRecord, commit: JsonRecord): GitHubActorInput {
  const sender = senderActor(payload);
  const author = typeof commit.author === 'object' && commit.author ? (commit.author as JsonRecord) : null;
  const committer = typeof commit.committer === 'object' && commit.committer ? (commit.committer as JsonRecord) : null;

  const login =
    typeof author?.username === 'string'
      ? author.username
      : typeof author?.login === 'string'
        ? author.login
        : sender.login;

  return {
    githubUserId:
      author?.id != null
        ? String(author.id)
        : committer?.id != null
          ? String(committer.id)
          : sender.githubUserId,
    login,
    displayName:
      typeof author?.name === 'string'
        ? author.name
        : typeof committer?.name === 'string'
          ? committer.name
          : sender.displayName,
    email:
      typeof author?.email === 'string'
        ? author.email
        : typeof committer?.email === 'string'
          ? committer.email
          : null,
  };
}

async function ingestPushEvent(projectGitHubLinkId: string, deliveryId: string, payload: JsonRecord) {
  const branch =
    typeof payload.ref === 'string' && payload.ref.includes('/')
      ? payload.ref.split('/').pop() || null
      : null;
  const commits = Array.isArray(payload.commits) ? (payload.commits as JsonRecord[]) : [];

  for (const commit of commits) {
    await upsertGitHubActivityEvent({
      projectGitHubLinkId,
      githubDeliveryId: deliveryId,
      eventType: 'COMMIT',
      action: 'pushed',
      externalId: String(commit.id || commit.sha || `${deliveryId}-commit`),
      actor: buildPushCommitActor(payload, commit),
      branch,
      title: typeof commit.message === 'string' ? commit.message.split('\n')[0] : 'Commit pushed',
      body: typeof commit.message === 'string' ? commit.message : null,
      url: typeof commit.url === 'string' ? commit.url : typeof commit.timestamp === 'string' && typeof payload.repository === 'object'
        ? ((payload.repository as JsonRecord).html_url as string | undefined)
        : null,
      commitSha: typeof commit.id === 'string' ? commit.id : typeof commit.sha === 'string' ? commit.sha : null,
      occurredAt: parseDate(commit.timestamp),
      payload: commit,
    });
  }
}

async function ingestPullRequestEvent(projectGitHubLinkId: string, deliveryId: string, payload: JsonRecord) {
  const pullRequest =
    typeof payload.pull_request === 'object' && payload.pull_request ? (payload.pull_request as JsonRecord) : null;
  if (!pullRequest) return;

  await upsertGitHubActivityEvent({
    projectGitHubLinkId,
    githubDeliveryId: deliveryId,
    eventType: 'PULL_REQUEST',
    action: typeof payload.action === 'string' ? payload.action : '',
    externalId: String(pullRequest.id || pullRequest.node_id || deliveryId),
    actor: senderActor(payload),
    branch:
      typeof pullRequest.head === 'object' && pullRequest.head && 'ref' in pullRequest.head
        ? String((pullRequest.head as JsonRecord).ref)
        : null,
    title: typeof pullRequest.title === 'string' ? pullRequest.title : 'Pull request updated',
    body: typeof pullRequest.body === 'string' ? pullRequest.body : null,
    url: typeof pullRequest.html_url === 'string' ? pullRequest.html_url : null,
    commitSha:
      typeof pullRequest.head === 'object' && pullRequest.head && 'sha' in pullRequest.head
        ? String((pullRequest.head as JsonRecord).sha)
        : null,
    occurredAt: parseDate(
      pullRequest.merged_at || pullRequest.closed_at || pullRequest.updated_at || pullRequest.created_at,
    ),
    payload: pullRequest,
  });
}

async function ingestIssueEvent(
  projectGitHubLinkId: string,
  deliveryId: string,
  payload: JsonRecord,
  eventType: GitHubEventType,
) {
  const key = eventType === 'ISSUE_COMMENT' ? 'comment' : 'issue';
  const node = typeof payload[key] === 'object' && payload[key] ? (payload[key] as JsonRecord) : null;
  if (!node) return;

  await upsertGitHubActivityEvent({
    projectGitHubLinkId,
    githubDeliveryId: deliveryId,
    eventType,
    action: typeof payload.action === 'string' ? payload.action : '',
    externalId: String(node.id || node.node_id || deliveryId),
    actor: senderActor(payload),
    title:
      typeof node.title === 'string'
        ? node.title
        : eventType === 'ISSUE_COMMENT'
          ? 'Issue comment updated'
          : 'Issue updated',
    body:
      typeof node.body === 'string'
        ? node.body
        : typeof node.body_text === 'string'
          ? node.body_text
          : null,
    url: typeof node.html_url === 'string' ? node.html_url : null,
    occurredAt: parseDate(node.updated_at || node.created_at),
    payload: node,
  });
}

async function ingestReviewEvent(projectGitHubLinkId: string, deliveryId: string, payload: JsonRecord) {
  const review =
    typeof payload.review === 'object' && payload.review ? (payload.review as JsonRecord) : null;
  if (!review) return;

  await upsertGitHubActivityEvent({
    projectGitHubLinkId,
    githubDeliveryId: deliveryId,
    eventType: 'REVIEW',
    action: typeof payload.action === 'string' ? payload.action : '',
    externalId: String(review.id || review.node_id || deliveryId),
    actor: senderActor(payload),
    title: typeof review.state === 'string' ? `Review ${review.state.toLowerCase()}` : 'Pull request review',
    body: typeof review.body === 'string' ? review.body : null,
    url: typeof review.html_url === 'string' ? review.html_url : null,
    occurredAt: parseDate(review.submitted_at || review.created_at),
    payload: review,
  });
}

async function ingestCheckRunEvent(projectGitHubLinkId: string, deliveryId: string, payload: JsonRecord) {
  const checkRun =
    typeof payload.check_run === 'object' && payload.check_run ? (payload.check_run as JsonRecord) : null;
  if (!checkRun) return;

  const conclusion = typeof checkRun.conclusion === 'string' ? checkRun.conclusion : '';
  await upsertGitHubActivityEvent({
    projectGitHubLinkId,
    githubDeliveryId: deliveryId,
    eventType: 'CHECK_RUN',
    action: conclusion || (typeof payload.action === 'string' ? payload.action : ''),
    externalId: String(checkRun.id || checkRun.node_id || deliveryId),
    actor: senderActor(payload),
    title: typeof checkRun.name === 'string' ? checkRun.name : 'Check run',
    body: conclusion || (typeof checkRun.status === 'string' ? checkRun.status : null),
    url: typeof checkRun.html_url === 'string' ? checkRun.html_url : null,
    commitSha: typeof checkRun.head_sha === 'string' ? checkRun.head_sha : null,
    occurredAt: parseDate(checkRun.completed_at || checkRun.started_at || checkRun.created_at),
    payload: checkRun,
  });
}

async function ingestProjectItemEvent(projectGitHubLinkId: string, deliveryId: string, payload: JsonRecord) {
  const item =
    typeof payload.projects_v2_item === 'object' && payload.projects_v2_item
      ? (payload.projects_v2_item as JsonRecord)
      : null;
  if (!item) return;

  const content =
    typeof item.content === 'object' && item.content ? (item.content as JsonRecord) : null;
  await upsertGitHubActivityEvent({
    projectGitHubLinkId,
    githubDeliveryId: deliveryId,
    eventType: 'PROJECT_ITEM',
    action: typeof payload.action === 'string' ? payload.action : '',
    externalId: String(item.id || item.node_id || deliveryId),
    actor: senderActor(payload),
    title:
      typeof content?.title === 'string'
        ? content.title
        : typeof item.project_title === 'string'
          ? item.project_title
          : 'GitHub Project item changed',
    body:
      typeof item.project_node_id === 'string'
        ? `Project item updated in GitHub Project ${item.project_node_id}`
        : 'GitHub Project item updated',
    url: typeof content?.url === 'string' ? content.url : null,
    occurredAt: parseDate(item.updated_at || payload.updated_at || new Date()),
    payload: item,
  });
}

async function ingestReleaseEvent(projectGitHubLinkId: string, deliveryId: string, payload: JsonRecord) {
  const release =
    typeof payload.release === 'object' && payload.release ? (payload.release as JsonRecord) : null;
  if (!release) return;

  await upsertGitHubActivityEvent({
    projectGitHubLinkId,
    githubDeliveryId: deliveryId,
    eventType: 'RELEASE',
    action: typeof payload.action === 'string' ? payload.action : '',
    externalId: String(release.id || release.node_id || deliveryId),
    actor: senderActor(payload),
    title: typeof release.name === 'string' ? release.name : typeof release.tag_name === 'string' ? release.tag_name : 'Release updated',
    body: typeof release.body === 'string' ? release.body : null,
    url: typeof release.html_url === 'string' ? release.html_url : null,
    occurredAt: parseDate(release.published_at || release.created_at),
    payload: release,
  });
}

async function ingestUnknownEvent(projectGitHubLinkId: string, deliveryId: string, eventName: string, payload: JsonRecord) {
  await upsertGitHubActivityEvent({
    projectGitHubLinkId,
    githubDeliveryId: deliveryId,
    eventType: 'UNKNOWN',
    action: eventName,
    externalId: deliveryId,
    actor: senderActor(payload),
    title: `Unhandled webhook: ${eventName}`,
    body: 'Stored for observability',
    occurredAt: new Date(),
    payload,
  });
}

async function buildProjectSummaryText(
  projectId: string,
  userId: string,
  start: Date,
  end: Date,
  counts: {
    commits: number;
    pullRequestsOpened: number;
    pullRequestsMerged: number;
    reviewsSubmitted: number;
    issuesUpdated: number;
    checksPassed: number;
    checksFailed: number;
    projectItemsMoved: number;
  },
) {
  const highlights = await prisma.gitHubActivityEvent.findMany({
    where: {
      projectLink: { projectId },
      mappedUserId: userId,
      occurredAt: { gte: start, lt: end },
    },
    orderBy: { occurredAt: 'desc' },
    take: 3,
    select: {
      title: true,
      eventType: true,
      projectLink: { select: { repositoryName: true } },
    },
  });

  const parts = [
    counts.commits > 0 ? `${counts.commits} commit${counts.commits === 1 ? '' : 's'}` : null,
    counts.pullRequestsOpened > 0 ? `${counts.pullRequestsOpened} PR opened` : null,
    counts.pullRequestsMerged > 0 ? `${counts.pullRequestsMerged} PR merged` : null,
    counts.reviewsSubmitted > 0 ? `${counts.reviewsSubmitted} review${counts.reviewsSubmitted === 1 ? '' : 's'}` : null,
    counts.issuesUpdated > 0 ? `${counts.issuesUpdated} issue update${counts.issuesUpdated === 1 ? '' : 's'}` : null,
    counts.projectItemsMoved > 0 ? `${counts.projectItemsMoved} project item change${counts.projectItemsMoved === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  const summary = parts.length > 0 ? `Completed ${parts.join(', ')}.` : 'No mapped GitHub activity recorded.';
  const plannedNext = highlights[0]?.title
    ? `Continue with ${highlights[0].title}${highlights[0].projectLink?.repositoryName ? ` in ${highlights[0].projectLink.repositoryName}` : ''}.`
    : null;
  return { summary, plannedNext };
}

async function regenerateDailySummaryForWindow(projectId: string, summaryDate: Date) {
  const start = new Date(summaryDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const events = await prisma.gitHubActivityEvent.findMany({
    where: {
      projectLink: { projectId },
      mappedUserId: { not: null },
      occurredAt: { gte: start, lt: end },
    },
    select: {
      mappedUserId: true,
      eventType: true,
      action: true,
      body: true,
    },
  });

  const grouped = new Map<
    string,
    {
      commits: number;
      pullRequestsOpened: number;
      pullRequestsMerged: number;
      reviewsSubmitted: number;
      issuesUpdated: number;
      checksPassed: number;
      checksFailed: number;
      projectItemsMoved: number;
    }
  >();

  for (const event of events) {
    if (!event.mappedUserId) continue;
    const bucket =
      grouped.get(event.mappedUserId) ??
      {
        commits: 0,
        pullRequestsOpened: 0,
        pullRequestsMerged: 0,
        reviewsSubmitted: 0,
        issuesUpdated: 0,
        checksPassed: 0,
        checksFailed: 0,
        projectItemsMoved: 0,
      };

    switch (event.eventType) {
      case 'COMMIT':
        bucket.commits += 1;
        break;
      case 'PULL_REQUEST':
        if (event.action === 'opened') bucket.pullRequestsOpened += 1;
        if (event.action === 'closed' || event.action === 'merged') bucket.pullRequestsMerged += 1;
        break;
      case 'REVIEW':
        bucket.reviewsSubmitted += 1;
        break;
      case 'ISSUE':
      case 'ISSUE_COMMENT':
        bucket.issuesUpdated += 1;
        break;
      case 'CHECK_RUN':
        if (event.action === 'success' || event.action === 'completed' || event.body === 'success') {
          bucket.checksPassed += 1;
        } else {
          bucket.checksFailed += 1;
        }
        break;
      case 'PROJECT_ITEM':
        bucket.projectItemsMoved += 1;
        break;
      default:
        break;
    }

    grouped.set(event.mappedUserId, bucket);
  }

  await prisma.gitHubDailySummary.deleteMany({
    where: { projectId, date: start },
  });

  for (const [userId, counts] of grouped.entries()) {
    const { summary, plannedNext } = await buildProjectSummaryText(projectId, userId, start, end, counts);
    await prisma.gitHubDailySummary.create({
      data: {
        projectId,
        userId,
        date: start,
        ...counts,
        summary,
        plannedNext,
      },
    });
  }
}

function buildActivityStats(
  events: Array<{
    eventType: GitHubEventType;
  }>,
  repositoryCount: number,
) {
  return events.reduce(
    (acc, event) => {
      acc.total += 1;
      if (event.eventType === 'COMMIT') acc.commits += 1;
      if (event.eventType === 'PULL_REQUEST') acc.pullRequests += 1;
      if (event.eventType === 'ISSUE' || event.eventType === 'ISSUE_COMMENT') acc.issues += 1;
      if (event.eventType === 'CHECK_RUN') acc.checkRuns += 1;
      if (event.eventType === 'PROJECT_ITEM') acc.projectItems += 1;
      return acc;
    },
    {
      total: 0,
      commits: 0,
      pullRequests: 0,
      issues: 0,
      checkRuns: 0,
      projectItems: 0,
      repositories: repositoryCount,
    },
  );
}

function computeAggregateSync(links: Array<{
  status: string;
  lastSyncStatus: string;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
}>) {
  const latestSyncedAt =
    [...links]
      .map((link) => link.lastSyncedAt)
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const latestError =
    links
      .filter((link) => link.lastSyncStatus === 'FAILED' && link.lastSyncError)
      .map((link) => link.lastSyncError)
      .find(Boolean) ?? null;

  const overallStatus =
    links.some((link) => link.lastSyncStatus === 'RUNNING') ? 'RUNNING'
    : links.some((link) => link.lastSyncStatus === 'FAILED') ? 'FAILED'
    : links.some((link) => link.lastSyncStatus === 'SUCCEEDED') ? 'SUCCEEDED'
    : 'IDLE';

  return {
    totalLinks: links.length,
    activeLinks: links.filter((link) => link.status === 'ACTIVE').length,
    failingLinks: links.filter((link) => link.lastSyncStatus === 'FAILED').length,
    lastSyncStatus: overallStatus,
    lastSyncedAt: latestSyncedAt,
    lastSyncError: latestError,
  };
}

function buildActorKey(event: {
  actorGithubUserId: string | null;
  actorLogin: string | null;
  actorEmail: string | null;
}) {
  return event.actorGithubUserId || event.actorLogin || event.actorEmail;
}

function collectActorBuckets(
  events: Array<{
    actorGithubUserId: string | null;
    actorLogin: string | null;
    actorDisplayName: string | null;
    actorEmail: string | null;
    mappedUserId: string | null;
    occurredAt: Date;
  }>,
) {
  const actors = new Map<string, GitHubActorBucket>();

  for (const event of events) {
    const actorKey = buildActorKey(event);
    if (!actorKey) continue;

    const bucket =
      actors.get(actorKey) ?? {
        githubUserId: event.actorGithubUserId,
        login: event.actorLogin,
        displayName: event.actorDisplayName,
        email: event.actorEmail,
        seen: 0,
        lastSeenAt: event.occurredAt,
        mappedUserIds: new Set<string>(),
      };

    bucket.seen += 1;
    if (event.occurredAt > bucket.lastSeenAt) {
      bucket.lastSeenAt = event.occurredAt;
    }
    if (!bucket.githubUserId && event.actorGithubUserId) bucket.githubUserId = event.actorGithubUserId;
    if (!bucket.login && event.actorLogin) bucket.login = event.actorLogin;
    if (!bucket.displayName && event.actorDisplayName) bucket.displayName = event.actorDisplayName;
    if (!bucket.email && event.actorEmail) bucket.email = event.actorEmail;
    if (event.mappedUserId) bucket.mappedUserIds.add(event.mappedUserId);
    actors.set(actorKey, bucket);
  }

  return actors;
}

function buildGitHubSuggestionsForUser(
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    githubIdentity?: {
      githubUserId: string;
      login: string;
      primaryEmail?: string | null;
    } | null;
  },
  actorBuckets: Iterable<GitHubActorBucket>,
): GitHubActorSuggestion[] {
  const userEmail = normalizeValue(user.email);
  const emailLocal = userEmail.split('@')[0] || '';
  const firstName = normalizeValue(user.firstName);
  const lastName = normalizeValue(user.lastName);
  const fullName = normalizeName(`${user.firstName} ${user.lastName}`);
  const compactFullName = compactToken(fullName);
  const dotFullName = [firstName, lastName].filter(Boolean).join('.');

  const suggestions: Array<GitHubActorSuggestion & { score: number }> = [];

  for (const actor of actorBuckets) {
    if (!actor.githubUserId && !actor.login && !actor.email) continue;
    if (actor.mappedUserIds.size > 0 && !actor.mappedUserIds.has(user.id)) continue;

    const matchedOn: string[] = [];
    let score = 0;

    const actorEmail = normalizeValue(actor.email);
    const actorEmailLocal = actorEmail.split('@')[0] || '';
    const actorLogin = normalizeValue(actor.login);
    const actorDisplayName = normalizeName(actor.displayName);
    const actorCompactDisplayName = compactToken(actor.displayName);

    if (actorEmail && actorEmail === userEmail) {
      score += 110;
      matchedOn.push('email');
    }
    if (actorEmailLocal && actorEmailLocal === emailLocal) {
      score += 45;
      matchedOn.push('email-local');
    }
    if (actorLogin && actorLogin === emailLocal) {
      score += 90;
      matchedOn.push('login');
    }
    if (actorLogin && actorLogin === firstName) {
      score += 28;
      matchedOn.push('first-name');
    }
    if (actorLogin && actorLogin === lastName) {
      score += 28;
      matchedOn.push('last-name');
    }
    if (actorLogin && (actorLogin === compactFullName || actorLogin === dotFullName || actorLogin === fullName.replace(/\s+/g, '-'))) {
      score += 70;
      matchedOn.push('full-name');
    }
    if (actorDisplayName && actorDisplayName === fullName) {
      score += 80;
      matchedOn.push('display-name');
    }
    if (actorCompactDisplayName && actorCompactDisplayName === compactFullName) {
      score += 55;
      matchedOn.push('display-name');
    }
    if (user.githubIdentity?.githubUserId && actor.githubUserId === user.githubIdentity.githubUserId) {
      score += 150;
      matchedOn.push('github-user-id');
    }
    if (user.githubIdentity?.login && actorLogin === normalizeValue(user.githubIdentity.login)) {
      score += 120;
      matchedOn.push('existing-login');
    }
    if (user.githubIdentity?.primaryEmail && actorEmail === normalizeValue(user.githubIdentity.primaryEmail)) {
      score += 120;
      matchedOn.push('existing-primary-email');
    }

    if (score < 45) continue;

    const reason =
      matchedOn.includes('email')
        ? 'Exact email match from recent GitHub activity'
        : matchedOn.includes('login')
          ? 'GitHub login matches the PMS email handle'
          : matchedOn.includes('display-name') || matchedOn.includes('full-name')
            ? 'GitHub actor name closely matches this PMS user'
            : 'Recent contributor activity suggests this mapping';

    const confidence = Math.max(0.15, Math.min(0.99, score / 160 + Math.min(0.24, actor.seen * 0.03)));

    suggestions.push({
      githubUserId: actor.githubUserId,
      login: actor.login,
      displayName: actor.displayName,
      email: actor.email,
      seen: actor.seen,
      reason,
      confidence,
      matchedOn: uniqueStrings(matchedOn),
      lastSeenAt: actor.lastSeenAt,
      canAutoMap: Boolean(actor.githubUserId && actor.login),
      score,
    });
  }

  return suggestions
    .sort((a, b) => b.score - a.score || b.seen - a.seen || b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
    .slice(0, 5)
    .map(({ score: _score, ...suggestion }) => suggestion);
}

function buildGitHubIdentityMatchWhere(args: {
  projectId?: string;
  githubUserId?: string | null;
  login?: string | null;
  primaryEmail?: string | null;
  userEmail?: string | null;
  since?: Date;
}): Prisma.GitHubActivityEventWhereInput {
  const or: Prisma.GitHubActivityEventWhereInput[] = [];

  if (args.githubUserId) {
    or.push({ actorGithubUserId: args.githubUserId });
  }
  if (args.login) {
    or.push({ actorLogin: { equals: args.login, mode: 'insensitive' } });
  }
  if (args.primaryEmail) {
    or.push({ actorEmail: { equals: args.primaryEmail, mode: 'insensitive' } });
  }
  if (args.userEmail) {
    or.push({ actorEmail: { equals: args.userEmail, mode: 'insensitive' } });
  }

  return {
    ...(args.projectId ? { projectLink: { projectId: args.projectId } } : {}),
    ...(args.since ? { occurredAt: { gte: args.since } } : {}),
    OR: or,
  };
}

export async function listGitHubInstallations() {
  assertGitHubAppConfigured();
  const appJwt = signGitHubAppJwt();
  const data = await githubRequest<GitHubInstallationApiRow[]>(
    {
      method: 'GET',
      url: '/app/installations',
    },
    appJwt,
  );

  const rows = await Promise.all(data.map((row) => upsertGitHubInstallation(row)));
  return rows.map((row) => ({
    id: row.id,
    githubInstallationId: row.githubInstallationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    appSlug: row.appSlug,
    repositorySelection: row.repositorySelection,
  }));
}

export async function listGitHubInstallationRepositories(internalInstallationId: string) {
  const { installation, token } = await getGitHubInstallationAccessToken(internalInstallationId);
  const repositories: GitHubRepositoryRow[] = [];
  let page = 1;
  let totalCount = Number.POSITIVE_INFINITY;

  while (repositories.length < totalCount) {
    const data = await githubRequest<{ total_count?: number; repositories: GitHubRepositoryRow[] }>(
      {
        method: 'GET',
        url: '/installation/repositories',
        params: { per_page: 100, page },
      },
      token,
    );

    const batch = data.repositories ?? [];
    totalCount = typeof data.total_count === 'number' ? data.total_count : batch.length;
    repositories.push(...batch);

    if (batch.length < 100) break;
    page += 1;
  }

  repositories.sort((a, b) => a.full_name.localeCompare(b.full_name));

  return {
    installation: {
      id: installation.id,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
    },
    repositories: repositories.map((repo) => ({
      id: String(repo.id),
      nodeId: repo.node_id ?? null,
      name: repo.name,
      fullName: repo.full_name,
      defaultBranch: repo.default_branch ?? null,
      private: Boolean(repo.private),
      htmlUrl: repo.html_url ?? null,
      ownerLogin: repo.owner?.login ?? installation.accountLogin,
      ownerType: normalizeAccountType(repo.owner?.type),
    })),
  };
}

export async function listGitHubInstallationProjects(internalInstallationId: string, ownerLogin: string) {
  const { token } = await getGitHubInstallationAccessToken(internalInstallationId);
  const data = await githubGraphQlRequest<{
    organization?: { projectsV2?: { nodes?: Array<{ id: string; number: number; title: string; url?: string }> } | null } | null;
    user?: { projectsV2?: { nodes?: Array<{ id: string; number: number; title: string; url?: string }> } | null } | null;
  }>(
    `
      query GitHubProjects($owner: String!) {
        organization(login: $owner) {
          projectsV2(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
            nodes {
              id
              number
              title
              url
            }
          }
        }
        user(login: $owner) {
          projectsV2(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
            nodes {
              id
              number
              title
              url
            }
          }
        }
      }
    `,
    { owner: ownerLogin },
    token,
  );

  const nodes = data.organization?.projectsV2?.nodes ?? data.user?.projectsV2?.nodes ?? [];
  return nodes.map((node) => ({
    id: node.id,
    number: node.number,
    title: node.title,
    url: node.url ?? null,
  }));
}

export async function saveProjectGitHubLink(input: {
  projectId: string;
  installationId: string;
  ownerLogin: string;
  ownerType?: GitHubAccountType;
  repositoryId: string;
  repositoryNodeId?: string | null;
  repositoryName: string;
  repositoryFullName: string;
  defaultBranch?: string | null;
  createdBy?: string;
}) {
  return prisma.projectGitHubLink.upsert({
    where: {
      projectId_repositoryId: {
        projectId: input.projectId,
        repositoryId: input.repositoryId,
      },
    },
    create: {
      projectId: input.projectId,
      installationId: input.installationId,
      ownerLogin: input.ownerLogin,
      ownerType: input.ownerType ?? 'ORGANIZATION',
      repositoryId: input.repositoryId,
      repositoryNodeId: input.repositoryNodeId ?? null,
      repositoryName: input.repositoryName,
      repositoryFullName: input.repositoryFullName,
      defaultBranch: input.defaultBranch ?? null,
      status: 'ACTIVE',
      syncEnabled: true,
      createdBy: input.createdBy,
    },
    update: {
      installationId: input.installationId,
      ownerLogin: input.ownerLogin,
      ownerType: input.ownerType ?? 'ORGANIZATION',
      repositoryId: input.repositoryId,
      repositoryNodeId: input.repositoryNodeId ?? null,
      repositoryName: input.repositoryName,
      repositoryFullName: input.repositoryFullName,
      defaultBranch: input.defaultBranch ?? null,
      status: 'ACTIVE',
      lastSyncError: null,
    },
    include: {
      installation: true,
    },
  });
}

export async function updateProjectGitHubBoard(input: {
  projectId: string;
  installationId?: string | null;
  ownerLogin?: string | null;
  ownerType?: GitHubAccountType | null;
  githubProjectId?: string | null;
  githubProjectNumber?: number | null;
  githubProjectTitle?: string | null;
}) {
  const shouldClear = !input.githubProjectId;
  return prisma.project.update({
    where: { id: input.projectId },
    data: shouldClear ? {
      githubBoardInstallationId: null,
      githubBoardOwnerLogin: null,
      githubBoardOwnerType: null,
      githubProjectId: null,
      githubProjectNumber: null,
      githubProjectTitle: null,
    } : {
      githubBoardInstallationId: input.installationId ?? null,
      githubBoardOwnerLogin: input.ownerLogin ?? null,
      githubBoardOwnerType: input.ownerType ?? 'ORGANIZATION',
      githubProjectId: input.githubProjectId ?? null,
      githubProjectNumber: input.githubProjectNumber ?? null,
      githubProjectTitle: input.githubProjectTitle ?? null,
    },
    select: {
      id: true,
      githubBoardInstallationId: true,
      githubBoardOwnerLogin: true,
      githubBoardOwnerType: true,
      githubProjectId: true,
      githubProjectNumber: true,
      githubProjectTitle: true,
      githubBoardInstallation: {
        select: { id: true, accountLogin: true, accountType: true, githubInstallationId: true },
      },
    },
  });
}

export async function deleteProjectGitHubLink(projectId: string, linkId: string) {
  const result = await prisma.projectGitHubLink.deleteMany({
    where: { id: linkId, projectId },
  });
  if (result.count === 0) {
    throw new AppError(404, 'GitHub link not found for this project', 'GITHUB_LINK_NOT_FOUND');
  }

  const remainingLinks = await prisma.projectGitHubLink.count({
    where: { projectId },
  });
  if (remainingLinks === 0) {
    await updateProjectGitHubBoard({ projectId, githubProjectId: null });
  }
}

export async function getProjectGitHubOverview(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      githubBoardInstallationId: true,
      githubBoardOwnerLogin: true,
      githubBoardOwnerType: true,
      githubProjectId: true,
      githubProjectNumber: true,
      githubProjectTitle: true,
      githubBoardInstallation: {
        select: { id: true, accountLogin: true, accountType: true, githubInstallationId: true },
      },
      githubLinks: {
        orderBy: [{ createdAt: 'asc' }],
        include: {
          installation: {
            select: { id: true, accountLogin: true, accountType: true, githubInstallationId: true },
          },
        },
      },
      githubDailySummaries: {
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        take: 12,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      },
    },
  });

  if (!project) return null;
  if (project.githubLinks.length === 0 && !project.githubProjectId) return null;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentEvents = await prisma.gitHubActivityEvent.findMany({
    where: {
      projectLink: { projectId },
      occurredAt: { gte: since },
    },
    orderBy: { occurredAt: 'desc' },
    take: 80,
    include: {
      mappedUser: { select: { id: true, firstName: true, lastName: true } },
      projectLink: {
        select: {
          id: true,
          repositoryName: true,
          repositoryFullName: true,
        },
      },
    },
  });

  const stats = buildActivityStats(recentEvents, project.githubLinks.length);
  const sync = computeAggregateSync(project.githubLinks);

  return {
    installUrl: buildGitHubInstallUrl(projectId),
    board:
      project.githubProjectId ?
        {
          installationId: project.githubBoardInstallationId,
          ownerLogin: project.githubBoardOwnerLogin,
          ownerType: project.githubBoardOwnerType,
          githubProjectId: project.githubProjectId,
          githubProjectNumber: project.githubProjectNumber,
          githubProjectTitle: project.githubProjectTitle,
          installation: project.githubBoardInstallation,
        }
      : null,
    links: project.githubLinks,
    summaries: project.githubDailySummaries,
    stats,
    sync,
  };
}

export async function getProjectGitHubActivity(projectId: string, limit = 40) {
  return prisma.gitHubActivityEvent.findMany({
    where: { projectLink: { projectId } },
    orderBy: { occurredAt: 'desc' },
    take: limit,
    include: {
      mappedUser: { select: { id: true, firstName: true, lastName: true, email: true } },
      projectLink: {
        select: {
          id: true,
          repositoryId: true,
          repositoryName: true,
          repositoryFullName: true,
          installationId: true,
        },
      },
    },
  });
}

export async function getProjectGitHubMembers(projectId: string) {
  const linkCount = await prisma.projectGitHubLink.count({
    where: { projectId },
  });

  const members = await prisma.projectMember.findMany({
    where: { projectId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          githubIdentity: true,
        },
      },
    },
    orderBy: { joinedAt: 'asc' },
  });

  if (linkCount === 0) {
    return members.map((member) => ({
      ...member,
      recentGitHubActivity: null,
      suggestions: [],
    }));
  }

  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const recentEvents = await prisma.gitHubActivityEvent.findMany({
    where: {
      projectLink: { projectId },
      occurredAt: { gte: since },
    },
    select: {
      actorGithubUserId: true,
      actorLogin: true,
      actorDisplayName: true,
      actorEmail: true,
      mappedUserId: true,
      occurredAt: true,
    },
    orderBy: { occurredAt: 'desc' },
  });

  const recentByUser = new Map<string, number>();
  const actorEvents: Array<{
    actorGithubUserId: string | null;
    actorLogin: string | null;
    actorDisplayName: string | null;
    actorEmail: string | null;
    mappedUserId: string | null;
    occurredAt: Date;
  }> = [];

  for (const event of recentEvents) {
    if (event.mappedUserId) {
      recentByUser.set(event.mappedUserId, (recentByUser.get(event.mappedUserId) ?? 0) + 1);
    }
    actorEvents.push(event);
  }

  const actorBuckets = collectActorBuckets(actorEvents);

  return members.map((member) => {
    const suggestions = buildGitHubSuggestionsForUser(member.user, actorBuckets.values());

    return {
      ...member,
      recentGitHubActivity: recentByUser.get(member.userId) ?? 0,
      suggestions,
    };
  });
}

export async function listUserGitHubSuggestions(userId: string, options?: { projectId?: string; days?: number }) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      githubIdentity: {
        select: {
          githubUserId: true,
          login: true,
          primaryEmail: true,
        },
      },
    },
  });
  if (!user) {
    throw new AppError(404, 'User not found', 'NOT_FOUND');
  }

  const days = Math.min(Math.max(options?.days ?? 45, 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const recentEvents = await prisma.gitHubActivityEvent.findMany({
    where: {
      occurredAt: { gte: since },
      ...(options?.projectId ? { projectLink: { projectId: options.projectId } } : {}),
    },
    select: {
      actorGithubUserId: true,
      actorLogin: true,
      actorDisplayName: true,
      actorEmail: true,
      mappedUserId: true,
      occurredAt: true,
    },
    orderBy: { occurredAt: 'desc' },
  });

  return buildGitHubSuggestionsForUser(user, collectActorBuckets(recentEvents).values());
}

export async function upsertUserGitHubIdentity(input: {
  userId: string;
  githubUserId: string;
  login: string;
  displayName?: string | null;
  primaryEmail?: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  source?: GitHubIdentitySource;
}) {
  return prisma.userGitHubIdentity.upsert({
    where: { userId: input.userId },
    create: {
      userId: input.userId,
      githubUserId: input.githubUserId,
      login: input.login,
      displayName: input.displayName ?? null,
      primaryEmail: input.primaryEmail ?? null,
      avatarUrl: input.avatarUrl ?? null,
      profileUrl: input.profileUrl ?? null,
      source: input.source ?? 'MANUAL',
    },
    update: {
      githubUserId: input.githubUserId,
      login: input.login,
      displayName: input.displayName ?? null,
      primaryEmail: input.primaryEmail ?? null,
      avatarUrl: input.avatarUrl ?? null,
      profileUrl: input.profileUrl ?? null,
      source: input.source ?? 'MANUAL',
    },
  });
}

export async function deleteUserGitHubIdentity(userId: string) {
  await prisma.userGitHubIdentity.deleteMany({ where: { userId } });
}

export async function remapProjectGitHubIdentity(projectId: string, userId: string, lookbackDays = 90) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      email: true,
      githubIdentity: {
        select: {
          githubUserId: true,
          login: true,
          primaryEmail: true,
        },
      },
    },
  });
  if (!user) {
    throw new AppError(404, 'User not found', 'NOT_FOUND');
  }

  const since = new Date(Date.now() - Math.min(Math.max(lookbackDays, 1), 365) * 24 * 60 * 60 * 1000);
  const matchWhere = buildGitHubIdentityMatchWhere({
    projectId,
    since,
    githubUserId: user.githubIdentity?.githubUserId,
    login: user.githubIdentity?.login,
    primaryEmail: user.githubIdentity?.primaryEmail,
    userEmail: user.email,
  });

  if (!matchWhere.OR || matchWhere.OR.length === 0) {
    return { updatedEvents: 0, regeneratedDays: 0 };
  }

  const matchingEvents = await prisma.gitHubActivityEvent.findMany({
    where: matchWhere,
    select: {
      id: true,
      occurredAt: true,
    },
  });

  if (matchingEvents.length === 0) {
    return { updatedEvents: 0, regeneratedDays: 0 };
  }

  await prisma.gitHubActivityEvent.updateMany({
    where: {
      id: { in: matchingEvents.map((event) => event.id) },
    },
    data: {
      mappedUserId: user.id,
    },
  });

  const affectedDays = [
    ...new Set(
      matchingEvents.map((event) => {
        const day = new Date(event.occurredAt);
        day.setHours(0, 0, 0, 0);
        return day.toISOString();
      }),
    ),
  ].map((iso) => new Date(iso));

  for (const day of affectedDays) {
    await regenerateDailySummaryForWindow(projectId, day);
  }

  return { updatedEvents: matchingEvents.length, regeneratedDays: affectedDays.length };
}

export async function syncProjectGitHubLink(projectGitHubLinkId: string, forceFull = false, lookbackDays?: number) {
  const link = await prisma.projectGitHubLink.findUnique({
    where: { id: projectGitHubLinkId },
    include: { installation: true },
  });
  if (!link) {
    throw new AppError(404, 'Project GitHub link not found', 'GITHUB_LINK_NOT_FOUND');
  }

  await prisma.projectGitHubLink.update({
    where: { id: link.id },
    data: { lastSyncStatus: 'RUNNING', lastSyncError: null },
  });

  try {
    const { token } = await getGitHubInstallationAccessToken(link.installationId);
    const effectiveLookbackDays =
      lookbackDays != null
        ? Math.min(Math.max(lookbackDays, 1), 365)
        : forceFull
          ? 90
          : null;
    const since =
      effectiveLookbackDays != null
        ? new Date(Date.now() - effectiveLookbackDays * 24 * 60 * 60 * 1000)
        : !link.lastSyncCursor
          ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          : link.lastSyncCursor;
    const sinceIso = since.toISOString();

    const [commits, pullRequests, issues] = await Promise.all([
      githubRequest<JsonRecord[]>(
        {
          method: 'GET',
          url: `/repos/${link.repositoryFullName}/commits`,
          params: { since: sinceIso, per_page: 40 },
        },
        token,
      ),
      githubRequest<JsonRecord[]>(
        {
          method: 'GET',
          url: `/repos/${link.repositoryFullName}/pulls`,
          params: { state: 'all', sort: 'updated', direction: 'desc', per_page: 30 },
        },
        token,
      ),
      githubRequest<JsonRecord[]>(
        {
          method: 'GET',
          url: `/repos/${link.repositoryFullName}/issues`,
          params: { state: 'all', sort: 'updated', direction: 'desc', per_page: 30, since: sinceIso },
        },
        token,
      ),
    ]);

    for (const commit of commits) {
      const author = typeof commit.author === 'object' && commit.author ? (commit.author as JsonRecord) : null;
      const commitAuthor =
        typeof commit.commit === 'object' && commit.commit ? ((commit.commit as JsonRecord).author as JsonRecord | undefined) : null;
      const message =
        typeof commit.commit === 'object' && commit.commit
          ? String(((commit.commit as JsonRecord).message as string | undefined) || '')
          : '';

      await upsertGitHubActivityEvent({
        projectGitHubLinkId: link.id,
        githubDeliveryId: 'sync',
        eventType: 'COMMIT',
        action: 'synced',
        externalId: String(commit.sha || commit.node_id || `${link.id}-${Date.now()}`),
        actor: {
          githubUserId: author?.id != null ? String(author.id) : null,
          login: typeof author?.login === 'string' ? author.login : null,
          displayName: typeof commitAuthor?.name === 'string' ? commitAuthor.name : null,
          email: typeof commitAuthor?.email === 'string' ? commitAuthor.email : null,
        },
        branch: link.defaultBranch ?? null,
        title: message.split('\n')[0] || 'Commit synced',
        body: message || null,
        url: typeof commit.html_url === 'string' ? commit.html_url : null,
        commitSha: typeof commit.sha === 'string' ? commit.sha : null,
        occurredAt: parseDate(
          commitAuthor?.date || (typeof commit.commit === 'object' ? (commit.commit as JsonRecord).author : null),
        ),
        payload: commit,
      });
    }

    for (const pullRequest of pullRequests) {
      await upsertGitHubActivityEvent({
        projectGitHubLinkId: link.id,
        githubDeliveryId: 'sync',
        eventType: 'PULL_REQUEST',
        action:
          typeof pullRequest.state === 'string' && pullRequest.merged_at
            ? 'merged'
            : typeof pullRequest.state === 'string'
              ? pullRequest.state
              : 'synced',
        externalId: String(pullRequest.id || pullRequest.node_id || `${link.id}-pr`),
        actor: {
          githubUserId:
            typeof pullRequest.user === 'object' && pullRequest.user && 'id' in pullRequest.user
              ? String((pullRequest.user as JsonRecord).id)
              : null,
          login:
            typeof pullRequest.user === 'object' && pullRequest.user && 'login' in pullRequest.user
              ? String((pullRequest.user as JsonRecord).login)
              : null,
          displayName:
            typeof pullRequest.user === 'object' && pullRequest.user && 'login' in pullRequest.user
              ? String((pullRequest.user as JsonRecord).login)
              : null,
        },
        branch:
          typeof pullRequest.head === 'object' && pullRequest.head && 'ref' in pullRequest.head
            ? String((pullRequest.head as JsonRecord).ref)
            : null,
        title: typeof pullRequest.title === 'string' ? pullRequest.title : 'Pull request synced',
        body: typeof pullRequest.body === 'string' ? pullRequest.body : null,
        url: typeof pullRequest.html_url === 'string' ? pullRequest.html_url : null,
        commitSha:
          typeof pullRequest.head === 'object' && pullRequest.head && 'sha' in pullRequest.head
            ? String((pullRequest.head as JsonRecord).sha)
            : null,
        occurredAt: parseDate(
          pullRequest.merged_at || pullRequest.updated_at || pullRequest.closed_at || pullRequest.created_at,
        ),
        payload: pullRequest,
      });
    }

    for (const issue of issues.filter((row) => !('pull_request' in row))) {
      await upsertGitHubActivityEvent({
        projectGitHubLinkId: link.id,
        githubDeliveryId: 'sync',
        eventType: 'ISSUE',
        action: 'synced',
        externalId: String(issue.id || issue.node_id || `${link.id}-issue`),
        actor: {
          githubUserId:
            typeof issue.user === 'object' && issue.user && 'id' in issue.user
              ? String((issue.user as JsonRecord).id)
              : null,
          login:
            typeof issue.user === 'object' && issue.user && 'login' in issue.user
              ? String((issue.user as JsonRecord).login)
              : null,
          displayName:
            typeof issue.user === 'object' && issue.user && 'login' in issue.user
              ? String((issue.user as JsonRecord).login)
              : null,
        },
        title: typeof issue.title === 'string' ? issue.title : 'Issue synced',
        body: typeof issue.body === 'string' ? issue.body : null,
        url: typeof issue.html_url === 'string' ? issue.html_url : null,
        occurredAt: parseDate(issue.updated_at || issue.created_at),
        payload: issue,
      });
    }

    const now = new Date();
    await prisma.projectGitHubLink.update({
      where: { id: link.id },
      data: {
        lastSyncCursor: now,
        lastSyncedAt: now,
        lastSyncStatus: 'SUCCEEDED',
        lastSyncError: null,
        status: 'ACTIVE',
      },
    });

    await regenerateDailySummaryForWindow(link.projectId, now);

    return { ok: true as const };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await prisma.projectGitHubLink.update({
      where: { id: link.id },
      data: {
        lastSyncStatus: 'FAILED',
        lastSyncError: detail,
      },
    });
    logger.error({ err: error, projectGitHubLinkId }, 'GitHub project sync failed');
    throw error;
  }
}

export async function processGitHubWebhook(rawBody: Buffer, headers: Record<string, unknown>) {
  assertGitHubAppConfigured();
  const signature = headers['x-hub-signature-256'];
  if (!verifyGitHubWebhookSignature(rawBody, signature as string | string[] | undefined)) {
    throw new AppError(401, 'Invalid GitHub webhook signature', 'GITHUB_BAD_SIGNATURE');
  }

  let payload: JsonRecord;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as JsonRecord;
  } catch {
    throw new AppError(400, 'Invalid webhook payload', 'GITHUB_BAD_PAYLOAD');
  }

  const eventName = String(headers['x-github-event'] || '');
  const deliveryId = String(headers['x-github-delivery'] || crypto.randomUUID?.() || Date.now());
  if (eventName === 'ping') {
    return { ok: true, event: 'ping', deliveryId };
  }

  const links = await loadRelevantLinksForWebhook(payload);
  if (links.length === 0) {
    return { ok: true, event: eventName, deliveryId, processedLinks: 0 };
  }

  const installationId =
    typeof payload.installation === 'object' && payload.installation && 'id' in payload.installation
      ? String((payload.installation as JsonRecord).id)
      : null;
  if (installationId) {
    await prisma.gitHubInstallation.updateMany({
      where: { githubInstallationId: installationId },
      data: { lastWebhookAt: new Date() },
    });
  }

  for (const link of links) {
    switch (eventName) {
      case 'push':
        await ingestPushEvent(link.id, deliveryId, payload);
        break;
      case 'pull_request':
        await ingestPullRequestEvent(link.id, deliveryId, payload);
        break;
      case 'issues':
        await ingestIssueEvent(link.id, deliveryId, payload, 'ISSUE');
        break;
      case 'issue_comment':
        await ingestIssueEvent(link.id, deliveryId, payload, 'ISSUE_COMMENT');
        break;
      case 'pull_request_review':
        await ingestReviewEvent(link.id, deliveryId, payload);
        break;
      case 'check_run':
        await ingestCheckRunEvent(link.id, deliveryId, payload);
        break;
      case 'projects_v2_item':
        await ingestProjectItemEvent(link.id, deliveryId, payload);
        break;
      case 'release':
        await ingestReleaseEvent(link.id, deliveryId, payload);
        break;
      default:
        await ingestUnknownEvent(link.id, deliveryId, eventName, payload);
        break;
    }

    await prisma.projectGitHubLink.update({
      where: { id: link.id },
      data: { lastWebhookDeliveredAt: new Date(), status: 'ACTIVE' },
    });
  }

  return { ok: true, event: eventName, deliveryId, processedLinks: links.length };
}

export async function generateGitHubDailySummaries(summaryDate = new Date()) {
  const projects = await prisma.projectGitHubLink.findMany({
    where: { status: 'ACTIVE', syncEnabled: true },
    distinct: ['projectId'],
    select: { projectId: true },
  });

  for (const project of projects) {
    await regenerateDailySummaryForWindow(project.projectId, summaryDate);
  }
}

export async function getGitHubAnalyticsOverview(projectId?: string, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const summaries = await prisma.gitHubDailySummary.findMany({
    where: {
      date: { gte: since },
      ...(projectId ? { projectId } : {}),
    },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
      project: { select: { id: true, name: true, key: true } },
    },
    orderBy: [{ date: 'desc' }, { commits: 'desc' }],
  });

  const contributors = new Map<
    string,
    {
      user: { id: string; firstName: string; lastName: string; email: string };
      commits: number;
      pullRequestsOpened: number;
      pullRequestsMerged: number;
      reviewsSubmitted: number;
      issuesUpdated: number;
      checksPassed: number;
      checksFailed: number;
      projectItemsMoved: number;
    }
  >();

  for (const row of summaries) {
    const bucket =
      contributors.get(row.userId) ?? {
        user: row.user,
        commits: 0,
        pullRequestsOpened: 0,
        pullRequestsMerged: 0,
        reviewsSubmitted: 0,
        issuesUpdated: 0,
        checksPassed: 0,
        checksFailed: 0,
        projectItemsMoved: 0,
      };

    bucket.commits += row.commits;
    bucket.pullRequestsOpened += row.pullRequestsOpened;
    bucket.pullRequestsMerged += row.pullRequestsMerged;
    bucket.reviewsSubmitted += row.reviewsSubmitted;
    bucket.issuesUpdated += row.issuesUpdated;
    bucket.checksPassed += row.checksPassed;
    bucket.checksFailed += row.checksFailed;
    bucket.projectItemsMoved += row.projectItemsMoved;
    contributors.set(row.userId, bucket);
  }

  return {
    summaries,
    contributors: [...contributors.values()].sort(
      (a, b) =>
        b.commits +
        b.pullRequestsMerged * 2 -
        b.checksFailed -
        (a.commits + a.pullRequestsMerged * 2 - a.checksFailed),
    ),
  };
}
