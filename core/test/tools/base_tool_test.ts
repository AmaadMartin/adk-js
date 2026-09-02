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

/** A tool ADK ships that another orchestrator answers for. */
class DeferringTestTool extends TestTool {
  constructor() {
    super({name: 'deferring', description: 'answered by another orchestrator'});
    this.defersResponse = true;
  }
}

describe('BaseTool.defersResponse', () => {
  it('is false for a tool that does not set it', () => {
    const tool = new TestTool({name: 'plain', description: 'a plain tool'});

    expect(tool.defersResponse).toBe(false);
  });

  it('is true for a tool that sets it in its constructor', () => {
    expect(new DeferringTestTool().defersResponse).toBe(true);
  });

  it('is independent of isLongRunning', () => {
    expect(new DeferringTestTool().isLongRunning).toBe(false);
  });
});
