/** Single source of truth for cron schedules shown in Admin → System / used at startup */
export const CRON_MANIFEST = [
  {
    id: 'developer-metrics-daily',
    schedule: '0 2 * * *',
    description: 'Recomputes developer metrics (daily rollup).',
    requiresEnvFlag: null as string | null,
  },
  {
    id: 'google-sheet-sync',
    schedule: '*/30 * * * *',
    description: 'Syncs Google Sheets when configs exist and ENABLE_GOOGLE_SHEETS_SYNC=true.',
    requiresEnvFlag: 'ENABLE_GOOGLE_SHEETS_SYNC',
  },
  {
    id: 'bottleneck-detection-hourly',
    schedule: '0 * * * *',
    description: 'Runs bottleneck detection for active work.',
    requiresEnvFlag: null as string | null,
  },
] as const;
