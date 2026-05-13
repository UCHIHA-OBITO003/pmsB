import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, requirePermission } from '../middleware/auth';
import { config } from '../utils/config';
import { AppError } from '../middleware/errorHandler';

// Use runtime requires here to keep deploy-time type memory down on Render.
const Anthropic = require('@anthropic-ai/sdk').default as any;
const OpenAI = require('openai').default as any;

const router = Router();
router.use(authenticate);

const claude = new Anthropic({ apiKey: config.ai.anthropicKey });
const openai = new OpenAI({ apiKey: config.ai.openaiKey });

// POST /api/ai/query — Natural language → data query
router.post('/query', async (req, res) => {
  if (!config.features.ai) throw new AppError(503, 'AI features disabled', 'FEATURE_DISABLED');

  const { query, projectId } = z.object({
    query: z.string().min(1).max(1000),
    projectId: z.string().uuid().optional(),
  }).parse(req.body);

  const start = Date.now();

  // Get schema context for Claude
  const contextData = await prisma.$transaction([
    prisma.ticket.count({ where: projectId ? { projectId } : {} }),
    prisma.sprint.findFirst({ where: projectId ? { projectId, status: 'ACTIVE' } : { status: 'ACTIVE' } }),
  ]);

  const systemPrompt = `You are an AI assistant for an engineering project management platform.
You help users query their project data using natural language.
Available data: tickets, sprints, users, projects, analytics.
Return a structured JSON response with: { summary: string, data: any[], insights: string[] }
Keep responses concise and actionable.
Project context: ${projectId ? `Project ID ${projectId}` : 'All projects'}
Ticket count: ${contextData[0]}, Active sprint: ${contextData[1]?.name || 'None'}`;

  const message = await claude.messages.create({
    model: config.ai.claudeModel,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: query }],
  });

  const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

  // Log usage
  await prisma.aiQueryLog.create({
    data: {
      provider: 'claude',
      model: config.ai.claudeModel,
      prompt: query,
      response: responseText,
      tokensIn: message.usage.input_tokens,
      tokensOut: message.usage.output_tokens,
      latencyMs: Date.now() - start,
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    parsed = { summary: responseText, data: [], insights: [] };
  }

  res.json({ success: true, data: parsed });
});

