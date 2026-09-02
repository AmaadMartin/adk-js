/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runConformanceRecord} from '../../src/conformance/cli_record.js';
import {runConformanceTest} from '../../src/conformance/cli_test.js';
import {
  ConformanceMode,
  ConformanceStatus,
} from '../../src/conformance/conformance_types.js';
import {
  ConformanceWorkspace,
  SINGLE_TURN_SPEC,
  scriptedResponses,
  textResponse,
} from './conformance_workspace.js';

const CASE_NAME = 'core/case_001';
/** A name `TestRunner` skips because the feature it covers is missing. */
const SKIPPED_CASE_NAME = 'tool/example_tool_001';

describe('runConformanceTest', () => {
  let workspace: ConformanceWorkspace;

  /** Records `caseName` so a later replay has fixtures to compare against. */
  async function recordCase(caseName: string, responseText: string) {
    const caseDir = await workspace.writeTestCase(caseName, SINGLE_TURN_SPEC);
    scriptedResponses.push(textResponse(responseText));
    await runConformanceRecord({
      testPaths: [workspace.testsDir],
      streamingMode: StreamingMode.NONE,
      agentsDir: workspace.agentsDir,
    });
    return caseDir;
  }

  function replay(
    overrides: {generateReport?: boolean; reportDir?: string} = {},
  ) {
    return runConformanceTest({
      testPaths: [workspace.testsDir],
      agentsDir: workspace.agentsDir,
      mode: ConformanceMode.REPLAY,
      generateReport: false,
      force: false,
      ...overrides,
    });
  }

  beforeEach(async () => {
    scriptedResponses.length = 0;
    workspace = await ConformanceWorkspace.create();
    await workspace.writeAgent();
  });

  afterEach(async () => {
    await workspace.remove();
  });

  it('passes a case recorded by adk conformance record', async () => {
    await recordCase(CASE_NAME, 'hi there');

    const summary = await replay();

    expect(summary.results).toEqual([
      {
        category: 'core',
        name: CASE_NAME,
        description: 'One turn against the stub model',
        status: ConformanceStatus.PASSED,
      },
    ]);
  });

  it('fails a case whose recorded session no longer matches', async () => {
    const caseDir = await recordCase(CASE_NAME, 'hi there');
    const sessionFile = path.join(caseDir, 'generated-session.yaml');
    const recorded = await fs.readFile(sessionFile, 'utf-8');
    await fs.writeFile(sessionFile, recorded.replace('hi there', 'goodbye'));

    const summary = await replay();

    expect(summary.results[0].status).toBe(ConformanceStatus.FAILED);
    expect(summary.results[0].error).toBeTruthy();
  });

  it('skips a case that was never recorded', async () => {
    await workspace.writeTestCase(CASE_NAME, SINGLE_TURN_SPEC);

    const summary = await replay();

    expect(summary.results[0].status).toBe(ConformanceStatus.SKIPPED);
    expect(summary.results[0].error).toBeUndefined();
  });

  it('skips a case the runner declines to run', async () => {
    await recordCase(SKIPPED_CASE_NAME, 'hi there');

    const summary = await replay();

    expect(summary.results[0]).toMatchObject({
      name: SKIPPED_CASE_NAME,
      status: ConformanceStatus.SKIPPED,
    });
  });

  it('reports results ordered by test case name', async () => {
    await recordCase('core/case_002', 'second');
    await recordCase('core/case_001', 'first');

    const summary = await replay();

    expect(summary.results.map((result) => result.name)).toEqual([
      'core/case_001',
      'core/case_002',
    ]);
  });

  it('records the streaming mode the caller selected', async () => {
    const summary = await runConformanceTest({
      testPaths: [workspace.testsDir],
      agentsDir: workspace.agentsDir,
      mode: ConformanceMode.REPLAY,
      generateReport: false,
      force: false,
      streamingMode: StreamingMode.SSE,
    });

    expect(summary.streamingMode).toBe(StreamingMode.SSE);
  });

  it('writes no report unless one is asked for', async () => {
    await recordCase(CASE_NAME, 'hi there');
    const reportDir = path.join(workspace.root, 'reports');

    await replay({reportDir});

    await expect(fs.readdir(reportDir)).rejects.toThrow();
  });

  it('writes the report when one is asked for', async () => {
    await recordCase(CASE_NAME, 'hi there');
    const reportDir = path.join(workspace.root, 'reports');

    await replay({generateReport: true, reportDir});

    expect(await fs.readdir(reportDir)).toHaveLength(1);
  });

  it('rejects live mode before it loads anything', async () => {
    await expect(
      runConformanceTest({
        testPaths: [workspace.testsDir],
        agentsDir: workspace.agentsDir,
        mode: ConformanceMode.LIVE,
        generateReport: false,
        force: false,
      }),
    ).rejects.toThrow('Live mode is not implemented yet.');
  });
});
