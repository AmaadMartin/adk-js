/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool, BaseToolParams} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** The smallest concrete tool, so the base constructor can be exercised. */
class TestTool extends BaseTool {
  constructor(params: BaseToolParams) {
    super(params);
  }

  override async runAsync(): Promise<unknown> {
    return 'done';
  }
}

describe('BaseTool.defersResponse', () => {
  it('is false when the tool does not ask to defer', () => {
    const tool = new TestTool({name: 'plain', description: 'a plain tool'});

    expect(tool.defersResponse).toBe(false);
  });

  it('is true when the tool asks to defer', () => {
    const tool = new TestTool({
      name: 'deferring',
      description: 'a tool answered by another orchestrator',
      defersResponse: true,
    });

    expect(tool.defersResponse).toBe(true);
  });

  it('is independent of isLongRunning', () => {
    const tool = new TestTool({
      name: 'deferring',
      description: 'a tool answered by another orchestrator',
      defersResponse: true,
    });

    expect(tool.isLongRunning).toBe(false);
  });
});
