import { renderEmailLayout, type EmailTemplateResult } from './core';

type OwnerAnalyticsEmailArgs = {
  firstName: string;
  subject: string;
  windowLabel: string;
  summaryLines: string[];
  contributorLines: string[];
  projectLines: string[];
  followUpLines: string[];
  actionHref: string;
};

export function buildOwnerAnalyticsReportEmail(args: OwnerAnalyticsEmailArgs): EmailTemplateResult {
  const sections: Array<{ title: string; lines: string[] }> = [];

  if (args.summaryLines.length > 0) {
    sections.push({ title: 'Executive summary', lines: args.summaryLines });
  }
  if (args.contributorLines.length > 0) {
    sections.push({ title: 'Top contributors', lines: args.contributorLines });
  }
  if (args.projectLines.length > 0) {
    sections.push({ title: 'Project rollup', lines: args.projectLines });
  }
  if (args.followUpLines.length > 0) {
    sections.push({ title: 'Follow-ups', lines: args.followUpLines });
  }

  const rendered = renderEmailLayout({
    preheader: `Owner analytics for ${args.windowLabel}`,
    eyebrow: 'Owner analytics',
    title: 'Cross-project activity report',
    greeting: `Hello ${args.firstName},`,
    intro: [
      `Here is the owner analytics summary for ${args.windowLabel}.`,
      'The report blends mapped GitHub activity, ticket completions, and open project risks.',
    ],
    sections,
    action: {
      label: 'Open analytics',
      href: args.actionHref,
    },
    note:
      'Missing mappings reduce attribution accuracy. Review GitHub mapping suggestions in project and admin user screens when contributors appear as unmapped.',
  });

  return {
    templateKey: 'owner-analytics-report',
    subject: args.subject,
    html: rendered.html,
    text: rendered.text,
  };
}
