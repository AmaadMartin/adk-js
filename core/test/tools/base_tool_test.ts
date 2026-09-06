/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool, isBaseTool} from '@google/adk';
import {describe, expect, it} from 'vitest';

class DummyTool extends BaseTool {
  constructor() {
    super({name: 'dummy_tool', description: 'Dummy tool'});
  }

  async runAsync(): Promise<unknown> {
    return 'dummy';
  }
}

describe('isBaseTool', () => {
  it('accepts a tool instance', () => {
    expect(isBaseTool(new DummyTool())).toBe(true);
  });

  it('accepts a tool built by another copy of the package', () => {
    const foreign = {
      [Symbol.for('google.adk.baseTool')]: true,
      name: 'foreign_tool',
      description: 'Built elsewhere',
    };

    expect(isBaseTool(foreign)).toBe(true);
  });

  it('rejects a plain object and a nullish value', () => {
    expect(isBaseTool({name: 'not_a_tool'})).toBe(false);
    expect(isBaseTool(null)).toBe(false);
    expect(isBaseTool(undefined)).toBe(false);
  });

  it('rejects an object whose signature is not true', () => {
    expect(isBaseTool({[Symbol.for('google.adk.baseTool')]: 1})).toBe(false);
  });
});
