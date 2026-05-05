import { prisma } from '../src/utils/prisma';
import { redmineScraper } from '../src/services/redmine-scraper.service';
import { resolveOrCreateDeveloperFromAssignee } from '../src/utils/assignee-import-user';
import { STATUS_MAP, PRIORITY_MAP } from '../src/utils/mappings';

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function massImport() {
  const args = process.argv.slice(2);
  const projectIdIndex = args.indexOf('--project-id');
  const startIndex = args.indexOf('--start');
  const endIndex = args.indexOf('--end');

  const projectId = projectIdIndex !== -1 ? args[projectIdIndex + 1] : process.env.DEFAULT_PROJECT_ID;
  const startId = startIndex !== -1 ? parseInt(args[startIndex + 1], 10) : 1;
  const endId = endIndex !== -1 ? parseInt(args[endIndex + 1], 10) : 11160;

  if (!projectId) {
    console.error('Error: --project-id is required');
    process.exit(1);
  }

  console.log(`Starting mass extraction from Redmine for Project: ${projectId}`);
  console.log(`Range: ID ${startId} to ${endId}`);

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (let id = startId; id <= endId; id++) {
    const url = `https://pms.codemagen.net/issues/${id}`;
    
    try {
      console.log(`[${id}/${endId}] Fetching ${url}...`);
      const metadata = await redmineScraper.scrapeIssue(url);

      // Parse fields
      const converted = metadata.converted;
      const title = converted.title || `Legacy Issue #${id}`;
      const statusSlug = STATUS_MAP[converted.Status || ''] || 'todo';
      const priorityStr = PRIORITY_MAP[converted.Priority || ''] || 'MEDIUM';
      const description = converted.description || null;
      const type = converted.title?.toLowerCase().includes('story') || converted.parentTask?.toLowerCase().includes('story') ? 'STORY' : 'TASK';

      // Workflow state mapping
      const workflowStates = await prisma.workflowState.findMany({ where: { projectId } });
      const defaultState = workflowStates.find((s) => s.isDefault) || workflowStates[0];
      const stateBySlug = Object.fromEntries(workflowStates.map((s) => [s.slug, s]));
      const state = stateBySlug[statusSlug] || defaultState;

      // Ensure assignees are mapped
      const assigneeIds: string[] = [];
      if (converted.Assignee && converted.Assignee !== '-' && converted.Assignee !== 'N/A') {
        const rawNames = converted.Assignee.split(/&|\||,|and/i).map((n: string) => n.trim()).filter(Boolean);
        
        for (const rawName of rawNames) {
          const user = await resolveOrCreateDeveloperFromAssignee(rawName);
          if (user) assigneeIds.push(user.id);
        }
      }

      // Upsert Ticket
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
            workflowStateId: state.id,
            metadata: metadata as any,
            assignees: assigneeIds.length > 0 ? { set: assigneeIds.map(id => ({ id })) } : undefined
          }
        });
        console.log(`  -> Updated existing ticket: ${existing.id}`);
      } else {
        await prisma.ticket.create({
          data: {
            projectId,
            title,
            description,
            type: type as any,
            priority: priorityStr as any,
            workflowStateId: state.id,
            sourceUrl: url,
            source: 'codemagen_scraper',
            metadata: metadata as any,
            assignees: assigneeIds.length > 0 ? { connect: assigneeIds.map(id => ({ id })) } : undefined
          }
        });
        console.log(`  -> Created new ticket from legacy`);
      }
      
      success++;
      
      // Delay to avoid ban (Codemagen servers will throw 429 or ban IPs if hammered)
      await delay(1000);

    } catch (err: any) {
      if (err.message === 'Issue not found or unauthorized') {
        console.log(`  -> Skipped (404/403)`);
        skipped++;
      } else if (err.message.includes('Cannot scrape issue without authentication')) {
        console.error(`  -> Authentication Failed! Aborting...`);
        break;
      } else {
        console.error(`  -> Failed: ${err.message}`);
        failed++;
        await delay(2000); // Wait longer on failure
      }
    }
  }

  console.log('---');
  console.log(`Extraction Complete. Success: ${success}, Skipped: ${skipped}, Failed: ${failed}`);
}

massImport().catch(console.error).finally(() => prisma.$disconnect());
