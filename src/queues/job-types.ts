export type ImportJobData =
  | {
      type: 'google-sheet';
      sheetId: string;
      projectId: string;
      userId: string;
      configId?: string;
      columnMapping?: Record<string, string>;
      legacyTicketProjectId?: string | null;
    }
  | {
      type: 'excel-file';
      filePath: string;
      projectId: string;
      userId: string;
      columnMapping?: Record<string, string>;
    };

export type EmailJobData = {
  deliveryId: string;
  userId?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  templateKey: string;
  eventType: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
};

export type GitHubJobData =
  | {
      type: 'sync-project-link';
      projectGitHubLinkId: string;
      forceFull?: boolean;
      lookbackDays?: number;
      requestedBy?: string;
    }
  | {
      type: 'remap-project-identity';
      projectId: string;
      userId: string;
      lookbackDays?: number;
      requestedBy?: string;
    };

export type LegacySyncJobData = { ticketId: string };
