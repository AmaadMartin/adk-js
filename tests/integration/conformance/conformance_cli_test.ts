/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createProgram} from '../../../dev/src/cli/cli.js';
import {
  ConformanceWorkspace,
  SINGLE_TURN_SPEC,
  scriptedResponses,
  textResponse,
} from '../../../dev/test/conformance/conformance_workspace.js';

const CASE_NAME = 'core/case_001';

/** Runs the ADK CLI the way `adk` does, on a fresh program. */
function runCli(args: string[]): Promise<unknown> {
  return createProgram().parseAsync(args, {from: 'user'});
}

describe('adk conformance', () => {
  let workspace: ConformanceWorkspace;
  let caseDir: string;
  let previousExitCode: number | string | undefined;

  beforeEach(async () => {
    previousExitCode = process.exitCode;
    scriptedResponses.length = 0;
    workspace = await ConformanceWorkspace.create();
    await workspace.writeAgent();
    caseDir = await workspace.writeTestCase(CASE_NAME, SINGLE_TURN_SPEC);
  });

  afterEach(async () => {
    process.exitCode = previousExitCode;
    await workspace.remove();
  });

  it('records a case and then replays it, writing a report', async () => {
    scriptedResponses.push(textResponse('hi there'));

    await runCli([
      'conformance',
      'record',
      workspace.testsDir,
      'none',
      '--agents_dir',
      workspace.agentsDir,
    ]);

    expect(await fs.readdir(caseDir)).toEqual(
      expect.arrayContaining([
        'generated-recordings.yaml',
        'generated-session.yaml',
        'spec.yaml',
      ]),
    );

    const reportDir = path.join(workspace.root, 'reports');
    process.exitCode = 0;
    await runCli([
      'conformance',
      'test',
      workspace.testsDir,
      '--agents_dir',
      workspace.agentsDir,
      '--generate_report',
      '--report_dir',
      reportDir,
    ]);

    expect(process.exitCode).toBe(0);
    const report = await fs.readFile(
      path.join(reportDir, (await fs.readdir(reportDir))[0]),
      'utf-8',
    );
    expect(report).toContain(`| core | ${CASE_NAME} |`);
    expect(report).toContain('PASS');
  });

  it('exits non-zero when a recorded case no longer matches', async () => {
    scriptedResponses.push(textResponse('hi there'));
    await runCli([
      'conformance',
      'record',
      workspace.testsDir,
      'none',
      '--agents_dir',
      workspace.agentsDir,
    ]);

    const sessionFile = path.join(caseDir, 'generated-session.yaml');
    const recorded = await fs.readFile(sessionFile, 'utf-8');
    await fs.writeFile(sessionFile, recorded.replace('hi there', 'goodbye'));

    process.exitCode = 0;
    await runCli([
      'conformance',
      'test',
      workspace.testsDir,
      '--agents_dir',
      workspace.agentsDir,
    ]);

    expect(process.exitCode).toBe(1);
  });
});
