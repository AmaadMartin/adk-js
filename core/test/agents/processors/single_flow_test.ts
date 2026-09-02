/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  BaseContextCompactor,
  BaseLlm,
  BaseLlmConnection,
  CONTENT_REQUEST_PROCESSOR,
  CONTEXT_CACHE_REQUEST_PROCESSOR,
  ContextCompactorRequestProcessor,
  Event,
  FunctionTool,
  INTERACTIONS_REQUEST_PROCESSOR,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  OUTPUT_SCHEMA_REQUEST_PROCESSOR,
  PluginManager,
  SET_MODEL_RESPONSE_TOOL_NAME,
  SingleFlow,
  createSession,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AGENT_TRANSFER_LLM_REQUEST_PROCESSOR} from '../../../src/agents/processors/agent_transfer_llm_request_processor.js';
import {BaseLlmFlow} from '../../../src/agents/processors/base_llm_flow.js';
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

const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

const STUB_COMPACTOR: BaseContextCompactor = {
  shouldCompact: () => false,
  compact: () => {},
};

/** A subclass in the shape adk-python's `AutoFlow` uses. */
class TransferFlow extends SingleFlow {
  constructor() {
    super();
    this.requestProcessors.push(AGENT_TRANSFER_LLM_REQUEST_PROCESSOR);
  }
}

const OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {answer: {type: Type.STRING}},
};

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

function makeInvocationContext(agent?: LlmAgent): InvocationContext {
  return new InvocationContext({
    invocationId: 'single-flow-test',
    agent,
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
      REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR,
      REQUEST_INPUT_LLM_REQUEST_PROCESSOR,
      INSTRUCTIONS_LLM_REQUEST_PROCESSOR,
      IDENTITY_LLM_REQUEST_PROCESSOR,
      INTERACTIONS_REQUEST_PROCESSOR,
      expect.any(ContextCompactorRequestProcessor),
      CONTENT_REQUEST_PROCESSOR,
      CONTEXT_CACHE_REQUEST_PROCESSOR,
      NL_PLANNING_REQUEST_PROCESSOR,
      CODE_EXECUTION_REQUEST_PROCESSOR,
      OUTPUT_SCHEMA_REQUEST_PROCESSOR,
      TOOL_FILTER_REQUEST_PROCESSOR,
    ]);
  });

  it('runs the interactions processor before the contents processor', () => {
    const {requestProcessors} = new SingleFlow();

    expect(
      requestProcessors.indexOf(INTERACTIONS_REQUEST_PROCESSOR),
    ).toBeLessThan(requestProcessors.indexOf(CONTENT_REQUEST_PROCESSOR));
  });

  it('runs the instructions processor before the identity processor', () => {
    const {requestProcessors} = new SingleFlow();

    expect(
      requestProcessors.indexOf(INSTRUCTIONS_LLM_REQUEST_PROCESSOR),
    ).toBeLessThan(requestProcessors.indexOf(IDENTITY_LLM_REQUEST_PROCESSOR));
  });

  it('runs the output schema processor after the code execution processor', () => {
    const {requestProcessors} = new SingleFlow();

    expect(
      requestProcessors.indexOf(OUTPUT_SCHEMA_REQUEST_PROCESSOR),
    ).toBeGreaterThan(
      requestProcessors.indexOf(CODE_EXECUTION_REQUEST_PROCESSOR),
    );
  });

  it('runs the output schema processor last of the instruction processors', () => {
    // Its instruction must land at the end of the system prompt. Only the tool
    // filter runs after it, and the tool filter appends no instruction.
    const {requestProcessors} = new SingleFlow([STUB_COMPACTOR]);

    expect(requestProcessors[requestProcessors.length - 2]).toBe(
      OUTPUT_SCHEMA_REQUEST_PROCESSOR,
    );
    expect(requestProcessors[requestProcessors.length - 1]).toBe(
      TOOL_FILTER_REQUEST_PROCESSOR,
    );
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

    // Both flows carry exactly one compaction processor, at the same index,
    // and the compactors it holds are the only difference between them.
    const compactionIn = (processors: typeof plain) =>
      processors.filter(
        (processor) => processor instanceof ContextCompactorRequestProcessor,
      );
    expect(compactionIn(plain)).toHaveLength(1);
    expect(compactionIn(compacting)).toHaveLength(1);
    expect(compacting.indexOf(compactionIn(compacting)[0])).toBe(
      plain.indexOf(compactionIn(plain)[0]),
    );
    expect(
      compacting.filter(
        (processor) => !(processor instanceof ContextCompactorRequestProcessor),
      ),
    ).toEqual(
      plain.filter(
        (processor) => !(processor instanceof ContextCompactorRequestProcessor),
      ),
    );
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

  it('passes the invocation context to the compactor and compacts nothing', async () => {
    const shouldCompact = vi.fn().mockReturnValue(false);
    const compactor: BaseContextCompactor = {shouldCompact, compact: vi.fn()};
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new MockLlm({model: 'gemini-2.5-flash'}),
    });
    const invocationContext = makeInvocationContext(agent);
    const processors = new SingleFlow([compactor]).requestProcessors;
    const compaction =
      processors[processors.indexOf(CONTENT_REQUEST_PROCESSOR) - 1];

    const events: Event[] = [];
    for await (const event of compaction.runAsync(
      invocationContext,
      makeLlmRequest(),
    )) {
      events.push(event);
    }

    expect(shouldCompact).toHaveBeenCalledWith(invocationContext);
    expect(compactor.compact).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('keeps the compaction processor when no compactor is supplied', () => {
    // An agent that declares no compactors still honours the compaction policy
    // its App declares, and that policy only reaches the processor per
    // invocation. So the processor stays in the pipeline and does nothing.
    const withoutArgument = new SingleFlow();
    const withEmptyList = new SingleFlow([]);

    for (const flow of [withoutArgument, withEmptyList]) {
      expect(
        flow.requestProcessors.some(
          (processor) => processor instanceof ContextCompactorRequestProcessor,
        ),
      ).toBe(true);
      expect(flow.requestProcessors).toHaveLength(
        new SingleFlow([STUB_COMPACTOR]).requestProcessors.length,
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
      const invocationContext = makeInvocationContext(agent);
      const llmRequest = makeLlmRequest();

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

describe('SingleFlow as a base class', () => {
  it('extends BaseLlmFlow', () => {
    expect(new SingleFlow()).toBeInstanceOf(BaseLlmFlow);
  });

  it('lets a subclass append to the lists its super() call populated', () => {
    const {requestProcessors} = new TransferFlow();

    expect(requestProcessors[0]).toBe(BASIC_LLM_REQUEST_PROCESSOR);
    expect(requestProcessors[requestProcessors.length - 1]).toBe(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
  });

  it('leaves a plain SingleFlow unaffected by a subclass instance', () => {
    const subclassed = new TransferFlow();
    expect(subclassed.requestProcessors).toContain(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );

    expect(new SingleFlow().requestProcessors).not.toContain(
      AGENT_TRANSFER_LLM_REQUEST_PROCESSOR,
    );
  });
});
