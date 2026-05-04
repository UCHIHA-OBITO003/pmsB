import ExcelJS from 'exceljs';
import crypto from 'crypto';
import { google } from 'googleapis';
import { STATUS_MAP, PRIORITY_MAP } from '../utils/mappings';
import { resolveUserAlias, isHanzDeveloper } from '../utils/user-mapping';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

// ─── Google Auth Helper ──────────────────────────────────────────────────────

// ─── Google Auth Helper ──────────────────────────────────────────────────────

async function getGoogleAuth() {
  const serviceAccountValue = config.google.serviceAccountPath;
  if (!serviceAccountValue || serviceAccountValue.startsWith('./') || serviceAccountValue.endsWith('.json')) {
    // It's a file path
    if (!serviceAccountValue) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not configured in .env');
    }
    return new google.auth.GoogleAuth({
      keyFile: serviceAccountValue,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } else if (serviceAccountValue.trim().startsWith('{')) {
    // It's a JSON string pasted inline
    return new google.auth.GoogleAuth({
      credentials: JSON.parse(serviceAccountValue),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } else {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON string or a path to a .json file');
  }
}

// ─── Extract Sheet ID from URL ───────────────────────────────────────────────

export function extractSheetId(url: string): string | null {
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export const excelImportService = {

  // ── Preview first N rows from a sheet (no import) ───────────────────────
  async previewSheet(sheetId: string, range = 'A:Z', maxRows = 10) {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() as any });

    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    const values = res.data.values || [];

    const [rawHeaders, ...rows] = values;
    const headers: string[] = (rawHeaders || []).map(String);

    const preview = rows.slice(0, maxRows).map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = String(row[i] || ''); });
      return obj;
    });

    return { headers, preview, totalRows: rows.length };
  },

  // ── Get or create SheetSyncConfig ───────────────────────────────────────
  async upsertSyncConfig(data: {
    projectId: string;
    sheetUrl: string;
    columnMapping: Record<string, string>;
    intervalMins?: number;
    createdBy?: string;
    sheetName?: string;
  }) {
    const sheetId = extractSheetId(data.sheetUrl);
    if (!sheetId) throw new Error('Invalid Google Sheet URL');

    const existing = await (prisma as any).sheetSyncConfig.findFirst({
      where: { projectId: data.projectId, sheetId },
    });

    if (existing) {
      return (prisma as any).sheetSyncConfig.update({
        where: { id: existing.id },
        data: {
          sheetUrl: data.sheetUrl,
          columnMapping: data.columnMapping,
          intervalMins: data.intervalMins ?? 30,
          isEnabled: true,
          sheetName: data.sheetName,
        },
      });
    }

    return (prisma as any).sheetSyncConfig.create({
      data: {
        projectId: data.projectId,
        sheetId,
        sheetUrl: data.sheetUrl,
        sheetName: data.sheetName,
        columnMapping: data.columnMapping,
        intervalMins: data.intervalMins ?? 30,
        createdBy: data.createdBy,
      },
    });
  },

  // ── List all sync configs (with project info) ────────────────────────────
  async listSyncConfigs() {
    return (prisma as any).sheetSyncConfig.findMany({
      include: { project: { select: { id: true, name: true, key: true } } },
      orderBy: { createdAt: 'desc' },
    });
  },

  // ── Delete a sync config ─────────────────────────────────────────────────
  async deleteSyncConfig(id: string) {
    return (prisma as any).sheetSyncConfig.delete({ where: { id } });
  },

  // ── Core Google Sheet → Tickets sync ────────────────────────────────────
  async syncGoogleSheet(
    sheetId: string,
    projectId: string,
    importedBy: string,
    columnMapping: Record<string, string> = {
      title: 'Task',
      status: 'Status',
      module: 'Module',
      sourceUrl: 'Ticket',
      priority: 'Priority',
      description: 'Description',
      assignees: 'Assignee',
    },
    configId?: string,
  ) {
    const start = Date.now();
    logger.info({ sheetId, projectId }, 'Starting Google Sheet sync');

    // Fetch sheet data
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() as any });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'A:Z',
    });

    const values = res.data.values || [];
    if (values.length === 0) {
      logger.warn({ sheetId }, 'Sheet is empty, skipping sync');
      return { importId: null, created: 0, updated: 0, skipped: 0, failed: 0 };
    }

    const [rawHeaders, ...rows] = values;
    const headers: string[] = (rawHeaders || []).map(String);

    // Create import log
    const importLog = await prisma.excelImport.create({
      data: {
        source: 'google_sheets',
        sourceId: sheetId,
        projectId,
        status: 'PROCESSING',
        columnMapping,
        importedBy,
      },
    });

    let created = 0, updated = 0, skipped = 0, failed = 0;

    // Get workflow states for this project
    const workflowStates = await prisma.workflowState.findMany({ where: { projectId } });
    const defaultState = workflowStates.find((s) => s.isDefault) || workflowStates[0];
    const stateBySlug = Object.fromEntries(workflowStates.map((s) => [s.slug, s]));

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const raw: Record<string, string> = {};
      headers.forEach((h, j) => { raw[h] = String(row[j] || '').trim(); });

      // Resolve fields using column mapping (fall back to common names)
      const title = raw[columnMapping.title] || raw['Task'] || raw['Title'] || '';
      if (!title || title.toLowerCase() === 'null' || title.toLowerCase() === 'undefined') {
        skipped++;
        continue;
      }

      const statusRaw = raw[columnMapping.status] || raw['Status'] || '';
      const statusSlug = STATUS_MAP[statusRaw] || 'todo';
      const state = stateBySlug[statusSlug] || defaultState;

      let sourceUrl = raw[columnMapping.sourceUrl] || raw['Ticket'] || raw['URL'] || '';
      // Extract http/https url if mixed with text like "Ticket #200 https://pms..."
      const urlMatch = sourceUrl.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        sourceUrl = urlMatch[0].trim();
      }
      const module = raw[columnMapping.module] || raw['Module'] || null;
      const priorityRaw = raw[columnMapping.priority] || raw['Priority'] || '';
      const priority = (PRIORITY_MAP[priorityRaw] || 'MEDIUM') as any;
      const description = raw[columnMapping.description] || raw['Description'] || null;

      // Parse assignees
      const assigneesRaw = raw[columnMapping.assignees] || raw['Assignees'] || raw['Assignee'] || raw['k'] || '';
      const assigneeNames = assigneesRaw
        .split(/&|\||,|and/i)
        .map(n => n.trim())
        .filter(n => n.length > 0);

      const assigneeIds: string[] = [];
      for (let rawName of assigneeNames) {
        const name = resolveUserAlias(rawName);
        
        // Try to find user by firstName (case-insensitive)
        let user = await prisma.user.findFirst({
          where: { firstName: { equals: name, mode: 'insensitive' }, deletedAt: null }
        });

        if (!user) {
          // Auto-create user
          const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}@pms.local`;
          const hash = await bcrypt.hash('Dev@123456', 10);
          const department = isHanzDeveloper(name) ? 'Hanz' : 'Codemagen';
          
          user = await prisma.user.create({
            data: {
              firstName: name,
              lastName: '',
              email,
              department,
              password: hash,
              roles: {
                create: {
                  role: { connect: { name: 'DEVELOPER' } }
                }
              }
            }
          }).catch(async () => {
             // If email exists or role connection fails, just create without role
             return prisma.user.create({
               data: { firstName: name, lastName: '', email: `${Date.now()}@pms.local`, password: hash, department }
             });
          });
          logger.info({ userId: user.id, name, department }, 'Auto-created new developer account');
        }

        // Add to project if not already
        const member = await prisma.projectMember.findFirst({
          where: { projectId, userId: user.id }
        });
        if (!member) {
          await prisma.projectMember.create({
            data: { projectId, userId: user.id, role: 'developer' }
          }).catch(() => {});
        }

        assigneeIds.push(user.id);
      }

      // Row hash for delta sync (skip rows that haven't changed)
      const rowHash = crypto.createHash('md5').update(JSON.stringify(raw)).digest('hex');

      // Find existing ticket by sourceUrl (most reliable key)
      const existing = sourceUrl
        ? await prisma.ticket.findFirst({ where: { sourceUrl, projectId, deletedAt: null }, include: { assignees: true } })
        : await prisma.ticket.findFirst({ where: { title, projectId, source: 'google_sheets', deletedAt: null }, include: { assignees: true } });

      if (existing?.rowHash === rowHash) {
        skipped++;
        continue;
      }

      const baseTicketFields = {
        projectId,
        title: String(title).slice(0, 500),
        description: description ? String(description).slice(0, 5000) : null,
        workflowStateId: state?.id,
        module: module ? String(module) : null,
        sourceUrl: sourceUrl || null,
        source: 'google_sheets' as const,
        rowHash,
        importId: importLog.id,
        priority,
      };

      const assigneesWrite =
        assigneeIds.length > 0
          ? existing
            ? { assignees: { set: assigneeIds.map((id) => ({ id })) } }
            : { assignees: { connect: assigneeIds.map((id) => ({ id })) } }
          : {};

      const ticketData = { ...baseTicketFields, ...assigneesWrite };

      try {
        if (existing) {
          await prisma.ticket.update({ where: { id: existing.id }, data: ticketData });
          updated++;
        } else {
          await prisma.ticket.create({ data: ticketData });
          created++;
        }

        await prisma.excelImportRow.create({
          data: {
            importId: importLog.id,
            rowNumber: i + 2, // +2 because row 1 is header, and 0-indexed
            rawData: raw,
            mappedData: ticketData,
            status: existing ? 'updated' : 'created',
          },
        }).catch(() => {}); // Non-critical
      } catch (e: any) {
        failed++;
        logger.error({ err: e, rowNumber: i + 2 }, 'Sheet sync row failed');
        await prisma.excelImportRow.create({
          data: {
            importId: importLog.id,
            rowNumber: i + 2,
            rawData: raw,
            status: 'failed',
            error: e.message,
          },
        }).catch(() => {});
      }
    }

    const stats = {
      importId: importLog.id,
      created,
      updated,
      skipped,
      failed,
      totalRows: rows.length,
      durationMs: Date.now() - start,
    };

    // Finalize import log
    await prisma.excelImport.update({
      where: { id: importLog.id },
      data: { status: failed > 0 && created + updated === 0 ? 'FAILED' : 'COMPLETED', totalRows: rows.length, created, updated, skipped, failed, completedAt: new Date() },
    });

    // Update SheetSyncConfig last sync time
    if (configId) {
      await (prisma as any).sheetSyncConfig.update({
        where: { id: configId },
        data: { lastSyncAt: new Date(), lastSyncStats: stats },
      }).catch(() => {});
    }

    // Create insight event if changes were found
    if (created > 0 || updated > 0) {
      await prisma.insightEvent.create({
        data: {
          projectId,
          type: 'sheet_sync',
          title: 'Google Sheet synced',
          body: `Auto-sync: ${created} tickets created, ${updated} updated from Google Sheet`,
          severity: 'info',
        },
      }).catch(() => {});
    }

    logger.info(stats, 'Google Sheet sync complete');
    return stats;
  },

  // ── Run all enabled sync configs (called by cron) ────────────────────────
  async runAllSyncConfigs() {
    let configs: any[] = [];
    try {
      configs = await (prisma as any).sheetSyncConfig.findMany({
        where: { isEnabled: true },
        include: { project: { select: { id: true, name: true, status: true, deletedAt: true } } },
      });
    } catch {
      // Model might not exist yet during first boot
      return;
    }

    const active = configs.filter((c: any) => c.project?.status === 'ACTIVE' && !c.project?.deletedAt);
    logger.info({ count: active.length }, 'Running sheet sync for configs');

    for (const cfg of active) {
      try {
        const cm = cfg.columnMapping as Record<string, string>;
        await excelImportService.syncGoogleSheet(
          cfg.sheetId,
          cfg.projectId,
          'system',
          cm,
          cfg.id,
        );
      } catch (e: any) {
        logger.error({ err: e, configId: cfg.id, projectId: cfg.projectId }, 'Sheet sync failed for config');
        // Update config with error status
        await (prisma as any).sheetSyncConfig.update({
          where: { id: cfg.id },
          data: {
            lastSyncAt: new Date(),
            lastSyncStats: { error: e.message, failed: -1 },
          },
        }).catch(() => {});
      }
    }
  },

  // ── Excel file import (unchanged) ────────────────────────────────────────
  async validateFile(filePath: string, projectId?: string) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const sheets = workbook.worksheets.map((ws) => ({
      name: ws.name,
      rowCount: ws.rowCount,
      headers: ws.getRow(1).values as string[],
    }));

    return { sheets, filePath, valid: sheets.length > 0 };
  },

  async importFile(filePath: string, projectId: string, columnMapping: Record<string, string>, importedBy: string) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const ws = workbook.worksheets[0];

    const importLog = await prisma.excelImport.create({
      data: { source: 'excel', projectId, status: 'PROCESSING', columnMapping, importedBy },
    });

    const headers: string[] = (ws.getRow(1).values as string[]).filter(Boolean);
    let created = 0, updated = 0, skipped = 0, failed = 0;
    const rows: any[] = [];

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const raw: Record<string, any> = {};
      headers.forEach((h, i) => { raw[h] = (row.values as any[])[i + 1]; });
      rows.push({ rowNumber, raw });
    });

    const defaultState = await prisma.workflowState.findFirst({ where: { projectId, isDefault: true } });

    for (const { rowNumber, raw } of rows) {
      const title = raw[columnMapping.title] || raw['Task'] || raw['Title'] || '';
      if (!title) { skipped++; continue; }

      const rowHash = crypto.createHash('md5').update(JSON.stringify(raw)).digest('hex');
      const sourceUrl = raw[columnMapping.sourceUrl] || raw['Ticket'] || '';

      const existing = sourceUrl
        ? await prisma.ticket.findFirst({ where: { sourceUrl, projectId } })
        : null;

      if (existing?.rowHash === rowHash) { skipped++; continue; }

      const statusSlug = STATUS_MAP[raw[columnMapping.status] || raw['Status'] || ''] || 'todo';
      const state = await prisma.workflowState.findFirst({ where: { projectId, slug: statusSlug } }) || defaultState;

      const ticketData = {
        projectId,
        title: String(title),
        workflowStateId: state?.id,
        module: raw[columnMapping.module] || raw['Module'],
        screen: raw[columnMapping.screen] || raw['Screen'],
        sourceUrl: sourceUrl || null,
        source: 'excel' as const,
        rowHash,
        importId: importLog.id,
        priority: (PRIORITY_MAP[raw[columnMapping.priority] || raw['Priority'] || ''] || 'MEDIUM') as any,
      };

      try {
        if (existing) {
          await prisma.ticket.update({ where: { id: existing.id }, data: ticketData });
          updated++;
        } else {
          await prisma.ticket.create({ data: ticketData });
          created++;
        }

        await prisma.excelImportRow.create({
          data: { importId: importLog.id, rowNumber, rawData: raw, mappedData: ticketData, status: existing ? 'updated' : 'created' },
        });
      } catch (e: any) {
        failed++;
        logger.error({ err: e, rowNumber }, 'Import row failed');
        await prisma.excelImportRow.create({
          data: { importId: importLog.id, rowNumber, rawData: raw, status: 'failed', error: e.message },
        });
      }
    }

    await prisma.excelImport.update({
      where: { id: importLog.id },
      data: { status: 'COMPLETED', totalRows: rows.length, created, updated, skipped, failed, completedAt: new Date() },
    });

    return { importId: importLog.id, created, updated, skipped, failed };
  },
};
