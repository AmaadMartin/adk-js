/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CodeExecutionInput,
  CodeExecutionResult,
  ExecuteCodeParams,
} from '@google/adk';
import {BaseCodeExecutor, LlmAgent} from '@google/adk';
import {FinishReason, Outcome} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  collectEvents,
  createRunner,
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

const CODE_BLOCK = '```python\nprint("hello")\n```';

/**
 * Builds a fresh set of recorded responses for one test.
 *
 * The response processor truncates `content.parts` in place and
 * `GeminiWithMockResponses` hands out the same `Candidate` objects it is
 * constructed with, so a fixture shared between tests would be rewritten by
 * whichever test runs first.
 */
function mockResponses(): RawGenerateContentResponse[] {
  return [
    {
      candidates: [
        {
          content: {
            parts: [{text: `Here is the code:\n${CODE_BLOCK}`}],
            role: 'model',
          },
          finishReason: FinishReason.STOP,
        },
      ],
    },
    {
      candidates: [
        {
          content: {parts: [{text: 'Execution finished.'}], role: 'model'},
          finishReason: FinishReason.STOP,
        },
      ],
    },
  ];
}

/**
 * A code executor that records what it was asked to run and returns a fixed
 * result, so the test exercises the real processor pipeline without depending
 * on a Python interpreter being present on the CI host.
 */
class RecordingCodeExecutor extends BaseCodeExecutor {
  readonly calls: CodeExecutionInput[] = [];

  async executeCode(params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    this.calls.push(params.codeExecutionInput);
    return {stdout: 'hello', stderr: '', outputFiles: []};
  }
}

/** A code executor whose run always fails, to exercise the error path. */
class FailingCodeExecutor extends BaseCodeExecutor {
  async executeCode(_params: ExecuteCodeParams): Promise<CodeExecutionResult> {
    return {stdout: '', stderr: 'NameError: boom', outputFiles: []};
  }
}

describe('Agent with a codeExecutor and no explicit responseProcessors', () => {
  it('executes model-emitted code and yields an execution-result event', async () => {
    const executor = new RecordingCodeExecutor();
    const agent = new LlmAgent({
      model: new GeminiWithMockResponses(mockResponses()),
      name: 'coderAgent',
      description: 'An agent that writes and runs code',
      instruction: 'Write code to solve the user request.',
      codeExecutor: executor,
    });

    const {run} = await createRunner(agent);
    const events = await collectEvents(run, 'Print hello');

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].code).toBe('print("hello")');

    const resultParts = events.flatMap(
      (e) => e.content?.parts?.filter((p) => p.codeExecutionResult) ?? [],
    );
    expect(resultParts).toHaveLength(1);
    expect(resultParts[0].codeExecutionResult?.outcome).toBe(
      Outcome.OUTCOME_OK,
    );
    expect(resultParts[0].text).toContain('Code execution result:');
    expect(resultParts[0].text).toContain('hello');
  });

  it('surfaces a failed execution as OUTCOME_FAILED with the stderr text', async () => {
    const agent = new LlmAgent({
      model: new GeminiWithMockResponses(mockResponses()),
      name: 'coderAgent',
      description: 'An agent that writes and runs code',
      instruction: 'Write code to solve the user request.',
      codeExecutor: new FailingCodeExecutor(),
    });

    const {run} = await createRunner(agent);
    const events = await collectEvents(run, 'Print hello');

    const resultParts = events.flatMap(
      (e) => e.content?.parts?.filter((p) => p.codeExecutionResult) ?? [],
    );
    expect(resultParts).toHaveLength(1);
    expect(resultParts[0].codeExecutionResult?.outcome).toBe(
      Outcome.OUTCOME_FAILED,
    );
    expect(resultParts[0].text).toContain('NameError: boom');
  });

  it('is inert for an agent that has no codeExecutor', async () => {
    const agent = new LlmAgent({
      model: new GeminiWithMockResponses(mockResponses()),
      name: 'plainAgent',
      description: 'An agent with no code executor',
      instruction: 'Answer the user request.',
    });

    const {run} = await createRunner(agent);
    const events = await collectEvents(run, 'Print hello');

    const resultParts = events.flatMap(
      (e) => e.content?.parts?.filter((p) => p.codeExecutionResult) ?? [],
    );
    expect(resultParts).toHaveLength(0);

    // The model turn reaches the caller untouched: nothing truncated it to the
    // first code block.
    const allText = events
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    expect(allText).toContain(CODE_BLOCK);
  });
});
