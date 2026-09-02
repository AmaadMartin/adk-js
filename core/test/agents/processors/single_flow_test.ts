/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  BaseContextCompactor,
  CONTENT_REQUEST_PROCESSOR,
  ContextCompactorRequestProcessor,
  INTERACTIONS_REQUEST_PROCESSOR,
  InvocationContext,
  LlmRequest,
  PluginManager,
  SingleFlow,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {AGENT_TRANSFER_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/agent_transfer_llm_request_processor.js';
import {BASIC_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/basic_llm_request_processor.js';
import {
  CODE_EXECUTION_REQUEST_PROCESSOR,
  responseProcessor as CODE_EXECUTION_RESPONSE_PROCESSOR,
} from '../../../src/agents/processors/code_execution_request_processor.js';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/identity_llm_request_processor.js';
import {INSTRUCTIONS_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/instructions_llm_request_processor.js';
import {
  NL_PLANNING_REQUEST_PROCESSOR,
  NL_PLANNING_RESPONSE_PROCESSOR,
} from '../../../src/agents/processors/nl_planning_processor.js';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_confirmation_llm_request_processor.js';
import {REQUEST_INPUT_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_input_llm_request_processor.js';
import {TOOL_FILTER_REQUEST_PROCESSOR} from '../../../src/agents/processors/tool_filter_request_processor.js';

const STUB_COMPACTOR: BaseContextCompactor = {
  shouldCompact: () => false,
  compact: () => {},
};

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'single-flow-test',
    session: createSession({id: 'session', appName: 'app', userId: 'user'}),
    pluginManager: new PluginManager(),
  });
}

function makeLlmRequest(): LlmRequest {
  return {contents: [], liveConnectConfig: {}, toolsDict: {}};
}

describe('SingleFlow request processors', () => {
  it('composes the request processors in the documented order', () => {
    expect(new SingleFlow().requestProcessors).toEqual([
      BASIC_LLM_REQUEST_PROCESSOR,
      AUTH_PREPROCESSOR,
      IDENTITY_LLM_REQUEST_PROCESSOR,
      INSTRUCTIONS_LLM_REQUEST_PROCESSOR,
      REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR,
      REQUEST_INPUT_LLM_REQUEST_PROCESSOR,
      INTERACTIONS_REQUEST_PROCESSOR,
      CONTENT_REQUEST_PROCESSOR,
      NL_PLANNING_REQUEST_PROCESSOR,
      CODE_EXECUTION_REQUEST_PROCESSOR,
      TOOL_FILTER_REQUEST_PROCESSOR,
    ]);
  });

  it('runs the interactions processor before the contents processor', () => {
    const {requestProcessors} = new SingleFlow();

    expect(
      requestProcessors.indexOf(INTERACTIONS_REQUEST_PROCESSOR),
    ).toBeLessThan(requestProcessors.indexOf(CONTENT_REQUEST_PROCESSOR));
  });

  it('places the compaction processor immediately before the contents processor', () => {
    const {requestProcessors} = new SingleFlow([STUB_COMPACTOR]);

    const compactionIndex = requestProcessors.findIndex(
      (processor) => processor instanceof ContextCompactorRequestProcessor,
    );
    expect(compactionIndex).toBeGreaterThanOrEqual(0);
    expect(requestProcessors.indexOf(CONTENT_REQUEST_PROCESSOR)).toBe(
      compactionIndex + 1,
    );
  });

  it('inserts one compaction processor and keeps the rest of the order', () => {
    const plain = new SingleFlow().requestProcessors;
    const compacting = new SingleFlow([STUB_COMPACTOR]).requestProcessors;
    const contentIndex = plain.indexOf(CONTENT_REQUEST_PROCESSOR);
    const inserted = compacting[contentIndex];

    expect(plain).not.toContain(inserted);
    expect(compacting).toEqual([
      ...plain.slice(0, contentIndex),
      inserted,
      ...plain.slice(contentIndex),
    ]);
  });

  it('evaluates the supplied compactors through the inserted processor', async () => {
    let asked = false;
    const compacting = new SingleFlow([
      {
        shouldCompact: () => {
          asked = true;
          return false;
        },
        compact: () => {},
      },
    ]).requestProcessors;
    const inserted =
      compacting[compacting.indexOf(CONTENT_REQUEST_PROCESSOR) - 1];

    for await (const _event of inserted.runAsync(
      makeInvocationContext(),
      makeLlmRequest(),
    )) {
      expect.unreachable('the stub compactor declines to compact');
    }

    expect(asked).toBe(true);
  });

  it('omits the compaction processor when no compactor is supplied', () => {
    const withoutArgument = new SingleFlow();
    const withEmptyList = new SingleFlow([]);

    for (const flow of [withoutArgument, withEmptyList]) {
      expect(
        flow.requestProcessors.some(
          (processor) => processor instanceof ContextCompactorRequestProcessor,
        ),
      ).toBe(false);
      expect(flow.requestProcessors).toHaveLength(
        new SingleFlow([STUB_COMPACTOR]).requestProcessors.length - 1,
      );
    }
  });

  it('runs the code execution processor after the contents processor', () => {
    const {requestProcessors} = new SingleFlow();

    expect(
      requestProcessors.indexOf(CODE_EXECUTION_REQUEST_PROCESSOR),
    ).toBeGreaterThan(requestProcessors.indexOf(CONTENT_REQUEST_PROCESSOR));
  });

  it('starts with the basic processor and includes the auth preprocessor', () => {
    const {requestProcessors} = new SingleFlow();

    expect(requestProcessors[0]).toBe(BASIC_LLM_REQUEST_PROCESSOR);
    expect(requestProcessors).toContain(AUTH_PREPROCESSOR);
  });

  it('omits the agent transfer processor', () => {
    const {requestProcessors} = new SingleFlow([STUB_COMPACTOR]);

    expect(requestProcessors).not.toContain(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
  });

  it('gives every instance its own array', () => {
    const first = new SingleFlow();
    const second = new SingleFlow();

    expect(first.requestProcessors).not.toBe(second.requestProcessors);
    first.requestProcessors.push(AGENT_TRANSFER_LLM_REQUEST_PROCESSOR);
    expect(second.requestProcessors).not.toContain(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
  });
});

describe('SingleFlow response processors', () => {
  it('composes the response processors in the documented order', () => {
    expect(new SingleFlow().responseProcessors).toEqual([
      NL_PLANNING_RESPONSE_PROCESSOR,
      CODE_EXECUTION_RESPONSE_PROCESSOR,
    ]);
  });

  it('includes the code execution response processor', () => {
    expect(new SingleFlow().responseProcessors).toContain(
      CODE_EXECUTION_RESPONSE_PROCESSOR,
    );
  });

  it('gives every instance its own array', () => {
    const first = new SingleFlow();
    const second = new SingleFlow();

    expect(first.responseProcessors).not.toBe(second.responseProcessors);
    first.responseProcessors.length = 0;
    expect(second.responseProcessors).toContain(
      CODE_EXECUTION_RESPONSE_PROCESSOR,
    );
  });
});
