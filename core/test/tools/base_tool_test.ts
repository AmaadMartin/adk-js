/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool, RunAsyncToolRequest} from '@google/adk';
import {describe, expect, it} from 'vitest';

class TestTool extends BaseTool {
  override async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    return {result: 'ok'};
  }
}

describe('BaseTool.defersResponse', () => {
  it('defaults to false', () => {
    const tool = new TestTool({name: 'a', description: 'd'});

    expect(tool.defersResponse).toBe(false);
  });

  it('can be set to true after construction', () => {
    const tool = new TestTool({name: 'a', description: 'd'});

    tool.defersResponse = true;

    expect(tool.defersResponse).toBe(true);
  });

  it('is per instance, not shared by the class', () => {
    const deferring = new TestTool({name: 'a', description: 'd'});
    const other = new TestTool({name: 'b', description: 'd'});

    deferring.defersResponse = true;

    expect(other.defersResponse).toBe(false);
  });
});
