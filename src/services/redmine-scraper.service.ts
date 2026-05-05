import axios, { isAxiosError } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { logger } from '../utils/logger';
import { resolveUserAlias } from '../utils/user-mapping';
import { config } from '../utils/config';

/**
 * Fetches issues from Codemagen (Redmine) JSON API using **HTTP Basic auth only**.
 * Credentials: CODEMAGEN_USERNAME + CODEMAGEN_PASSWORD (or REDMINE_* aliases) via config — no hardcoded passwords, no browser session login.
 */
export class RedmineScraperService {
  private client: any;
  private jar: CookieJar;
  private baseUrl: string;
  private isAuthenticated: boolean = false;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || config.codemagen.baseUrl;
    this.jar = new CookieJar();
    this.client = wrapper(
      axios.create({
        baseURL: this.baseUrl,
        jar: this.jar,
        withCredentials: true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
          Accept: 'application/json, text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8',
        },
      }),
    );
  }

  private requireBasicAuth(): { user: string; pass: string } {
    const user = config.codemagen.username;
    const pass = config.codemagen.password;
    if (!user || !pass) {
      throw new Error(
        'Codemagen API credentials missing. Set CODEMAGEN_USERNAME and CODEMAGEN_PASSWORD (or REDMINE_USERNAME / REDMINE_PASSWORD) in the server environment for HTTP Basic access to the JSON API.',
      );
    }
    return { user, pass };
  }

  /** Accepts issue id, `/issues/123`, full Codemagen URL, or messy strings that contain an `https://…/issues/…` URL. */
  private normalizeIssueRef(urlOrId: string): string {
    const s = urlOrId.trim();
    const embedded = s.match(/https?:\/\/[^\s]+/i);
    if (embedded) {
      return embedded[0].replace(/\/$/, '').replace(/\.json(\?.*)?$/i, '');
    }
    if (/^https?:\/\//i.test(s)) {
      return s.replace(/\/$/, '').replace(/\.json(\?.*)?$/i, '');
    }
    if (/^\/issues\/\d+/i.test(s)) {
      return s.replace(/\/$/, '');
    }
    if (/^\d+$/.test(s)) {
      return `/issues/${s}`;
    }
    return `/issues/${s}`;
  }

  private buildConvertedFromRaw(rawData: Record<string, unknown>) {
    const customFields: Record<string, string> = {};
    const cfs = rawData.custom_fields as { name: string; value: unknown }[] | undefined;
    if (cfs) {
      for (const cf of cfs) {
        customFields[cf.name] = String(cf.value ?? '');
      }
    }

    const parent = rawData.parent as { id?: number } | undefined;
    const assigned = rawData.assigned_to as { name?: string } | undefined;

    const converted = {
      title: rawData.subject,
      parentTask: parent?.id ? `Issue #${parent.id}` : '',
      Status: (rawData.status as { name?: string } | undefined)?.name,
      Priority: (rawData.priority as { name?: string } | undefined)?.name,
      Assignee: assigned?.name ? resolveUserAlias(assigned.name) : '',
      Author: (rawData.author as { name?: string } | undefined)?.name,
      Tracker: (rawData.tracker as { name?: string } | undefined)?.name,
      'Target Version (Sprint)': (rawData.fixed_version as { name?: string } | undefined)?.name,
      'Start Date': rawData.start_date,
      'Due Date': rawData.due_date,
      '% Done':
        rawData.done_ratio !== undefined && rawData.done_ratio !== null
          ? `${rawData.done_ratio}%`
          : '',
      'Estimated Time':
        rawData.estimated_hours !== undefined && rawData.estimated_hours !== null
          ? `${rawData.estimated_hours} h`
          : '',
      description: rawData.description,
      scrapedAt: new Date().toISOString(),
      ...customFields,
    };

    for (const key of Object.keys(converted)) {
      const v = converted[key as keyof typeof converted];
      if (v == null || v === '') {
        delete converted[key as keyof typeof converted];
      }
    }

    return converted;
  }

  async scrapeIssue(urlOrId: string): Promise<{ raw: Record<string, unknown>; converted: Record<string, unknown> }> {
    const { user, pass } = this.requireBasicAuth();
    const issueUrl = this.normalizeIssueRef(urlOrId);
    const jsonUrl = issueUrl.endsWith('.json') ? issueUrl : `${issueUrl}.json?include=journals,attachments,relations,children`;
    const authHeader = Buffer.from(`${user}:${pass}`).toString('base64');

    try {
      logger.info({ issueUrl }, 'Scraping Codemagen issue (HTTP Basic)');

      const res = await this.client.get(jsonUrl, {
        headers: { Authorization: `Basic ${authHeader}` },
      });

      if (res.status >= 400) {
        throw new Error(`Codemagen API error ${res.status}`);
      }

      const rawData = res.data?.issue as Record<string, unknown> | undefined;

      if (!rawData) {
        throw new Error('Issue not found or empty response');
      }

      this.isAuthenticated = true;

      const converted = this.buildConvertedFromRaw(rawData);

      return {
        raw: rawData,
        converted,
      };
    } catch (error: unknown) {
      if (isAxiosError(error) && error.response?.status === 401) {
        const msg =
          'Codemagen API returned 401 Unauthorized — verify CODEMAGEN_USERNAME and CODEMAGEN_PASSWORD (HTTP Basic) match a user with API access.';
        logger.error({ err: msg, issueUrl }, 'Failed to scrape issue');
        throw new Error(msg);
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ err: msg, issueUrl }, 'Failed to scrape issue');
      throw error;
    }
  }
}

export const redmineScraper = new RedmineScraperService();
