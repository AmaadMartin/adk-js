/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TracingMockStrategy} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {createToolContext, declaredTool} from './mock_strategy_test_utils.js';

describe('TracingMockStrategy', () => {
  it('reports that tracing-based mocking is not implemented', async () => {
    const strategy = new TracingMockStrategy();

    const result = await strategy.mock({
      tool: declaredTool('create_ticket'),
      args: {},
      toolContext: createToolContext(),
      stateStore: {},
    });

    expect(result).toEqual({status: 'error', error_message: 'Not implemented'});
  });
});
