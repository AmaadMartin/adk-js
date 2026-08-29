/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  FunctionTool,
  RunAsyncToolRequest,
  isErrorDetectingTool,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A tool that does not classify its own responses. */
class PlainTool extends BaseTool {
  constructor() {
    super({name: 'plain', description: 'Does one thing.'});
  }

  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    return req.args;
  }
}

describe('isErrorDetectingTool', () => {
  it('accepts a tool that declares the hook', () => {
    const tool = new FunctionTool({
      name: 'echo',
      description: 'Echoes.',
      execute: () => 'ok',
    });

    expect(isErrorDetectingTool(tool)).toBe(true);
  });

  it('rejects a tool that does not declare the hook', () => {
    expect(isErrorDetectingTool(new PlainTool())).toBe(false);
  });
});
