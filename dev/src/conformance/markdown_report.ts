/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {version} from '../version.js';
import {
  ConformanceStatus,
  ConformanceTestResult,
  ConformanceTestSummary,
} from './conformance_types.js';

const STATUS_LABELS: Readonly<Record<ConformanceStatus, string>> = {
  [ConformanceStatus.PASSED]: 'PASS',
  [ConformanceStatus.FAILED]: 'FAIL',
  [ConformanceStatus.SKIPPED]: 'SKIP',
};

/**
 * Writes a Markdown report of a conformance run.
 *
 * @param reportDir Directory to write into, created when it does not exist.
 *     Defaults to the working directory.
 * @returns The absolute path of the file written.
 */
export async function generateMarkdownReport(
  summary: ConformanceTestSummary,
  reportDir?: string,
): Promise<string> {
  const reportName = `typescript_${version.split('.').join('_')}_report.md`;
  if (reportDir) {
    await fs.mkdir(reportDir, {recursive: true});
  }
  const reportPath = path.resolve(reportDir ?? process.cwd(), reportName);

  await fs.writeFile(reportPath, renderReport(summary), 'utf-8');
  return reportPath;
}

function renderReport(summary: ConformanceTestSummary): string {
  const mode = summary.streamingMode ?? 'none';
  const total = summary.results.length;
  const passed = countStatus(summary.results, ConformanceStatus.PASSED);
  const failed = countStatus(summary.results, ConformanceStatus.FAILED);
  const skipped = countStatus(summary.results, ConformanceStatus.SKIPPED);
  const successRate = total === 0 ? 0 : (passed / total) * 100;

  const lines = [
    '# ADK TypeScript Conformance Test Report',
    '',
    '## Summary',
    '',
    `- **ADK Version**: ${version}`,
    `- **Node**: ${process.version}`,
    '',
    '| Streaming Mode | Total Tests | Passed | Failed | Skipped | Success Rate |',
    '| :--- | :--- | :--- | :--- | :--- | :--- |',
    `| ${mode} | ${total} | ${passed} | ${failed} | ${skipped} | ${successRate.toFixed(1)}% |`,
    '',
    '## Test Results',
    '',
    `| Category | Test Name | Description | ${mode} |`,
    '| :--- | :--- | :--- | :--- |',
  ];

  for (const result of summary.results) {
    const description = result.description.replaceAll('\n', ' ');
    lines.push(
      `| ${result.category} | ${result.name} | ${description} | ${STATUS_LABELS[result.status]} |`,
    );
  }
  lines.push('');

  const failures = summary.results.filter(
    (result) => result.status === ConformanceStatus.FAILED,
  );
  if (failures.length > 0) {
    lines.push('## Failed Tests Details', '');
    for (const failure of failures) {
      lines.push(
        `### ${failure.name} (${mode})`,
        '',
        `**Description**: ${failure.description}`,
        '',
        '**Error**:',
        '```',
        `${failure.error}`,
        '```',
        '',
      );
    }
  }

  return lines.join('\n');
}

function countStatus(
  results: ConformanceTestResult[],
  status: ConformanceStatus,
): number {
  return results.filter((result) => result.status === status).length;
}
