/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests ported from adk-python `main`:
 * - `tests/unittests/tools/test_environment_toolset.py`
 *   (`test_default_truncation_limit`, `test_custom_truncation_limit`,
 *   `test_no_truncation_under_limit`)
 * - `tests/unittests/telemetry/test_spans.py`
 *   (`test_detect_error_environment_tools`, the `ExecuteTool` cases)
 *
 * Each `it()` name is the Python test name verbatim.
 *
 * Adaptations. The Python tests build the tool through
 * `EnvironmentToolset(environment=env, max_output_chars=...)` and pick
 * `Execute` out of `get_tools()`; that toolset is not ported yet, so these
 * construct `new ExecuteTool(env, {maxOutputChars})` directly. The `ReadFile`
 * half of each truncation test is dropped, because `ReadFileTool` does not
 * exist in adk-js. Python asserts the output length and its suffix; asserting
 * the whole response object pins both, and also pins which keys are absent.
 * The Python tests pass a bare mock tool context, but adk-js gates execution
 * on a confirmation, so these use an already-confirmed context.
 */

import {ExecuteTool} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  RecordingEnvironment,
  makeConfirmedContext,
} from './environment_test_utils.js';

const TRUNCATION_NOTICE = '\n... (truncated, 40000 total chars)';

describe('ExecuteTool truncation (ported from adk-python)', () => {
  it('test_default_truncation_limit', async () => {
    const environment = new RecordingEnvironment({stdout: 'a'.repeat(40_000)});
    const tool = new ExecuteTool(environment);

    const result = await tool.runAsync({
      args: {command: 'dummy'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({
      status: 'ok',
      stdout: 'a'.repeat(30_000) + TRUNCATION_NOTICE,
    });
  });

  it('test_custom_truncation_limit', async () => {
    const environment = new RecordingEnvironment({stdout: 'a'.repeat(40_000)});
    const tool = new ExecuteTool(environment, {maxOutputChars: 10_000});

    const result = await tool.runAsync({
      args: {command: 'dummy'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({
      status: 'ok',
      stdout: 'a'.repeat(10_000) + TRUNCATION_NOTICE,
    });
  });

  it('test_no_truncation_under_limit', async () => {
    const shortText = 'a'.repeat(100);
    const environment = new RecordingEnvironment({stdout: shortText});
    const tool = new ExecuteTool(environment, {maxOutputChars: 10_000});

    const result = await tool.runAsync({
      args: {command: 'dummy'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({status: 'ok', stdout: shortText});
  });
});

describe('ExecuteTool telemetry (ported from adk-python)', () => {
  it('test_detect_error_environment_tools[status_error]', () => {
    const tool = new ExecuteTool(new RecordingEnvironment());

    expect(tool.detectErrorInResponse({status: 'error', error: 'fail'})).toBe(
      'TOOL_ERROR',
    );
  });

  it('test_detect_error_environment_tools[status_ok]', () => {
    const tool = new ExecuteTool(new RecordingEnvironment());

    expect(
      tool.detectErrorInResponse({status: 'ok', message: 'done'}),
    ).toBeUndefined();
  });

  it('test_detect_error_environment_tools[error_key_only]', () => {
    const tool = new ExecuteTool(new RecordingEnvironment());

    expect(tool.detectErrorInResponse({error: 'something'})).toBeUndefined();
  });
});
