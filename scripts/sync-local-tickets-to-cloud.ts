import { PrismaClient, Prisma } from '@prisma/client';

function required(name: string): string {
  const val = process.env[name];
  if (!val || !val.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

async function main() {
  const localUrl = required('LOCAL_DATABASE_URL');
  const cloudUrl = required('DATABASE_URL');

  const source = new PrismaClient({ datasources: { db: { url: localUrl } } });
  const target = new PrismaClient({ datasources: { db: { url: cloudUrl } } });

  try {
    const sourceTickets = await source.ticket.findMany({
      where: { deletedAt: null },
      include: {
        assignees: { select: { id: true } },
        comments: true,
        attachments: true,
        history: true,
        statusDurations: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (sourceTickets.length === 0) {
      console.log('No local tickets found to sync.');
      return;
    }

    const userIds = new Set<string>();
    const projectIds = new Set<string>();
    const sprintIds = new Set<string>();
    const workflowStateIds = new Set<string>();

    for (const t of sourceTickets) {
      projectIds.add(t.projectId);
      if (t.sprintId) sprintIds.add(t.sprintId);
      if (t.workflowStateId) workflowStateIds.add(t.workflowStateId);
      if (t.reporterId) userIds.add(t.reporterId);
      for (const a of t.assignees) userIds.add(a.id);
      for (const c of t.comments) userIds.add(c.authorId);
    }

    const [users, projects, workflowStates, sprints] = await Promise.all([
      source.user.findMany({ where: { id: { in: [...userIds] } } }),
      source.project.findMany({ where: { id: { in: [...projectIds] } } }),
      source.workflowState.findMany({ where: { id: { in: [...workflowStateIds] } } }),
      source.sprint.findMany({ where: { id: { in: [...sprintIds] } } }),
    ]);

    const userIdMap = new Map<string, string>();
    const projectIdMap = new Map<string, string>();
    const workflowStateIdMap = new Map<string, string>();
    const sprintIdMap = new Map<string, string>();

    for (const u of users) {
      const saved = await target.user.upsert({
        where: { email: u.email },
        create: {
          email: u.email,
          password: u.password,
          firstName: u.firstName,
          lastName: u.lastName,
          avatar: u.avatar ?? undefined,
          phone: u.phone ?? undefined,
          department: u.department ?? undefined,
          designation: u.designation ?? undefined,
          skills: u.skills ?? [],
          status: u.status,
          emailVerified: u.emailVerified,
          lastLogin: u.lastLogin ?? undefined,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
          deletedAt: u.deletedAt ?? undefined,
        },
        update: {
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          avatar: u.avatar ?? undefined,
          phone: u.phone ?? undefined,
          department: u.department ?? undefined,
          designation: u.designation ?? undefined,
          skills: u.skills ?? [],
          status: u.status,
          emailVerified: u.emailVerified,
          lastLogin: u.lastLogin ?? undefined,
          deletedAt: u.deletedAt ?? undefined,
        },
      });
      userIdMap.set(u.id, saved.id);
    }

    for (const p of projects) {
      const saved = await target.project.upsert({
        where: { key: p.key },
        create: {
          name: p.name,
          key: p.key,
          description: p.description ?? undefined,
          status: p.status,
          teamId: p.teamId ?? undefined,
          ownerId: p.ownerId ? userIdMap.get(p.ownerId) : undefined,
          startDate: p.startDate ?? undefined,
          endDate: p.endDate ?? undefined,
          budget: p.budget ?? undefined,
          healthScore: p.healthScore ?? undefined,
          metadata: p.metadata ?? undefined,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          deletedAt: p.deletedAt ?? undefined,
        },
        update: {
          name: p.name,
          key: p.key,
          description: p.description ?? undefined,
          status: p.status,
          teamId: p.teamId ?? undefined,
          ownerId: p.ownerId ? userIdMap.get(p.ownerId) : undefined,
          startDate: p.startDate ?? undefined,
          endDate: p.endDate ?? undefined,
          budget: p.budget ?? undefined,
          healthScore: p.healthScore ?? undefined,
          metadata: p.metadata ?? undefined,
          deletedAt: p.deletedAt ?? undefined,
        },
      });
      projectIdMap.set(p.id, saved.id);
    }

    for (const w of workflowStates) {
      const mappedProjectId = w.projectId ? projectIdMap.get(w.projectId) : undefined;
      const existing = await target.workflowState.findFirst({
        where: { projectId: mappedProjectId ?? null, slug: w.slug },
      });
      const saved = existing
        ? await target.workflowState.update({
            where: { id: existing.id },
            data: {
              projectId: mappedProjectId,
              name: w.name,
              color: w.color,
              order: w.order,
              isDefault: w.isDefault,
              isFinal: w.isFinal,
            },
          })
        : await target.workflowState.create({
            data: {
              projectId: mappedProjectId,
              name: w.name,
              slug: w.slug,
              color: w.color,
              order: w.order,
              isDefault: w.isDefault,
              isFinal: w.isFinal,
              createdAt: w.createdAt,
            },
          });
      workflowStateIdMap.set(w.id, saved.id);
    }

    for (const s of sprints) {
      const mappedProjectId = projectIdMap.get(s.projectId);
      if (!mappedProjectId) continue;
      const existing = await target.sprint.findFirst({
        where: { projectId: mappedProjectId, name: s.name },
      });
      const saved = existing
        ? await target.sprint.update({
            where: { id: existing.id },
            data: {
              goal: s.goal ?? undefined,
              status: s.status,
              startDate: s.startDate ?? undefined,
              endDate: s.endDate ?? undefined,
              velocity: s.velocity ?? undefined,
              capacity: s.capacity ?? undefined,
            },
          })
        : await target.sprint.create({
            data: {
              projectId: mappedProjectId,
              name: s.name,
              goal: s.goal ?? undefined,
              status: s.status,
              startDate: s.startDate ?? undefined,
              endDate: s.endDate ?? undefined,
              velocity: s.velocity ?? undefined,
              capacity: s.capacity ?? undefined,
              createdAt: s.createdAt,
              updatedAt: s.updatedAt,
            },
          });
      sprintIdMap.set(s.id, saved.id);
    }

    const ticketIds = new Set(sourceTickets.map((t) => t.id));

    for (const t of sourceTickets) {
      const mappedProjectId = projectIdMap.get(t.projectId);
      if (!mappedProjectId) continue;
      const data: Prisma.TicketUncheckedCreateInput = {
        id: t.id,
        projectId: mappedProjectId,
        sprintId: t.sprintId ? sprintIdMap.get(t.sprintId) : undefined,
        workflowStateId: t.workflowStateId ? workflowStateIdMap.get(t.workflowStateId) : undefined,
        parentId: undefined,
        title: t.title,
        description: t.description ?? undefined,
        type: t.type,
        priority: t.priority,
        reporterId: t.reporterId ? userIdMap.get(t.reporterId) : undefined,
        storyPoints: t.storyPoints ?? undefined,
        estimatedHours: t.estimatedHours ?? undefined,
        actualHours: t.actualHours ?? undefined,
        dueDate: t.dueDate ?? undefined,
        startedAt: t.startedAt ?? undefined,
        completedAt: t.completedAt ?? undefined,
        module: t.module ?? undefined,
        screen: t.screen ?? undefined,
        tags: t.tags,
        sourceUrl: t.sourceUrl ?? undefined,
        sourceRef: t.sourceRef ?? undefined,
        source: t.source,
        rowHash: t.rowHash ?? undefined,
        importId: undefined,
        metadata: t.metadata ?? undefined,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        deletedAt: t.deletedAt ?? undefined,
        syncJobId: undefined,
      };

      await target.ticket.upsert({
        where: { id: t.id },
        create: data,
        update: { ...data, id: undefined },
      });

      await target.ticket.update({
        where: { id: t.id },
        data: {
          assignees: {
            set: t.assignees
              .map((a) => userIdMap.get(a.id))
              .filter((id): id is string => Boolean(id))
              .map((id) => ({ id })),
          },
        },
      });
    }

    for (const t of sourceTickets) {
      if (t.parentId && ticketIds.has(t.parentId)) {
        await target.ticket.update({
          where: { id: t.id },
          data: { parentId: t.parentId },
        });
      }
    }

    const ids = sourceTickets.map((t) => t.id);
    await target.ticketComment.deleteMany({ where: { ticketId: { in: ids } } });
    await target.ticketAttachment.deleteMany({ where: { ticketId: { in: ids } } });
    await target.ticketHistory.deleteMany({ where: { ticketId: { in: ids } } });
    await target.ticketStatusDuration.deleteMany({ where: { ticketId: { in: ids } } });

    const comments = sourceTickets.flatMap((t) =>
      t.comments.map((c) => ({
        id: c.id,
        ticketId: c.ticketId,
        authorId: userIdMap.get(c.authorId) ?? c.authorId,
        body: c.body,
        isEdited: c.isEdited,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        deletedAt: c.deletedAt ?? undefined,
      })),
    );
    if (comments.length) await target.ticketComment.createMany({ data: comments });

    const attachments = sourceTickets.flatMap((t) =>
      t.attachments.map((a) => ({
        id: a.id,
        ticketId: a.ticketId,
        uploadedById: a.uploadedById,
        filename: a.filename,
        originalName: a.originalName,
        mimeType: a.mimeType,
        size: a.size,
        url: a.url,
        createdAt: a.createdAt,
      })),
    );
    if (attachments.length) await target.ticketAttachment.createMany({ data: attachments });

    const history = sourceTickets.flatMap((t) =>
      t.history.map((h) => ({
        id: h.id,
        ticketId: h.ticketId,
        actorId: h.actorId ?? undefined,
        field: h.field,
        oldValue: h.oldValue ?? undefined,
        newValue: h.newValue ?? undefined,
        createdAt: h.createdAt,
      })),
    );
    if (history.length) await target.ticketHistory.createMany({ data: history });

    const durations = sourceTickets.flatMap((t) =>
      t.statusDurations.map((d) => ({
        id: d.id,
        ticketId: d.ticketId,
        status: d.status,
        startedAt: d.startedAt,
        endedAt: d.endedAt ?? undefined,
        duration: d.duration ?? undefined,
      })),
    );
    if (durations.length) await target.ticketStatusDuration.createMany({ data: durations });

    console.log(
      `Synced ${sourceTickets.length} tickets, ${comments.length} comments, ${attachments.length} attachments, ${history.length} history rows.`,
    );
  } finally {
    await source.$disconnect();
    await target.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

