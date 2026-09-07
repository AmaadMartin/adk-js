/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  InMemoryArtifactService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  createSession,
} from '@google/adk';
import {Outcome} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  CODE_EXECUTION_REQUEST_PROCESSOR,
  CodeExecutionResponseProcessor,
} from '../../../src/agents/processors/code_execution_request_processor.js';
import {ScopedArtifactService} from '../../../src/artifacts/scoped_artifact_service.js';
import {
  BaseCodeExecutor,
  ExecuteCodeParams,
} from '../../../src/code_executors/base_code_executor.js';
import {
  CodeExecutionInput,
  CodeExecutionLanguage,
  CodeExecutionResult,
} from '../../../src/code_executors/code_execution_utils.js';
import {CodeExecutorContext} from '../../../src/code_executors/code_executor_context.js';
import {UnsafeLocalCodeExecutor} from '../../../src/code_executors/unsafe_local_code_executor.js';
import {State} from '../../../src/sessions/state.js';
import {base64Encode} from '../../../src/utils/env_aware_utils.js';

/**
 * Two cases in this file drive a real `UnsafeLocalCodeExecutor`, which spawns
 * an interpreter. Budget by what is under test: that executor's own default
 * timeout is 30s, and a harness that gives up sooner can never observe the
 * behaviour it covers. This is a ceiling, not a delay.
 */
vi.setConfig({testTimeout: 30_000});

class MockBaseAgent extends BaseAgent {
  constructor(name: string) {
    super({name});
  }
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

class TestCodeExecutor extends BaseCodeExecutor {
  async executeCode(_params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    return {stdout: '', stderr: '', outputFiles: []};
  }
}

/** A code executor that records the input it was dispatched. */
class RecordingCodeExecutor extends BaseCodeExecutor {
  lastInput?: CodeExecutionInput;

  async executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    this.lastInput = params.codeExecutionInput;
    return {stdout: 'ok', stderr: '', outputFiles: []};
  }
}

function createMockInvocationContext(agent: BaseAgent): InvocationContext {
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
    // Reaching the executor also reaches the result post-processor, which
    // requires an artifact service.
    artifactService: new ScopedArtifactService(
      new InMemoryArtifactService(),
      'test-app',
      'test-user',
      'test-session',
    ),
  });
}

function createLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
    ...overrides,
  };
}

async function collectEvents<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const event of gen) {
    results.push(event);
  }
  return results;
}

describe('CodeExecutionRequestProcessor', () => {
  describe('early-exit paths', () => {
    it('yields no events and leaves request unchanged for a non-LlmAgent', async () => {
      const agent = new MockBaseAgent('non-llm-agent');
      const ctx = createMockInvocationContext(agent);
      const llmRequest = createLlmRequest({
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
      });

      const events = await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(events).toHaveLength(0);
      expect(llmRequest.contents).toHaveLength(1);
    });

    it('yields no events when LlmAgent has no codeExecutor', async () => {
      const agent = new LlmAgent({
        name: 'agent-no-executor',
        model: 'gemini-2.5-flash',
      });
      const ctx = createMockInvocationContext(agent);
      const llmRequest = createLlmRequest({
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
      });

      const events = await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(events).toHaveLength(0);
    });

    it('calls runPreProcessor and proceeds to convertCodeExecutionParts when codeExecutor is BaseCodeExecutor', async () => {
      const executor = new TestCodeExecutor();
      const agent = new LlmAgent({
        name: 'agent-with-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: executor,
      });
      const ctx = createMockInvocationContext(agent);
      const llmRequest = createLlmRequest({
        contents: [{role: 'user', parts: [{text: 'hello'}]}],
      });

      // Should not throw — runPreProcessor exits early because
      // isBuiltInCodeExecutor is false and optimizeDataFile is false
      const events = await collectEvents(
        CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
      );

      expect(events).toHaveLength(0);
      // Content should still be present after processing
      expect(llmRequest.contents).toHaveLength(1);
    });
  });
});

