import type { GitHubJobData } from '../job-types';
import { remapProjectGitHubIdentity, syncProjectGitHubLink } from '../../services/github.service';
import { logger } from '../../utils/logger';

export async function runGitHubJob(data: GitHubJobData, meta?: { jobId?: string }) {
  if (data.type === 'sync-project-link') {
    logger.info(
      { jobId: meta?.jobId ?? 'inline', projectGitHubLinkId: data.projectGitHubLinkId },
      'github: syncing project link',
    );
    await syncProjectGitHubLink(data.projectGitHubLinkId, Boolean(data.forceFull), data.lookbackDays);
    return { ok: true as const };
  }

  if (data.type === 'remap-project-identity') {
    logger.info(
      { jobId: meta?.jobId ?? 'inline', projectId: data.projectId, userId: data.userId },
      'github: remapping project identity',
    );
    return remapProjectGitHubIdentity(data.projectId, data.userId, data.lookbackDays ?? 90);
  }

  return { skipped: true as const, reason: 'unknown_job_type' as const };
}

export function runGitHubJobInBackground(data: GitHubJobData): void {
  void runGitHubJob(data, { jobId: 'inline' }).catch((err) => {
    logger.error({ err, type: data.type }, 'github: inline job failed');
  });
}
