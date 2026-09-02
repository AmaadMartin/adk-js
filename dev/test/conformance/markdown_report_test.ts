/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  ConformanceStatus,
  ConformanceTestSummary,
} from '../../src/conformance/conformance_types.js';
import {generateMarkdownReport} from '../../src/conformance/markdown_report.js';
import {version} from '../../src/version.js';

const REPORT_NAME = `typescript_${version.split('.').join('_')}_report.md`;

const SUMMARY: ConformanceTestSummary = {
  streamingMode: StreamingMode.SSE,
  results: [
    {
      category: 'core',
      name: 'core/case_001',
      description: 'A passing case',
      status: ConformanceStatus.PASSED,
    },
    {
      category: 'tool',
      name: 'tool/case_002',
      description: 'A failing case',
      status: ConformanceStatus.FAILED,
      error: 'events differ at index 1',
    },
    {
      category: 'tool',
      name: 'tool/case_003',
      description: 'A skipped case',
      status: ConformanceStatus.SKIPPED,
    },
  ],
};

describe('generateMarkdownReport', () => {
  let root: string;
  let previousCwd: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-report-'));
    previousCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(root, {recursive: true, force: true});
  });

  it('creates the report directory and names the file after the version', async () => {
    const reportDir = path.join(root, 'reports', 'nested');

    const reportPath = await generateMarkdownReport(SUMMARY, reportDir);

    expect(reportPath).toBe(path.join(reportDir, REPORT_NAME));
    await expect(fs.stat(reportPath)).resolves.toBeDefined();
  });

  it('writes into the working directory when no directory is given', async () => {
    process.chdir(root);

    const reportPath = await generateMarkdownReport(SUMMARY);

    expect(reportPath).toBe(path.join(await fs.realpath(root), REPORT_NAME));
    await expect(fs.stat(reportPath)).resolves.toBeDefined();
  });

  it('tabulates one row per case and details every failure', async () => {
    const reportPath = await generateMarkdownReport(SUMMARY, root);
    const report = await fs.readFile(reportPath, 'utf-8');

    expect(report).toContain(`- **ADK Version**: ${version}`);
    expect(report).toContain('| sse | 3 | 1 | 1 | 1 | 33.3% |');
    expect(report).toContain(
      '| core | core/case_001 | A passing case | PASS |',
    );
    expect(report).toContain(
      '| tool | tool/case_002 | A failing case | FAIL |',
    );
    expect(report).toContain(
      '| tool | tool/case_003 | A skipped case | SKIP |',
    );
    expect(report).toContain('## Failed Tests Details');
    expect(report).toContain('events differ at index 1');
  });

  it('labels an unselected streaming mode none and omits the failure section', async () => {
    const reportPath = await generateMarkdownReport(
      {results: [SUMMARY.results[0]]},
      root,
    );
    const report = await fs.readFile(reportPath, 'utf-8');

    expect(report).toContain('| none | 1 | 1 | 0 | 0 | 100.0% |');
    expect(report).not.toContain('## Failed Tests Details');
  });

  it('reports a zero success rate for a run with no cases', async () => {
    const reportPath = await generateMarkdownReport({results: []}, root);

    expect(await fs.readFile(reportPath, 'utf-8')).toContain(
      '| none | 0 | 0 | 0 | 0 | 0.0% |',
    );
  });

  it('keeps a multi-line description on one table row', async () => {
    const reportPath = await generateMarkdownReport(
      {
        results: [
          {
            category: 'core',
            name: 'core/case_004',
            description: 'first line\nsecond line',
            status: ConformanceStatus.PASSED,
          },
        ],
      },
      root,
    );

    expect(await fs.readFile(reportPath, 'utf-8')).toContain(
      '| core | core/case_004 | first line second line | PASS |',
    );
  });
});
