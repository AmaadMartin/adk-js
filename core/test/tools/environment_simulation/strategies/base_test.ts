/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MockStrategy, SequentialAgent, createMockStrategy} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  StubTool,
  createToolContext,
  stubRegistry,
  stubRegistryWithText,
} from '../environment_simulation_test_utils.js';

const TOOL = new StubTool('create_ticket', {
  name: 'create_ticket',
  description: 'Creates a ticket.',
});

const NOT_IMPLEMENTED = {status: 'error', error_message: 'Not implemented'};

function mockRequest() {
  return {
    tool: TOOL,
    args: {},
    toolContext: createToolContext(new SequentialAgent({name: 'root'})),
    stateStore: {},
  };
}

describe('createMockStrategy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a strategy that mocks from the tool spec for MOCK_STRATEGY_TOOL_SPEC', async () => {
    const llm = stubRegistryWithText(['{"ticket_id": "T-1"}']);

    const strategy = createMockStrategy(
      MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
      'test-model',
      {},
    );

    await expect(strategy.mock(mockRequest())).resolves.toEqual({
      ticket_id: 'T-1',
    });
    expect(llm.requests).toHaveLength(1);
  });

  it('returns the not-implemented placeholder for MOCK_STRATEGY_TRACING', async () => {
    const llm = stubRegistry([]);

    const strategy = createMockStrategy(
      MockStrategy.MOCK_STRATEGY_TRACING,
      'test-model',
      {},
    );

    await expect(strategy.mock(mockRequest())).resolves.toEqual(
      NOT_IMPLEMENTED,
    );
    expect(llm.requests).toEqual([]);
  });

  it('throws for MOCK_STRATEGY_UNSPECIFIED', () => {
    expect(() =>
      createMockStrategy(MockStrategy.MOCK_STRATEGY_UNSPECIFIED, 'm', {}),
    ).toThrow('Unknown mock strategy type: MOCK_STRATEGY_UNSPECIFIED');
  });
});

describe('TracingMockStrategy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores the request it is given', async () => {
    const llm = stubRegistry([]);
    const strategy = createMockStrategy(
      MockStrategy.MOCK_STRATEGY_TRACING,
      'test-model',
      {},
    );

    const response = await strategy.mock({
      ...mockRequest(),
      args: {ticket_id: 'T-1'},
      environmentData: '{"tickets": []}',
      tracing: '{"events": []}',
    });

    expect(response).toEqual(NOT_IMPLEMENTED);
    expect(llm.requests).toEqual([]);
  });
});
