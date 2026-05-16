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
  {
    id: 'ticket-email-digest-daily',
    schedule: '0 8 * * *',
    description: 'Sends daily ticket activity digests to active users.',
    requiresEnvFlag: 'ENABLE_EMAIL_NOTIFICATIONS',
  },
  {
    id: 'github-project-sync',
    schedule: '*/30 * * * *',
    description: 'Queues GitHub repository/project sync for linked PMS projects.',
    requiresEnvFlag: 'ENABLE_GITHUB_INTEGRATION',
  },
  {
    id: 'github-daily-summary',
    schedule: '30 8 * * *',
    description: 'Builds daily GitHub activity summaries for mapped PMS users.',
    requiresEnvFlag: 'ENABLE_GITHUB_INTEGRATION',
  },
  {
    id: 'owner-analytics-report',
    schedule: '45 20 * * *',
    description: 'Sends scheduled owner analytics reports to opted-in recipients.',
    requiresEnvFlag: 'ENABLE_EMAIL_NOTIFICATIONS',
  },
  {
    id: 'email-delivery-drain',
    schedule: '*/10 * * * *',
    description: 'Sends QUEUED emails stuck when Redis/BullMQ was unavailable.',
    requiresEnvFlag: 'ENABLE_EMAIL_NOTIFICATIONS',
  },
] as const;
