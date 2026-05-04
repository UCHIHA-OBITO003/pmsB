import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { z } from 'zod';
import { authenticate, requirePermission, AuthRequest } from '../middleware/auth';
import { excelImportService, extractSheetId } from '../services/excel-import.service';
import { AppError } from '../middleware/errorHandler';
import { config } from '../utils/config';
import { prisma } from '../utils/prisma';

const router = Router();
router.use(authenticate);

// ─── Multer setup ──────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: config.upload.dir,
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.upload.maxSizeMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel/CSV files allowed'));
    }
  },
});

// ─── Sheet Sync Configs ───────────────────────────────────────────────────

/**
 * GET /api/excel/sheet-configs
 * List all sheet sync configurations
 */
router.get('/sheet-configs', requirePermission('excel', 'read'), async (req, res) => {
  const configs = await excelImportService.listSyncConfigs();
  res.json({ success: true, data: configs });
});

/**
 * POST /api/excel/sheet-configs
 * Create or update a sheet sync configuration
 */
router.post('/sheet-configs', requirePermission('excel', 'create'), async (req: AuthRequest, res) => {
  const schema = z.object({
    projectId: z.string().uuid(),
    sheetUrl: z.string().url().includes('docs.google.com'),
    columnMapping: z.object({
      title: z.string().default('Task'),
      status: z.string().default('Status'),
      module: z.string().default('Module'),
      sourceUrl: z.string().default('Ticket'),
      priority: z.string().default('Priority'),
      description: z.string().default('Description'),
    }).default({}),
    intervalMins: z.number().min(5).max(1440).default(30),
    sheetName: z.string().optional(),
  });

  const data = schema.parse(req.body);
  const sheetId = extractSheetId(data.sheetUrl);
  if (!sheetId) throw new AppError(400, 'Invalid Google Sheet URL — could not extract Sheet ID', 'INVALID_URL');

  const cfg = await excelImportService.upsertSyncConfig({
    ...data,
    createdBy: req.user!.id,
  });

  res.status(201).json({ success: true, data: cfg });
});

/**
 * DELETE /api/excel/sheet-configs/:id
 * Remove a sheet sync configuration
 */
router.delete('/sheet-configs/:id', requirePermission('excel', 'delete'), async (req, res) => {
  await excelImportService.deleteSyncConfig(req.params.id);
  res.json({ success: true, message: 'Sync config removed' });
});

/**
 * PATCH /api/excel/sheet-configs/:id/toggle
 * Enable or disable a sync config
 */
router.patch('/sheet-configs/:id/toggle', requirePermission('excel', 'update'), async (req, res) => {
  const { isEnabled } = z.object({ isEnabled: z.boolean() }).parse(req.body);
  const updated = await (prisma as any).sheetSyncConfig.update({
    where: { id: req.params.id },
    data: { isEnabled },
  });
  res.json({ success: true, data: updated });
});

// ─── Sheet Preview ────────────────────────────────────────────────────────

/**
 * POST /api/excel/preview
 * Preview first rows from a Google Sheet (validates credentials + returns headers)
 */
router.post('/preview', requirePermission('excel', 'read'), async (req, res) => {
  const { sheetUrl, maxRows = 10 } = z.object({
    sheetUrl: z.string(),
    maxRows: z.number().min(1).max(50).default(10),
  }).parse(req.body);

  const sheetId = extractSheetId(sheetUrl);
  if (!sheetId) throw new AppError(400, 'Invalid Google Sheet URL', 'INVALID_URL');

  const preview = await excelImportService.previewSheet(sheetId, 'A:Z', maxRows);
  res.json({ success: true, data: preview });
});

// ─── Manual Sync ──────────────────────────────────────────────────────────

/**
 * POST /api/excel/sync
 * Manually trigger a Google Sheet sync
 */
router.post('/sync', requirePermission('excel', 'create'), async (req: AuthRequest, res) => {
  const schema = z.object({
    sheetUrl: z.string().optional(),
    sheetId: z.string().optional(),
    projectId: z.string().uuid(),
    configId: z.string().optional(),
    columnMapping: z.record(z.string()).optional(),
  });

  const { sheetUrl, sheetId: rawSheetId, projectId, configId, columnMapping } = schema.parse(req.body);

  const resolvedSheetId = rawSheetId || (sheetUrl ? extractSheetId(sheetUrl) : null);
  if (!resolvedSheetId) throw new AppError(400, 'Provide sheetUrl or sheetId', 'MISSING_PARAM');

  const result = await excelImportService.syncGoogleSheet(
    resolvedSheetId,
    projectId,
    req.user!.id,
    columnMapping as any || undefined,
    configId,
  );

  res.json({ success: true, data: result });
});

/**
 * POST /api/excel/sync-all
 * Manually trigger sync for all enabled configs (admin only)
 */
router.post('/sync-all', requirePermission('excel', 'create'), async (req, res) => {
  // Fire and forget — returns immediately
  excelImportService.runAllSyncConfigs().catch(() => {});
  res.json({ success: true, message: 'Sync triggered for all enabled configs' });
});

// ─── Import History ───────────────────────────────────────────────────────

/**
 * GET /api/excel/imports
 * Import history with optional project filter
 */
router.get('/imports', requirePermission('excel', 'read'), async (req, res) => {
  const { projectId, source, limit = '20' } = req.query as Record<string, string>;
  const where: any = {};
  if (projectId) where.projectId = projectId;
  if (source) where.source = source;

  const imports = await prisma.excelImport.findMany({
    where,
    include: {
      project: { select: { id: true, name: true, key: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: parseInt(limit),
  });

  res.json({ success: true, data: imports });
});

/**
 * GET /api/excel/imports/:id/rows
 * Get row-level import details
 */
router.get('/imports/:id/rows', requirePermission('excel', 'read'), async (req, res) => {
  const rows = await prisma.excelImportRow.findMany({
    where: { importId: req.params.id },
    orderBy: { rowNumber: 'asc' },
    take: 200,
  });
  res.json({ success: true, data: rows });
});

// ─── Excel File Upload & Import ───────────────────────────────────────────

/**
 * POST /api/excel/upload
 * Upload and validate an Excel/CSV file
 */
router.post('/upload', requirePermission('excel', 'create'), upload.single('file'), async (req: AuthRequest, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: { message: 'No file uploaded' } });
  const { projectId } = req.body;
  const result = await excelImportService.validateFile(req.file.path, projectId);
  res.json({ success: true, data: result });
});

/**
 * POST /api/excel/import
 * Import from an uploaded Excel/CSV file
 */
router.post('/import', requirePermission('excel', 'create'), async (req: AuthRequest, res) => {
  const { filePath, projectId, columnMapping } = req.body;
  const result = await excelImportService.importFile(filePath, projectId, columnMapping, req.user!.id);
  res.json({ success: true, data: result });
});

export default router;
