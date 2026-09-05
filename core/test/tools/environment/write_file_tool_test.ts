/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`,
 * `tests/unittests/telemetry/test_spans.py`, function
 * `test_detect_error_environment_tools`. The Python test is parametrized over
 * the four environment tool classes and three responses; the `WriteFileTool`
 * cases are kept here, with the Python test name and parameter ids verbatim so
 * the two suites can be compared by name.
 *
 * adk-python has no `tests/unittests/tools/environment/test_write_file_tool.py`,
 * so these three cases are the whole reference suite for this module.
 */

import {LocalEnvironment, WriteFileTool} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('test_detect_error_environment_tools', () => {
  const tool = new WriteFileTool(new LocalEnvironment());

  it('WriteFileTool-status_error', () => {
    expect(tool.detectErrorInResponse({status: 'error', error: 'fail'})).toBe(
      'TOOL_ERROR',
    );
  });

  it('WriteFileTool-status_ok', () => {
    expect(
      tool.detectErrorInResponse({status: 'ok', message: 'done'}),
    ).toBeUndefined();
  });

  it('WriteFileTool-error_key_only', () => {
    expect(tool.detectErrorInResponse({error: 'something'})).toBeUndefined();
  });
});
