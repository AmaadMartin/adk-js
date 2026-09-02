/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseContextCompactor,
  BaseLlm,
  BaseLlmConnection,
  ContextCompactorRequestProcessor,
  createSession,
  Event,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  SET_MODEL_RESPONSE_TOOL_NAME,
  SingleFlow,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AGENT_TRANSFER_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/agent_transfer_llm_request_processor.js';
import {BASIC_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/basic_llm_request_processor.js';
import {
  CODE_EXECUTION_REQUEST_PROCESSOR,
  responseProcessor as CODE_EXECUTION_RESPONSE_PROCESSOR,
} from '../../../src/agents/processors/code_execution_request_processor.js';
import {CONTENT_REQUEST_PROCESSOR} from '../../../src/agents/processors/content_request_processor.js';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/identity_llm_request_processor.js';
import {INSTRUCTIONS_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/instructions_llm_request_processor.js';
import {INTERACTIONS_REQUEST_PROCESSOR} from '../../../src/agents/processors/interactions_request_processor.js';
import {OUTPUT_SCHEMA_REQUEST_PROCESSOR} from '../../../src/agents/processors/output_schema_request_processor.js';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_confirmation_llm_request_processor.js';
import {REQUEST_INPUT_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/request_input_llm_request_processor.js';
import {TOOL_FILTER_REQUEST_PROCESSOR} from '../../../src/agents/processors/tool_filter_request_processor.js';
import {AUTH_PREPROCESSOR} from '../../../src/auth/auth_preprocessor.js';

const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

const OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {answer: {type: Type.STRING}},
};

const EXPECTED_ORDER = [
  BASIC_LLM_REQUEST_PROCESSOR,
  AUTH_PREPROCESSOR,
  REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR,
  REQUEST_INPUT_LLM_REQUEST_PROCESSOR,
  INSTRUCTIONS_LLM_REQUEST_PROCESSOR,
  IDENTITY_LLM_REQUEST_PROCESSOR,
  INTERACTIONS_REQUEST_PROCESSOR,
  CONTENT_REQUEST_PROCESSOR,
  CODE_EXECUTION_REQUEST_PROCESSOR,
  TOOL_FILTER_REQUEST_PROCESSOR,
  OUTPUT_SCHEMA_REQUEST_PROCESSOR,
];

/**
 * A model instance is used rather than a model name so that `canonicalModel`
 * resolves without credentials.
 */
class MockLlm extends BaseLlm {
  async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {}

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect is not exercised by these tests');
  }
}

function createInvocationContext(agent: LlmAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

describe('SingleFlow', () => {
  it('builds the reference request pipeline when no compactor is given', () => {
    expect(new SingleFlow().requestProcessors).toEqual(EXPECTED_ORDER);
  });

  it('runs instructions before identity', () => {
    const processors = new SingleFlow().requestProcessors;

    expect(processors.indexOf(INSTRUCTIONS_LLM_REQUEST_PROCESSOR)).toBeLessThan(
      processors.indexOf(IDENTITY_LLM_REQUEST_PROCESSOR),
    );
  });

  it('runs interactions before contents', () => {
    const processors = new SingleFlow().requestProcessors;

    expect(processors.indexOf(INTERACTIONS_REQUEST_PROCESSOR)).toBeLessThan(
      processors.indexOf(CONTENT_REQUEST_PROCESSOR),
    );
  });

  it('runs code execution after contents', () => {
    const processors = new SingleFlow().requestProcessors;

    expect(
      processors.indexOf(CODE_EXECUTION_REQUEST_PROCESSOR),
    ).toBeGreaterThan(processors.indexOf(CONTENT_REQUEST_PROCESSOR));
  });

  it('runs the output schema processor last', () => {
    const processors = new SingleFlow().requestProcessors;

    expect(processors[processors.length - 1]).toBe(
      OUTPUT_SCHEMA_REQUEST_PROCESSOR,
    );
  });

  it('omits the agent transfer processor', () => {
    expect(new SingleFlow().requestProcessors).not.toContain(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
  });

  it('inserts compaction immediately before contents', () => {
    const compactor: BaseContextCompactor = {
      shouldCompact: () => false,
      compact: () => {},
    };

    const processors = new SingleFlow([compactor]).requestProcessors;

    const contentIndex = processors.indexOf(CONTENT_REQUEST_PROCESSOR);
    expect(processors[contentIndex - 1]).toBeInstanceOf(
      ContextCompactorRequestProcessor,
    );
    expect(
      processors.filter(
        (p) => !(p instanceof ContextCompactorRequestProcessor),
      ),
    ).toEqual(EXPECTED_ORDER);
  });

  it('inserts no compaction processor for an empty or absent compactor list', () => {
    for (const processors of [
      new SingleFlow().requestProcessors,
      new SingleFlow([]).requestProcessors,
    ]) {
      expect(
        processors.some((p) => p instanceof ContextCompactorRequestProcessor),
      ).toBe(false);
      expect(processors).toHaveLength(EXPECTED_ORDER.length);
    }
  });

  it('drives the compactors it was constructed with', async () => {
    const shouldCompact = vi.fn().mockReturnValue(false);
    const compactor: BaseContextCompactor = {shouldCompact, compact: vi.fn()};
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm({model: 'gemini-2.5-flash'}),
    });
    const invocationContext = createInvocationContext(agent);
    const processors = new SingleFlow([compactor]).requestProcessors;
    const compaction =
      processors[processors.indexOf(CONTENT_REQUEST_PROCESSOR) - 1];

    const events: Event[] = [];
    for await (const event of compaction.runAsync(invocationContext, {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    })) {
      events.push(event);
    }

    expect(shouldCompact).toHaveBeenCalledWith(invocationContext);
    expect(compactor.compact).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('builds the reference response pipeline', () => {
    expect(new SingleFlow().responseProcessors).toEqual([
      CODE_EXECUTION_RESPONSE_PROCESSOR,
    ]);
  });

  it('gives every instance its own arrays', () => {
    const first = new SingleFlow();
    const second = new SingleFlow();

    first.requestProcessors.push(AGENT_TRANSFER_LLM_REQUEST_PROCESSOR);
    first.responseProcessors.length = 0;

    expect(second.requestProcessors).toEqual(EXPECTED_ORDER);
    expect(second.responseProcessors).toEqual([
      CODE_EXECUTION_RESPONSE_PROCESSOR,
    ]);
  });

  describe('the whole request pipeline', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('offers set_model_response to an agent with an output schema and a tool', async () => {
      vi.stubEnv(VERTEX_ENV_VAR, undefined);
      const agent = new LlmAgent({
        name: 'test_agent',
        model: new MockLlm({model: 'gemini-2.5-flash'}),
        instruction: 'Answer the question.',
        outputSchema: OUTPUT_SCHEMA,
        tools: [
          new FunctionTool({
            name: 'some_tool',
            description: 'A test tool',
            execute: () => 'result',
          }),
        ],
      });
      const invocationContext = createInvocationContext(agent);
      const llmRequest: LlmRequest = {
        contents: [],
        toolsDict: {},
        liveConnectConfig: {},
      };

      for (const processor of new SingleFlow().requestProcessors) {
        for await (const _ of processor.runAsync(
          invocationContext,
          llmRequest,
        )) {
          // The pipeline yields no events for this agent.
        }
      }

      expect(llmRequest.toolsDict).toHaveProperty(SET_MODEL_RESPONSE_TOOL_NAME);
      expect(llmRequest.config?.systemInstruction).toContain(
        SET_MODEL_RESPONSE_TOOL_NAME,
      );
      expect(llmRequest.config?.responseSchema).toBeUndefined();
    });
  });
});
