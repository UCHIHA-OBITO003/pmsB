import { prisma } from '../utils/prisma';
import { redmineScraper } from './redmine-scraper.service';
import { resolveOrCreateDeveloperFromAssignee } from '../utils/assignee-import-user';
import { STATUS_MAP, PRIORITY_MAP } from '../utils/mappings';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { parseLegacyTicketSource } from '../utils/legacy-source-url';

export class MassScraperService {
  private activeJobs: Map<string, boolean> = new Map();

  async startSyncJob(jobId: string) {
    if (this.activeJobs.get(jobId)) return;
    this.activeJobs.set(jobId, true);

    const job = await prisma.externalSyncJob.findUnique({
      where: { id: jobId },
      include: { project: true }
    });

    if (!job) return;

    try {
      await prisma.externalSyncJob.update({
        where: { id: jobId },
        data: { status: 'PROCESSING', startedAt: new Date() }
      });

      const concurrency = 5; // Parallel workers
      const ids = Array.from({ length: job.endId - job.startId + 1 }, (_, i) => job.startId + i);
      
      let index = 0;
      const workers = Array(concurrency).fill(null).map(async () => {
        while (index < ids.length) {
          const currentIdx = index++;
          const id = ids[currentIdx];
          
          await this.processItem(jobId, id, job.projectId);
        }
      });

      await Promise.all(workers);

      await prisma.externalSyncJob.update({
        where: { id: jobId },
        data: { status: 'COMPLETED', completedAt: new Date() }
      });

    } catch (err: any) {
      logger.error({ err: err.message, jobId }, 'Mass sync job failed');
      await prisma.externalSyncJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', error: err.message, completedAt: new Date() }
      });
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  private async processItem(jobId: string, id: number, projectId: string) {
    const url = `${config.codemagen.baseUrl}/issues/${id}`;
    const { legacySourceKey, canonicalUrl, issueNumber } = parseLegacyTicketSource(url);
    const sourceUrl = canonicalUrl || url;

    try {
      const metadata = await redmineScraper.scrapeIssue(url);
      const converted = metadata.converted as Record<string, string | undefined | null>;

      const title = (typeof converted.title === 'string' && converted.title) || `Legacy Issue #${id}`;
      const statusSlug = STATUS_MAP[converted.Status || ''] || 'todo';
      const priorityStr = PRIORITY_MAP[converted.Priority || ''] || 'MEDIUM';
      const description = typeof converted.description === 'string' ? converted.description : null;
      const titleLc = typeof converted.title === 'string' ? converted.title.toLowerCase() : '';
      const parentLc = typeof converted.parentTask === 'string' ? converted.parentTask.toLowerCase() : '';
      const type =
        titleLc.includes('story') || parentLc.includes('story') ? 'STORY' : 'TASK';

      const workflowStates = await prisma.workflowState.findMany({ where: { projectId } });
      const defaultState = workflowStates.find((s) => s.isDefault) || workflowStates[0];
      const stateBySlug = Object.fromEntries(workflowStates.map((s) => [s.slug, s]));
      const state = stateBySlug[statusSlug] || defaultState;

      const projRow = await prisma.project.findUnique({
        where: { id: projectId },
        select: { companyId: true },
      });

      const assigneeIds: string[] = [];
      if (converted.Assignee && converted.Assignee !== '-' && converted.Assignee !== 'N/A') {
        const rawNames = String(converted.Assignee).split(/&|\||,|and/i).map((n: string) => n.trim()).filter(Boolean);
        for (const rawName of rawNames) {
          const user = await resolveOrCreateDeveloperFromAssignee(rawName);
          if (user) assigneeIds.push(user.id);
        }
      }

      const existing =
        legacySourceKey ?
          await prisma.ticket.findFirst({ where: { legacySourceKey, deletedAt: null } })
        : await prisma.ticket.findFirst({ where: { sourceUrl, deletedAt: null } });

      const payloadCore: Record<string, unknown> = {
        title,
        description,
        type: type as any,
        priority: priorityStr as any,
        metadata: metadata as any,
        syncJobId: jobId,
        sourceUrl,
        projectId,
      };
      if (legacySourceKey) payloadCore.legacySourceKey = legacySourceKey;
      if (issueNumber != null) payloadCore.legacyIssueNumber = issueNumber;
      if (projRow?.companyId) payloadCore.companyId = projRow.companyId;

      if (existing) {
        await prisma.ticket.update({
          where: { id: existing.id },
          data: {
            ...payloadCore,
            workflowStateId: state?.id || existing.workflowStateId,
            ...(assigneeIds.length > 0 ?
              { assignees: { set: assigneeIds.map((uid) => ({ id: uid })) } }
            : {}),
          } as any,
        });
      } else {
        await prisma.ticket.create({
          data: {
            ...(payloadCore as any),
            workflowStateId: state?.id || '',
            source: 'codemagen_scraper',
            ...(assigneeIds.length > 0 ?
              { assignees: { connect: assigneeIds.map((uid) => ({ id: uid })) } }
            : {}),
          },
        });
      }

      await prisma.externalSyncJob.update({
        where: { id: jobId },
        data: { 
          successCount: { increment: 1 },
          currentId: id
        }
      });

    } catch (err: any) {
      if (err.message?.includes('404') || err.message?.includes('not found')) {
        await prisma.externalSyncJob.update({
          where: { id: jobId },
          data: { skippedCount: { increment: 1 }, currentId: id }
        });
      } else {
        await prisma.externalSyncJob.update({
          where: { id: jobId },
          data: { failCount: { increment: 1 }, currentId: id }
        });
      }
    }
  }
}

export const massScraper = new MassScraperService();
