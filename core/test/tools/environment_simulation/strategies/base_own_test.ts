/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  BaseMockStrategy,
  TracingMockStrategy,
} from '../../../../src/tools/environment_simulation/strategies/base.js';

import {FakeTool, createToolContext} from '../simulation_test_support.js';

describe('TracingMockStrategy', () => {
  it('is a mock strategy', () => {
    expect(new TracingMockStrategy()).toBeInstanceOf(BaseMockStrategy);
  });

  it('answers with the not-implemented stub adk-python ships', async () => {
    const result = await new TracingMockStrategy().mock({
      tool: new FakeTool({name: 'create_ticket'}),
      args: {},
      toolContext: createToolContext(),
      stateStore: {},
    });

    expect(result).toEqual({
      status: 'error',
      error_message: 'Not implemented',
    });
  });
});
