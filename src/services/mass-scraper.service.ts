import { prisma } from '../utils/prisma';
import { redmineScraper } from './redmine-scraper.service';
import { resolveUserAlias, isHanzDeveloper } from '../utils/user-mapping';
import bcrypt from 'bcryptjs';
import { STATUS_MAP, PRIORITY_MAP } from '../utils/mappings';
import { logger } from '../utils/logger';

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
    const url = `https://pms.codemagen.net/issues/${id}`;
    
    try {
      const metadata = await redmineScraper.scrapeIssue(url);
      const converted = metadata.converted;

      const title = converted.title || `Legacy Issue #${id}`;
      const statusSlug = STATUS_MAP[converted.Status || ''] || 'todo';
      const priorityStr = PRIORITY_MAP[converted.Priority || ''] || 'MEDIUM';
      const description = converted.description || null;
      const type = converted.title?.toLowerCase().includes('story') || converted.parentTask?.toLowerCase().includes('story') ? 'STORY' : 'TASK';

      // Workflow state
      const workflowStates = await prisma.workflowState.findMany({ where: { projectId } });
      const defaultState = workflowStates.find((s) => s.isDefault) || workflowStates[0];
      const stateBySlug = Object.fromEntries(workflowStates.map((s) => [s.slug, s]));
      const state = stateBySlug[statusSlug] || defaultState;

      // Assignees
      const assigneeIds: string[] = [];
      if (converted.Assignee && converted.Assignee !== '-' && converted.Assignee !== 'N/A') {
        const rawNames = converted.Assignee.split(/&|\||,|and/i).map((n: string) => n.trim()).filter(Boolean);
        for (const rawName of rawNames) {
          const name = resolveUserAlias(rawName);
          let user = await prisma.user.findFirst({
            where: { firstName: { equals: name, mode: 'insensitive' }, deletedAt: null }
          });

          if (!user) {
            const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}@pms.local`;
            const hash = await bcrypt.hash('Dev@123456', 10);
            const department = isHanzDeveloper(name) ? 'Hanz' : 'Codemagen';
            user = await prisma.user.create({
              data: { firstName: name, lastName: '', email, department, password: hash }
            });
          }
          assigneeIds.push(user.id);
        }
      }

      // Upsert
      const existing = await prisma.ticket.findFirst({
        where: { sourceUrl: url, deletedAt: null }
      });

      if (existing) {
        await prisma.ticket.update({
          where: { id: existing.id },
          data: {
            title,
            description,
            type: type as any,
            priority: priorityStr as any,
            workflowStateId: state?.id || existing.workflowStateId,
            metadata: metadata as any,
            syncJobId: jobId,
            assignees: assigneeIds.length > 0 ? { set: assigneeIds.map(id => ({ id })) } : undefined
          }
        });
      } else {
        await prisma.ticket.create({
          data: {
            projectId,
            title,
            description,
            type: type as any,
            priority: priorityStr as any,
            workflowStateId: state?.id || '',
            sourceUrl: url,
            source: 'codemagen_scraper',
            metadata: metadata as any,
            syncJobId: jobId,
            assignees: assigneeIds.length > 0 ? { connect: assigneeIds.map(id => ({ id })) } : undefined
          }
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
