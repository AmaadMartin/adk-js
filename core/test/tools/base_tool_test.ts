/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool, FunctionTool, RunAsyncToolRequest} from '@google/adk';
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

describe('BaseTool.detectErrorInResponse', () => {
  it('is implemented by a tool that classifies its own responses', () => {
    const tool = new FunctionTool({
      name: 'echo',
      description: 'Echoes.',
      execute: () => 'ok',
    });

    expect(typeof tool.detectErrorInResponse).toBe('function');
  });

  it('is absent on a tool that does not declare it', () => {
    expect(new PlainTool().detectErrorInResponse).toBeUndefined();
  });
});
