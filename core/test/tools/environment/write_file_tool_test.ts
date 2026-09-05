/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `tests/unittests/telemetry/test_spans.py` on adk-python `main`
 * (`test_detect_error_environment_tools`).
 *
 * That Python test parametrises three responses over four environment tools.
 * Only the three `WriteFileTool` cases are ported: `ExecuteTool`,
 * `ReadFileTool` and `EditFileTool` do not exist in adk-js yet.
 */

import {LocalEnvironment, WriteFileTool} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('WriteFileTool telemetry hook', () => {
  const tool = new WriteFileTool(new LocalEnvironment());

  it('test_detect_error_environment_tools[WriteFileTool-status_error]', () => {
    expect(tool.detectErrorInResponse({status: 'error', error: 'fail'})).toBe(
      'TOOL_ERROR',
    );
  });

  it('test_detect_error_environment_tools[WriteFileTool-status_ok]', () => {
    expect(
      tool.detectErrorInResponse({status: 'ok', message: 'done'}),
    ).toBeUndefined();
  });

  it('test_detect_error_environment_tools[WriteFileTool-error_key_only]', () => {
    // Environment tools check `status`, not the `error` key.
    expect(tool.detectErrorInResponse({error: 'something'})).toBeUndefined();
  });
});
