/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool} from '@google/adk';
import {describe, expect, it} from 'vitest';

class PlainTool extends BaseTool {
  override async runAsync(): Promise<unknown> {
    return {result: 'ok'};
  }
}

describe('BaseTool.customMetadata', () => {
  it('is undefined when the constructor params omit it', () => {
    const tool = new PlainTool({name: 'plain_tool', description: 'A tool.'});

    expect(tool.customMetadata).toBeUndefined();
  });

  it('is the metadata passed through BaseToolParams', () => {
    const tool = new PlainTool({
      name: 'plain_tool',
      description: 'A tool.',
      customMetadata: {'my.vendor.key': 'v', nested: {a: 1}},
    });

    expect(tool.customMetadata).toEqual({
      'my.vendor.key': 'v',
      nested: {a: 1},
    });
  });

  it('can be assigned after construction', () => {
    const tool = new PlainTool({name: 'plain_tool', description: 'A tool.'});

    tool.customMetadata = {'my.vendor.key': 'v'};

    expect(tool.customMetadata).toEqual({'my.vendor.key': 'v'});
  });

  it('keeps existing keys when a key is added after construction', () => {
    const tool = new PlainTool({
      name: 'plain_tool',
      description: 'A tool.',
      customMetadata: {'my.vendor.key': 'v'},
    });

    tool.customMetadata = {...tool.customMetadata, 'my.vendor.id': 'abc-123'};

    expect(tool.customMetadata).toEqual({
      'my.vendor.key': 'v',
      'my.vendor.id': 'abc-123',
    });
  });

  it('leaves isLongRunning at its default when only metadata is supplied', () => {
    const tool = new PlainTool({
      name: 'plain_tool',
      description: 'A tool.',
      customMetadata: {'my.vendor.key': 'v'},
    });

    expect(tool.isLongRunning).toBe(false);
    expect(tool.name).toBe('plain_tool');
    expect(tool.description).toBe('A tool.');
  });
});
