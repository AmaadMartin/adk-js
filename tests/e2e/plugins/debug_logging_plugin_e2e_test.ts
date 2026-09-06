/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  DebugLoggingPlugin,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Type} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

/**
 * A deterministic, offline model that drives a real function-calling turn: the
 * first call asks to invoke the `echo` tool, the second returns a final answer.
 * No network is involved, so the end-to-end run is fully reproducible.
 */
class LocalTestLlm extends BaseLlm {
  private callCount = 0;

  constructor() {
    super({model: 'local-test-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.callCount++;
    if (this.callCount === 1) {
      yield {
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'call-1', name: 'echo', args: {text: 'hello'}}},
          ],
        },
      };
      return;
    }
    yield {
      content: {role: 'model', parts: [{text: 'The tool echoed: hello'}]},
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect is not supported by LocalTestLlm');
  }
}

describe('E2E DebugLoggingPlugin', () => {
  let tempDir: string;
  let outputPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-debug-e2e-'));
    outputPath = path.join(tempDir, 'nested', 'adk_debug.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  it('captures a full model+tool invocation to the durable file via a real Runner', async () => {
    const echoTool = new FunctionTool({
      name: 'echo',
      description: 'Echoes the provided text back to the caller.',
      parameters: {
        type: Type.OBJECT,
        properties: {text: {type: Type.STRING}},
      },
      execute: (input: unknown) => ({
        echoed: (input as {text?: string}).text ?? '',
      }),
    });

    const agent = new LlmAgent({
      name: 'debug_e2e_agent',
      description: 'An agent used to validate DebugLoggingPlugin end-to-end.',
      instruction: 'Call the echo tool then answer.',
      model: new LocalTestLlm(),
      tools: [echoTool],
    });

    const plugin = new DebugLoggingPlugin({outputPath});
    const runner = new InMemoryRunner({
      agent,
      appName: 'debug_e2e_app',
      plugins: [plugin],
    });

    const session = await runner.sessionService.createSession({
      appName: 'debug_e2e_app',
      userId: 'e2e_user',
    });

    const events = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Please echo hello'}]},
    })) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);

    // The nested output directory was created automatically and the invocation
    // produced exactly one NDJSON line that parses independently.
    const text = await fs.readFile(outputPath, 'utf-8');
    const lines = text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const trace = JSON.parse(lines[0]) as Record<string, unknown>;

    expect(trace['appName']).toBe('debug_e2e_app');
    expect(trace['userId']).toBe('e2e_user');
    expect(trace['sessionId']).toBe(session.id);

    const entries = trace['entries'] as Array<Record<string, unknown>>;
    const types = entries.map((e) => e['entryType']);
    // The Runner fires onUserMessageCallback *before* beforeRunCallback, so
    // `user_message` being present here is what proves the per-invocation state
    // is created lazily by whichever callback runs first.
    expect(types).toEqual(
      expect.arrayContaining([
        'user_message',
        'invocation_start',
        'llm_request',
        'llm_response',
        'tool_call',
        'tool_response',
        'event',
        'session_state_snapshot',
        'invocation_end',
      ]),
    );
    expect(types.indexOf('user_message')).toBeLessThan(
      types.indexOf('invocation_start'),
    );

    const userMessage = entries.find((e) => e['entryType'] === 'user_message')![
      'data'
    ] as Record<string, unknown>;
    const userContent = userMessage['content'] as Record<string, unknown>;
    const userParts = userContent['parts'] as Array<Record<string, unknown>>;
    expect(userParts[0]['text']).toBe('Please echo hello');

    const toolCall = entries.find((e) => e['entryType'] === 'tool_call')![
      'data'
    ] as Record<string, unknown>;
    expect(toolCall['toolName']).toBe('echo');
    expect((toolCall['args'] as Record<string, unknown>)['text']).toBe('hello');

    const toolResponse = entries.find(
      (e) => e['entryType'] === 'tool_response',
    )!['data'] as Record<string, unknown>;
    expect((toolResponse['result'] as Record<string, unknown>)['echoed']).toBe(
      'hello',
    );
  });
});
