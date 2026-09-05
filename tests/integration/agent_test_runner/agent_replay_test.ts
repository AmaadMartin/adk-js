/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives the fixture replay harness the way adk-python's `test_samples.py`
 * does: discover every fixture below this directory, then replay each one.
 * Offline — the recording answers every model call.
 */

import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeAll, describe, expect, it} from 'vitest';

import {
  getTestFiles,
  runAgentReplay,
} from '../../../dev/src/cli/agent_test_runner.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const testCases = getTestFiles(thisDir);

beforeAll(() => {
  // The agent names a Gemini model, and the Gemini constructor rejects a
  // missing key before the replay can answer anything. Nothing is sent: the
  // recording answers every model call.
  process.env['GEMINI_API_KEY'] ??= 'placeholder-the-replay-never-calls-out';
});

describe('agent fixture replay', () => {
  it('discovers the committed fixture', () => {
    expect(testCases.map((testCase) => testCase.id)).toEqual([
      'agent_test_runner/basic.json',
    ]);
  });

  for (const testCase of testCases) {
    const run = testCase.xfail ? it.fails : it;
    run(`replays ${testCase.id}`, async (ctx) => {
      const result = await runAgentReplay(testCase.agentDir, testCase.testFile);
      if (result.status === 'skipped') {
        ctx.skip();
        return;
      }
      expect(result.actual).toEqual(result.expected);
    });
  }
});
