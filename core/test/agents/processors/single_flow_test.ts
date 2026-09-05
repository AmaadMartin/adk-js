/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  BaseContextCompactor,
  CONTENT_REQUEST_PROCESSOR,
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
import {CODE_EXECUTION_REQUEST_PROCESSOR} from '../../../src/agents/processors/code_execution_request_processor.js';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/identity_llm_request_processor.js';
import {INSTRUCTIONS_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/instructions_llm_request_processor.js';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_confirmation_llm_request_processor.js';
import {REQUEST_INPUT_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_input_llm_request_processor.js';
import {TOOL_FILTER_REQUEST_PROCESSOR} from '../../../src/agents/processors/tool_filter_request_processor.js';

const stubCompactor: BaseContextCompactor = {
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

describe('SingleFlow', () => {
  it('composes the request processors in the documented order', () => {
    expect(new SingleFlow().requestProcessors).toEqual([
      BASIC_LLM_REQUEST_PROCESSOR,
      AUTH_PREPROCESSOR,
      IDENTITY_LLM_REQUEST_PROCESSOR,
      INSTRUCTIONS_LLM_REQUEST_PROCESSOR,
      REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR,
      REQUEST_INPUT_LLM_REQUEST_PROCESSOR,
      CONTENT_REQUEST_PROCESSOR,
      INTERACTIONS_REQUEST_PROCESSOR,
      CODE_EXECUTION_REQUEST_PROCESSOR,
      TOOL_FILTER_REQUEST_PROCESSOR,
    ]);
  });

  it('runs code execution after the contents are assembled', () => {
    const processors = new SingleFlow().requestProcessors;

    expect(
      processors.indexOf(CODE_EXECUTION_REQUEST_PROCESSOR),
    ).toBeGreaterThan(processors.indexOf(CONTENT_REQUEST_PROCESSOR));
  });

  it('inserts one compaction processor immediately before the contents', () => {
    const plain = new SingleFlow().requestProcessors;
    const compacting = new SingleFlow([stubCompactor]).requestProcessors;
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
    expect(new SingleFlow().requestProcessors).toHaveLength(
      new SingleFlow([stubCompactor]).requestProcessors.length - 1,
    );
  });

  it('never adds the agent transfer processor', () => {
    expect(new SingleFlow([stubCompactor]).requestProcessors).not.toContain(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
  });

  it('leaves the response processors empty', () => {
    expect(new SingleFlow().responseProcessors).toEqual([]);
  });

  it('gives every instance its own arrays', () => {
    const first = new SingleFlow();
    const second = new SingleFlow();

    first.requestProcessors.push(AGENT_TRANSFER_LLM_REQUEST_PROCESSOR);

    expect(second.requestProcessors).not.toContain(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
    expect(first.responseProcessors).not.toBe(second.responseProcessors);
  });
});
