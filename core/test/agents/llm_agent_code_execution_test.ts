/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseCodeExecutor,
  BaseLlm,
  BaseLlmConnection,
  CodeExecutionInput,
  CodeExecutionResult,
  Event,
  ExecuteCodeParams,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

class ScriptedLlm extends BaseLlm {
  readonly requests: Content[][] = [];

  constructor(private readonly replies: string[]) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(structuredClone(request.contents));
    const reply = this.replies[this.requests.length - 1] ?? '';
    yield {content: {role: 'model', parts: [{text: reply}]}};
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live mode.');
  }
}

class RecordingCodeExecutor extends BaseCodeExecutor {
  readonly inputs: CodeExecutionInput[] = [];

  async executeCode({
    codeExecutionInput,
  }: ExecuteCodeParams): Promise<CodeExecutionResult> {
    this.inputs.push(codeExecutionInput);
    return {stdout: '42', stderr: '', outputFiles: []};
  }
}

async function runOneTurn(agent: LlmAgent): Promise<Event[]> {
  const runner = new InMemoryRunner({agent, appName: 'app'});
  const session = await runner.sessionService.createSession({
    appName: 'app',
    userId: 'user',
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'what is 6 * 7?'}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('LlmAgent code execution', () => {
  it('executes a code block from the model response with the default response processors', async () => {
    const model = new ScriptedLlm([
      '```python\nprint(6 * 7)\n```',
      'The answer is 42.',
    ]);
    const codeExecutor = new RecordingCodeExecutor();
    const agent = new LlmAgent({name: 'calculator', model, codeExecutor});

    const events = await runOneTurn(agent);

    expect(codeExecutor.inputs.map((input) => input.code)).toEqual([
      'print(6 * 7)',
    ]);
    expect(events.map((e) => e.content?.parts?.[0])).toEqual([
      {executableCode: {code: 'print(6 * 7)', language: 'PYTHON'}},
      {
        codeExecutionResult: {
          outcome: 'OUTCOME_OK',
          output: 'Code execution result:\n42\n',
        },
      },
      {text: 'The answer is 42.'},
    ]);
    expect(model.requests[1].at(-1)).toEqual({
      role: 'user',
      parts: [{text: '```tool_output\nCode execution result:\n42\n\n```'}],
    });
  });
});