// POST /api/ai/summarize — Sprint/project AI summary
router.post('/summarize', async (req, res) => {
  if (!config.features.ai) throw new AppError(503, 'AI features disabled', 'FEATURE_DISABLED');

  const { type, id } = z.object({
    type: z.enum(['sprint', 'project', 'developer']),
    id: z.string().uuid(),
  }).parse(req.body);

  let context = '';

  if (type === 'sprint') {
    const sprint = await prisma.sprint.findUnique({
      where: { id },
      include: {
        tickets: {
          include: {
            workflowState: true,
            assignees: { select: { firstName: true, lastName: true } },
          },
        },
        analytics: true,
      },
    });

    const sprintAnalytic = sprint?.analytics?.[0];
    const done = sprint?.tickets.filter((t) => t.workflowState?.slug === 'done').length || 0;
    const blocked = sprint?.tickets.filter((t) => t.workflowState?.slug === 'blocked').length || 0;
    context = `Sprint: ${sprint?.name}, Status: ${sprint?.status}
Tickets: ${sprint?.tickets.length} total, ${done} done, ${blocked} blocked
Goal: ${sprint?.goal || 'No goal set'}
Velocity: ${sprintAnalytic?.velocity ?? 'N/A'} points
Completion: ${sprintAnalytic?.completionPct != null ? sprintAnalytic.completionPct.toFixed(1) : 'N/A'}%`;
  }

  const message = await claude.messages.create({
    model: config.ai.claudeModel,
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Write a concise, professional ${type} retrospective summary based on this data:\n\n${context}\n\nFormat: 3–5 bullet points. Highlight wins, risks, and next steps.`,
    }],
  });

  const summary = message.content[0].type === 'text' ? message.content[0].text : '';
  res.json({ success: true, data: { summary } });
});

// GET /api/ai/sprint-forecast — Sprint completion prediction
router.get('/sprint-forecast', async (req, res) => {
  if (!config.features.ai) throw new AppError(503, 'AI features disabled', 'FEATURE_DISABLED');

  const { sprintId } = z.object({ sprintId: z.string().uuid() }).parse(req.query);

  const sprint = await prisma.sprint.findUnique({
    where: { id: sprintId },
    include: {
      tickets: { include: { workflowState: true } },
      project: { include: { analytics: { take: 3, orderBy: { computedAt: 'desc' } } } },
    },
  });

  if (!sprint) throw new AppError(404, 'Sprint not found', 'NOT_FOUND');

  const total = sprint.tickets.length;
  const done = sprint.tickets.filter((t) => t.workflowState?.slug === 'done').length;
  const blocked = sprint.tickets.filter((t) => t.workflowState?.slug === 'blocked').length;
  const daysLeft = sprint.endDate
    ? Math.max(0, Math.ceil((sprint.endDate.getTime() - Date.now()) / 86400000))
    : 0;

  const prompt = `You are a sprint forecasting AI. Given this sprint data, predict completion probability.
Sprint: ${sprint.name}
Total tickets: ${total}, Done: ${done}, Blocked: ${blocked}
Days remaining: ${daysLeft}
Progress: ${total > 0 ? Math.round((done / total) * 100) : 0}%

Return JSON only: { probability: number (0-100), confidence: "low"|"medium"|"high", risk: "low"|"medium"|"high"|"critical", recommendation: string }`;

  const completion = await openai.chat.completions.create({
    model: config.ai.openaiModel,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    max_tokens: 256,
  });

  let forecast;
  try {
    forecast = JSON.parse(completion.choices[0].message.content || '{}');
  } catch {
    forecast = { probability: 50, confidence: 'low', risk: 'medium', recommendation: 'Insufficient data' };
  }

  // Store prediction
  await prisma.predictiveRisk.create({
    data: {
      projectId: sprint.projectId,
      sprintId: sprint.id,
      type: 'delay',
      severity: forecast.risk || 'medium',
      score: (forecast.probability || 50) / 100,
      aiAnalysis: forecast.recommendation,
    },
  });

  res.json({ success: true, data: { ...forecast, sprint: { id: sprint.id, name: sprint.name } } });
});

// POST /api/ai/risk-detect — Silent risk detection
router.post('/risk-detect', async (req, res) => {
  if (!config.features.ai) throw new AppError(503, 'AI features disabled', 'FEATURE_DISABLED');

  const { projectId } = z.object({ projectId: z.string().uuid() }).parse(req.body);

  // Find stale tickets
  const staleCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const staleTickets = await prisma.ticket.findMany({
    where: {
      projectId,
      deletedAt: null,
      workflowState: { slug: { in: ['in_progress', 'blocked'] } },
      updatedAt: { lt: staleCutoff },
    },
    include: {
      assignees: { select: { id: true, firstName: true, lastName: true } },
      workflowState: true,
    },
  });

  const risks = await Promise.all(staleTickets.map(async (ticket) => {
    const staleDays = Math.floor((Date.now() - ticket.updatedAt.getTime()) / 86400000);

    // Upsert bottleneck: find existing record by projectId + ticketId + type
    const existing = await prisma.bottleneckEvent.findFirst({
      where: { projectId, ticketId: ticket.id, type: 'stuck_ticket', resolved: false },
    });

    if (existing) {
      await prisma.bottleneckEvent.update({
        where: { id: existing.id },
        data: { staleDays },
      });
    } else {
      await prisma.bottleneckEvent.create({
        data: {
          projectId,
          ticketId: ticket.id,
          userId: ticket.assignees?.[0]?.id || undefined,
          type: 'stuck_ticket',
          description: `Ticket stale for ${staleDays} days`,
          staleDays,
        },
      }).catch(() => {});
    }
    return {
      ticketId: ticket.id,
      title: ticket.title,
      assignees: ticket.assignees,
      staleDays,
      status: ticket.workflowState?.name,
      riskLevel: staleDays > 7 ? 'critical' : staleDays > 5 ? 'high' : 'medium',
    };
  }));

  res.json({ success: true, data: { risks, count: risks.length } });
});

export default router;