describe('CodeExecutionResponseProcessor', () => {
  const responseProcessor = new CodeExecutionResponseProcessor();

  describe('early-exit paths', () => {
    it('yields no events for a partial response', async () => {
      const agent = new LlmAgent({
        name: 'agent',
        model: 'gemini-2.5-flash',
        codeExecutor: new TestCodeExecutor(),
      });
      const ctx = createMockInvocationContext(agent);
      const partialResponse = {
        partial: true,
        content: {role: 'model', parts: [{text: 'thinking...'}]},
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, partialResponse),
      );

      expect(events).toHaveLength(0);
    });

    it('yields no events for a non-LlmAgent', async () => {
      const agent = new MockBaseAgent('non-llm');
      const ctx = createMockInvocationContext(agent);
      const llmResponse = {
        partial: false,
        content: {role: 'model', parts: [{text: 'done'}]},
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(events).toHaveLength(0);
    });

    it('yields no events when LlmAgent has no codeExecutor', async () => {
      const agent = new LlmAgent({
        name: 'agent-no-executor',
        model: 'gemini-2.5-flash',
      });
      const ctx = createMockInvocationContext(agent);
      const llmResponse = {
        partial: false,
        content: {role: 'model', parts: [{text: 'done'}]},
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(events).toHaveLength(0);
    });

    it('yields no events when response has no content', async () => {
      const agent = new LlmAgent({
        name: 'agent-with-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: new TestCodeExecutor(),
      });
      const ctx = createMockInvocationContext(agent);
      const llmResponse = {partial: false};

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(events).toHaveLength(0);
    });

    it('yields no events when response content has no code block', async () => {
      const agent = new LlmAgent({
        name: 'agent-with-executor',
        model: 'gemini-2.5-flash',
        codeExecutor: new TestCodeExecutor(),
      });
      const ctx = createMockInvocationContext(agent);
      const llmResponse = {
        partial: false,
        content: {role: 'model', parts: [{text: 'plain text response'}]},
      };

      const events = await collectEvents(
        responseProcessor.runAsync(ctx, llmResponse),
      );

      expect(events).toHaveLength(0);
    });
  });
});

describe('CodeExecutionResponseProcessor dispatch language', () => {
  const responseProcessor = new CodeExecutionResponseProcessor();

  function createAgentWithRecorder(): {
    agent: LlmAgent;
    executor: RecordingCodeExecutor;
  } {
    const executor = new RecordingCodeExecutor();
    return {
      agent: new LlmAgent({
        name: 'agent-with-recorder',
        model: 'gemini-2.5-flash',
        codeExecutor: executor,
      }),
      executor,
    };
  }

  it.each([
    ['tool_code', 'my_function()', CodeExecutionLanguage.PYTHON],
    ['python', 'print("hi")', CodeExecutionLanguage.PYTHON],
    ['javascript', 'console.log(1)', CodeExecutionLanguage.JAVASCRIPT],
    ['typescript', 'const x: number = 1', CodeExecutionLanguage.TYPESCRIPT],
    ['bash', 'echo "hello"', CodeExecutionLanguage.SHELL],
    ['sh', 'echo "hello"', CodeExecutionLanguage.SHELL],
  ])(
    'dispatches a %s block as its own language',
    async (fence, code, language) => {
      const {agent, executor} = createAgentWithRecorder();
      const ctx = createMockInvocationContext(agent);

      await collectEvents(
        responseProcessor.runAsync(ctx, {
          partial: false,
          content: {
            role: 'model',
            parts: [{text: `\`\`\`${fence}\n${code}\n\`\`\``}],
          },
        }),
      );

      expect(executor.lastInput?.language).toBe(language);
      expect(executor.lastInput?.code).toBe(code);
    },
  );

  it('keeps the surrounding behaviour for a non-python fence', async () => {
    const {agent, executor} = createAgentWithRecorder();
    const ctx = createMockInvocationContext(agent);
    const llmResponse = {
      partial: false,
      content: {role: 'model', parts: [{text: '```bash\necho "hello"\n```'}]},
    };

    const events = await collectEvents(
      responseProcessor.runAsync(ctx, llmResponse),
    );

    expect(events).toHaveLength(2);
    expect(llmResponse.content).toBeUndefined();
    expect(executor.lastInput?.language).toBe(CodeExecutionLanguage.SHELL);
  });

  it('dispatches python for an executor with custom delimiters', async () => {
    const executor = new RecordingCodeExecutor();
    executor.codeBlockDelimiters = [['<code>', '</code>']];
    const agent = new LlmAgent({
      name: 'agent-custom-delimiters',
      model: 'gemini-2.5-flash',
      codeExecutor: executor,
    });
    const ctx = createMockInvocationContext(agent);

    await collectEvents(
      responseProcessor.runAsync(ctx, {
        partial: false,
        content: {role: 'model', parts: [{text: '<code>echo "hello"</code>'}]},
      }),
    );

    expect(executor.lastInput?.language).toBe(CodeExecutionLanguage.PYTHON);
  });

  it('keeps python for the data file preprocessing code, which is not model output', async () => {
    const executor = new RecordingCodeExecutor();
    executor.optimizeDataFile = true;
    const agent = new LlmAgent({
      name: 'agent-optimize-data-file',
      model: 'gemini-2.5-flash',
      codeExecutor: executor,
    });
    const ctx = createMockInvocationContext(agent);
    const llmRequest = createLlmRequest({
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'text/csv',
                data: base64Encode('a,b\n1,2\n'),
              },
            },
          ],
        },
      ],
    });

    await collectEvents(
      CODE_EXECUTION_REQUEST_PROCESSOR.runAsync(ctx, llmRequest),
    );

    expect(executor.lastInput?.language).toBe(CodeExecutionLanguage.PYTHON);
    expect(executor.lastInput?.code).toContain('explore_df');
  });
});

