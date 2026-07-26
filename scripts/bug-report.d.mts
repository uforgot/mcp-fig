export interface BugReportOptions {
  trace?: string;
  errorCode?: string;
  log?: string;
  outputDir?: string;
  date?: string;
}

export function generateBugReport(options: BugReportOptions): Promise<string>;
