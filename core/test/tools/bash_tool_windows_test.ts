/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, ExecuteBashTool, ToolConfirmation} from '@google/adk';
import * as os from 'os';
import {afterEach, describe, expect, it, vi} from 'vitest';

// Mock the `os` module so `platform()` is controllable per-test. We spread the
// real module so every other `os` export (e.g. tmpdir) keeps working, and
// default `platform` to the real implementation.
vi.mock('os', async (importActual) => {
  const actual = await importActual<typeof import('os')>();
  return {...actual, platform: vi.fn(actual.platform)};
});

describe('ExecuteBashTool platform guard', () => {
  afterEach(() => {
    vi.mocked(os.platform).mockReset();
  });

  it('returns an unsupported-platform error on win32 before spawning', async () => {
    vi.mocked(os.platform).mockReturnValue('win32');

    const tool = new ExecuteBashTool({workspace: '/tmp'});
    // The win32 guard is reached only after the confirmation checks pass, so a
    // confirmed toolConfirmation is the only context field runAsync reads here.
    const toolContext = {
      toolConfirmation: {confirmed: true} as ToolConfirmation,
    } as unknown as Context;

    const result = await tool.runAsync({
      args: {command: 'echo hello'},
      toolContext,
    });

    // Exact-match assertion: proves the early return AND that no subprocess
    // ran (a spawn path would add stdout/stderr/returncode keys).
    expect(result).toEqual({
      error: 'ExecuteBashTool is only supported on POSIX systems.',
    });
  });
});
