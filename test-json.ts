import 'dotenv/config';
import { redmineScraper } from './src/services/redmine-scraper.service';

/** Smoke test: set CODEMAGEN_USERNAME / CODEMAGEN_PASSWORD then run `pnpm exec tsx test-json.ts [issueUrlOrId]` */
async function testJson() {
  const ref = process.argv[2] || '1';
  try {
    const data = await redmineScraper.scrapeIssue(ref);
    console.log('OK', { subject: data.raw?.subject ?? (data.raw as { subject?: string }).subject, keys: Object.keys(data.converted) });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

testJson();