describe('CodeExecutionResponseProcessor with a real local executor', () => {
  const responseProcessor = new CodeExecutionResponseProcessor();

  it('runs a shell fence through the shell interpreter', async () => {
    const agent = new LlmAgent({
      name: 'agent-unsafe-local',
      model: 'gemini-2.5-flash',
      codeExecutor: new UnsafeLocalCodeExecutor(),
    });
    const ctx = createMockInvocationContext(agent);

    const events = await collectEvents(
      responseProcessor.runAsync(ctx, {
        partial: false,
        content: {role: 'model', parts: [{text: '```bash\necho hello\n```'}]},
      }),
    );

    const resultPart = events[1].content?.parts?.[0];
    expect(resultPart?.codeExecutionResult?.outcome).toBe(Outcome.OUTCOME_OK);
    expect(resultPart?.text).toContain('hello');
  });

  it('reports a language the executor cannot run without ending the invocation', async () => {
    const agent = new LlmAgent({
      name: 'agent-unsupported-language',
      model: 'gemini-2.5-flash',
      codeExecutor: new UnsafeLocalCodeExecutor(),
    });
    const ctx = createMockInvocationContext(agent);

    const events = await collectEvents(
      responseProcessor.runAsync(ctx, {
        partial: false,
        content: {
          role: 'model',
          parts: [{text: '```typescript\nconst x: number = 1\n```'}],
        },
      }),
    );

    const resultPart = events[1].content?.parts?.[0];
    expect(resultPart?.codeExecutionResult?.outcome).toBe(
      Outcome.OUTCOME_FAILED,
    );
    expect(resultPart?.text).toContain('Unsupported language: typescript');
    // The failure feeds the error retry loop rather than aborting the run.
    expect(
      new CodeExecutorContext(new State(ctx.session.state)).getErrorCount(
        ctx.invocationId,
      ),
    ).toBe(1);
  });
});
