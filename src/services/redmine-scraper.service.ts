import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger';
import { resolveUserAlias } from '../utils/user-mapping';

export class RedmineScraperService {
  private client: any;
  private jar: CookieJar;
  private baseUrl: string;
  private isAuthenticated: boolean = false;

  constructor(baseUrl: string = 'https://pms.codemagen.net') {
    this.baseUrl = baseUrl;
    this.jar = new CookieJar();
    this.client = wrapper(axios.create({
      baseURL: this.baseUrl,
      jar: this.jar,
      withCredentials: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8',
      }
    }));
  }

  async login(username?: string, password?: string): Promise<boolean> {
    const user = username || process.env.REDMINE_USERNAME || 'sarves@codemagen.com';
    const pass = password || process.env.REDMINE_PASSWORD || 'codemagen@123';

    try {
      logger.info({ user }, 'Attempting Redmine login');
      
      const loginPage = await this.client.get('/login');
      const $ = cheerio.load(loginPage.data);
      const csrfToken = $('input[name="authenticity_token"]').val() as string;

      if (!csrfToken) {
        throw new Error('Could not find CSRF token on login page');
      }

      const data = new URLSearchParams();
      data.append('utf8', '✓');
      data.append('authenticity_token', csrfToken);
      data.append('username', user);
      data.append('password', pass);
      data.append('autologin', '1');
      data.append('login', 'Login');
      data.append('back_url', `${this.baseUrl}/`);

      const loginRes = await this.client.post('/login', data.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `${this.baseUrl}/login`,
        },
        maxRedirects: 5,
      });

      const $loggedIn = cheerio.load(loginRes.data);
      const loggedInUser = $loggedIn('#loggedas').text().trim();
      const flashError = $loggedIn('#flash_error').text().trim();

      if (flashError) {
        logger.error({ flashError }, 'Redmine login failed');
        return false;
      }

      this.isAuthenticated = true;
      logger.info('Redmine login successful');
      return true;
    } catch (error: any) {
      logger.error({ err: error.message }, 'Failed to login to Redmine');
      return false;
    }
  }

  async scrapeIssue(urlOrId: string): Promise<any> {
    const user = process.env.REDMINE_USERNAME || 'sarves@codemagen.com';
    const pass = process.env.REDMINE_PASSWORD || 'codemagen@123';

    const issueUrl = urlOrId.startsWith('http') ? urlOrId : `/issues/${urlOrId}`;
    const jsonUrl = issueUrl.endsWith('.json') ? issueUrl : `${issueUrl}.json?include=journals,attachments,relations,children`;
    
    try {
      logger.info({ issueUrl }, 'Scraping issue');
      
      // Try to fetch JSON directly using Basic Auth
      const auth = Buffer.from(`${user}:${pass}`).toString('base64');
      const res = await this.client.get(jsonUrl, {
        headers: {
          'Authorization': `Basic ${auth}`
        }
      });
      const rawData = res.data.issue;

      if (!rawData) {
        throw new Error('Issue not found or unauthorized');
      }

      // If we got here, we are successfully authenticated via API
      this.isAuthenticated = true;

      // Convert custom fields array to key-value map
      const customFields: Record<string, string> = {};
      if (rawData.custom_fields) {
        for (const cf of rawData.custom_fields) {
          customFields[cf.name] = cf.value;
        }
      }

      // Create a unified converted object
      const converted = {
        title: rawData.subject,
        parentTask: rawData.parent ? `Issue #${rawData.parent.id}` : '',
        Status: rawData.status?.name,
        Priority: rawData.priority?.name,
        Assignee: rawData.assigned_to?.name ? resolveUserAlias(rawData.assigned_to.name) : '',
        Author: rawData.author?.name,
        Tracker: rawData.tracker?.name,
        'Target Version (Sprint)': rawData.fixed_version?.name,
        'Start Date': rawData.start_date,
        'Due Date': rawData.due_date,
        '% Done': rawData.done_ratio !== undefined ? `${rawData.done_ratio}%` : '',
        'Estimated Time': rawData.estimated_hours !== undefined ? `${rawData.estimated_hours} h` : '',
        description: rawData.description,
        scrapedAt: new Date().toISOString(),
        ...customFields
      };

      // Clean up empty fields
      for (const key of Object.keys(converted)) {
        if (converted[key as keyof typeof converted] == null || converted[key as keyof typeof converted] === '') {
          delete converted[key as keyof typeof converted];
        }
      }

      return {
        raw: rawData,
        converted
      };

    } catch (error: any) {
      logger.error({ err: error.message, issueUrl }, 'Failed to scrape issue');
      throw error;
    }
  }
}

export const redmineScraper = new RedmineScraperService();
