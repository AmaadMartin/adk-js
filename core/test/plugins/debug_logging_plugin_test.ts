/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseTool,
  Context,
  createEvent,
  InvocationContext,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Content} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DebugLoggingPlugin} from '../../src/plugins/debug_logging_plugin.js';
import {resetLogger, setLogger} from '../../src/utils/logger.js';

const INVOCATION_ID = 'inv-1';

type Dict = Record<string, unknown>;

function makeMockLogger() {
  const warnCalls: string[] = [];
  const errorCalls: string[] = [];
  const mockLogger = {
    setLogLevel: () => {},
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      warnCalls.push(args.map((a) => String(a)).join(' '));
    },
    error: (...args: unknown[]) => {
      errorCalls.push(args.map((a) => String(a)).join(' '));
    },
  };
  return {mockLogger, warnCalls, errorCalls};
}

function makeInvocationContext(overrides: Dict = {}): InvocationContext {
  return {
    invocationId: INVOCATION_ID,
    session: {
      id: 'session-1',
      appName: 'test-app',
      userId: 'user-1',
      state: {counter: 1},
      events: [],
    },
    userId: 'user-1',
    appName: 'test-app',
    agent: {name: 'test_agent'} as BaseAgent,
    branch: undefined,
    ...overrides,
  } as unknown as InvocationContext;
}

function makeCallbackContext(overrides: Dict = {}): Context {
  return {
    agentName: 'test_agent',
    invocationId: INVOCATION_ID,
    invocationContext: makeInvocationContext(),
    ...overrides,
  } as unknown as Context;
}

function makeToolContext(overrides: Dict = {}): Context {
  return {
    agentName: 'test_agent',
    invocationId: INVOCATION_ID,
    functionCallId: 'fc-1',
    ...overrides,
  } as unknown as Context;
}

async function readTraces(outputPath: string): Promise<Dict[]> {
  const text = await fs.readFile(outputPath, 'utf-8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Dict);
}

/** Returns the ordered list of entry types in a trace. */
function entryTypes(trace: Dict): string[] {
  return (trace['entries'] as Dict[]).map((e) => e['entryType'] as string);
}

/** Returns the `data` payload of the first entry of the given type. */
function dataOf(trace: Dict, type: string): Dict {
  const entry = (trace['entries'] as Dict[]).find(
    (e) => e['entryType'] === type,
  );
  if (!entry) {
    throw new Error(`no entry of type ${type}`);
  }
  return entry['data'] as Dict;
}

describe('DebugLoggingPlugin', () => {
  let tempDir: string;
  let outputPath: string;
  let warnCalls: string[];
  let errorCalls: string[];

  beforeEach(async () => {
    const mock = makeMockLogger();
    warnCalls = mock.warnCalls;
    errorCalls = mock.errorCalls;
    setLogger(mock.mockLogger);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-debug-test-'));
    outputPath = path.join(tempDir, 'debug.jsonl');
  });

  afterEach(async () => {
    resetLogger();
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  it('should initialize with default name "debug_logging_plugin"', () => {
    const plugin = new DebugLoggingPlugin();
    expect(plugin.name).toBe('debug_logging_plugin');
  });

  it('should accept a custom name and options', () => {
    const plugin = new DebugLoggingPlugin({name: 'x', outputPath});
    expect(plugin.name).toBe('x');
  });

  it('PRIMARY: writes a full invocation trace to the file', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    const invocationContext = makeInvocationContext();
    const callbackContext = makeCallbackContext();
    const toolContext = makeToolContext();
    const tool = {name: 'my_tool'} as BaseTool;

    expect(await plugin.beforeRunCallback({invocationContext})).toBeUndefined();
    expect(
      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {role: 'user', parts: [{text: 'hi'}]},
      }),
    ).toBeUndefined();
    expect(
      await plugin.beforeModelCallback({
        callbackContext,
        llmRequest: {
          model: 'gemini-2.0-flash',
          contents: [{role: 'user', parts: [{text: 'hi'}]}],
          toolsDict: {my_tool: tool},
          liveConnectConfig: {},
        } as unknown as LlmRequest,
      }),
    ).toBeUndefined();
    expect(
      await plugin.afterModelCallback({
        callbackContext,
        llmResponse: {
          content: {role: 'model', parts: [{text: 'done'}]},
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            totalTokenCount: 30,
          },
        } as unknown as LlmResponse,
      }),
    ).toBeUndefined();
    expect(
      await plugin.beforeToolCallback({
        tool,
        toolArgs: {query: 'x'},
        toolContext,
      }),
    ).toBeUndefined();
    expect(
      await plugin.afterToolCallback({
        tool,
        toolArgs: {query: 'x'},
        toolContext,
        result: {output: 'ok'},
      }),
    ).toBeUndefined();
    const finalEvent = createEvent({
      author: 'agent',
      content: {role: 'model', parts: [{text: 'done'}]},
    });
    expect(
      await plugin.onEventCallback({invocationContext, event: finalEvent}),
    ).toBeUndefined();
    expect(await plugin.afterRunCallback({invocationContext})).toBeUndefined();

    const traces = await readTraces(outputPath);
    expect(traces).toHaveLength(1);
    const trace = traces[0];
    expect(trace['invocationId']).toBe(INVOCATION_ID);
    expect(trace['sessionId']).toBe('session-1');
    expect(trace['appName']).toBe('test-app');
    expect(trace['userId']).toBe('user-1');
    expect(typeof trace['startTime']).toBe('string');
    expect(Array.isArray(trace['entries'])).toBe(true);

    expect(entryTypes(trace)).toEqual(
      expect.arrayContaining([
        'invocation_start',
        'user_message',
        'llm_request',
        'llm_response',
        'tool_call',
        'tool_response',
        'event',
        'session_state_snapshot',
        'invocation_end',
      ]),
    );

    const llmRequest = dataOf(trace, 'llm_request');
    expect(llmRequest['model']).toBe('gemini-2.0-flash');
    expect(llmRequest['tools']).toContain('my_tool');
    expect(llmRequest['contentCount']).toBe(1);

    const usage = dataOf(trace, 'llm_response')['usageMetadata'] as Dict;
    expect(usage['promptTokenCount']).toBe(10);

    const toolCall = dataOf(trace, 'tool_call');
    expect((toolCall['args'] as Dict)['query']).toBe('x');
    expect(toolCall['toolName']).toBe('my_tool');
    expect(toolCall['functionCallId']).toBe('fc-1');

    expect((dataOf(trace, 'tool_response')['result'] as Dict)['output']).toBe(
      'ok',
    );
    expect(dataOf(trace, 'event')['isFinalResponse']).toBe(true);

    const snapshot = dataOf(trace, 'session_state_snapshot');
    expect((snapshot['state'] as Dict)['counter']).toBe(1);
    expect(snapshot['eventCount']).toBe(0);
  });

  it('appends one NDJSON line per invocation', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    for (const id of ['inv-a', 'inv-b']) {
      const invocationContext = makeInvocationContext({invocationId: id});
      await plugin.beforeRunCallback({invocationContext});
      await plugin.afterRunCallback({invocationContext});
    }
    const traces = await readTraces(outputPath);
    expect(traces).toHaveLength(2);
    expect(traces[0]['invocationId']).toBe('inv-a');
    expect(traces[1]['invocationId']).toBe('inv-b');
  });

  it('records the full system instruction when includeSystemInstruction is true', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    const invocationContext = makeInvocationContext();
    const callbackContext = makeCallbackContext();
    const instruction = 'You are a helpful assistant. '.repeat(20);

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: {
        model: 'm',
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
        config: {
          systemInstruction: instruction,
          temperature: 0.5,
          topP: 0.9,
          topK: 40,
          maxOutputTokens: 256,
          responseMimeType: 'application/json',
          responseSchema: {type: 'object'},
        },
      } as unknown as LlmRequest,
    });
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    const config = dataOf(trace, 'llm_request')['config'] as Dict;
    expect(config['systemInstruction']).toBe(instruction);
    expect(config['systemInstructionLength']).toBeUndefined();
    expect(config['temperature']).toBe(0.5);
    expect(config['topP']).toBe(0.9);
    expect(config['topK']).toBe(40);
    expect(config['maxOutputTokens']).toBe(256);
    expect(config['responseMimeType']).toBe('application/json');
    expect(config['hasResponseSchema']).toBe(true);
  });

  it('records only the instruction length when includeSystemInstruction is false', async () => {
    const plugin = new DebugLoggingPlugin({
      outputPath,
      includeSystemInstruction: false,
    });
    const invocationContext = makeInvocationContext();
    const callbackContext = makeCallbackContext();
    const instruction = 'secret system instruction';

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: {
        model: 'm',
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
        config: {systemInstruction: instruction},
      } as unknown as LlmRequest,
    });
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    const config = dataOf(trace, 'llm_request')['config'] as Dict;
    expect(config['systemInstruction']).toBeUndefined();
    expect(config['systemInstructionLength']).toBe(instruction.length);
  });

  it('records hasSystemInstruction for non-string instructions when disabled', async () => {
    const plugin = new DebugLoggingPlugin({
      outputPath,
      includeSystemInstruction: false,
    });
    const invocationContext = makeInvocationContext();
    const callbackContext = makeCallbackContext();

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: {
        model: 'm',
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
        config: {
          systemInstruction: {role: 'system', parts: [{text: 'hi'}]},
        },
      } as unknown as LlmRequest,
    });
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    const config = dataOf(trace, 'llm_request')['config'] as Dict;
    expect(config['hasSystemInstruction']).toBe(true);
  });

  it('omits a config entry and tools list when neither is present', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    const invocationContext = makeInvocationContext();
    const callbackContext = makeCallbackContext();

    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: {
        model: 'm',
        contents: [],
        liveConnectConfig: {},
        // empty toolsDict exercises the "truthy but empty" branch
        toolsDict: {},
      } as unknown as LlmRequest,
    });
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    const data = dataOf(trace, 'llm_request');
    expect(data['config']).toBeUndefined();
    expect(data['tools']).toBeUndefined();
  });

  it('omits the session_state_snapshot when includeSessionState is false', async () => {
    const plugin = new DebugLoggingPlugin({
      outputPath,
      includeSessionState: false,
    });
    const invocationContext = makeInvocationContext();

    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    expect(entryTypes(trace)).not.toContain('session_state_snapshot');
    expect(entryTypes(trace)).toContain('invocation_end');
  });

  it('handles a missing invocation-context agent name gracefully', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    const invocationContext = makeInvocationContext({agent: undefined});

    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    expect(dataOf(trace, 'invocation_start')['agentName']).toBeUndefined();
  });

  it('records agent_start and agent_end entries', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    const invocationContext = makeInvocationContext();
    const callbackContext = makeCallbackContext({
      invocationContext: makeInvocationContext({branch: 'b1'}),
    });
    const agent = {name: 'test_agent'} as BaseAgent;

    await plugin.beforeRunCallback({invocationContext});
    expect(
      await plugin.beforeAgentCallback({agent, callbackContext}),
    ).toBeUndefined();
    expect(
      await plugin.afterAgentCallback({agent, callbackContext}),
    ).toBeUndefined();
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    expect(entryTypes(trace)).toContain('agent_start');
    expect(entryTypes(trace)).toContain('agent_end');
    expect(dataOf(trace, 'agent_start')['branch']).toBe('b1');
  });

  it('captures a rich event with actions, usage, grounding and errors', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    const invocationContext = makeInvocationContext();
    await plugin.beforeRunCallback({invocationContext});

    const event = createEvent({
      author: 'agent',
      content: {role: 'model', parts: [{text: 'partial'}]},
      partial: true,
      turnComplete: false,
      branch: 'main',
      longRunningToolIds: ['lrt-1'],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 2,
        totalTokenCount: 3,
      },
      groundingMetadata: {},
      errorCode: 'E1',
      errorMessage: 'boom',
    });
    event.actions.stateDelta = {a: 1};
    event.actions.artifactDelta = {'file.txt': 2};
    event.actions.transferToAgent = 'other';
    event.actions.escalate = true;
    event.actions.requestedAuthConfigs = {
      'fc-1': {} as never,
      'fc-2': {} as never,
    };

    expect(
      await plugin.onEventCallback({invocationContext, event}),
    ).toBeUndefined();
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    const eventData = dataOf(trace, 'event');

    expect(eventData['hasGroundingMetadata']).toBe(true);
    expect(eventData['errorCode']).toBe('E1');
    expect(eventData['errorMessage']).toBe('boom');
    expect(eventData['longRunningToolIds']).toEqual(['lrt-1']);
    expect((eventData['usageMetadata'] as Dict)['totalTokenCount']).toBe(3);

    const actions = eventData['actions'] as Dict;
    expect((actions['stateDelta'] as Dict)['a']).toBe(1);
    expect((actions['artifactDelta'] as Dict)['file.txt']).toBe(2);
    expect(actions['transferToAgent']).toBe('other');
    expect(actions['escalate']).toBe(true);
    expect(actions['requestedAuthConfigs']).toBe(2);
  });

  it('omits the actions object when the event has no meaningful actions', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    const invocationContext = makeInvocationContext();
    await plugin.beforeRunCallback({invocationContext});

    const event = createEvent({
      author: 'agent',
      content: {role: 'model', parts: [{text: 'plain'}]},
    });
    await plugin.onEventCallback({invocationContext, event});
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    const eventData = dataOf(trace, 'event');
    expect(eventData['actions']).toBeUndefined();
    expect(eventData['usageMetadata']).toBeUndefined();
    expect(eventData['hasGroundingMetadata']).toBeUndefined();
  });

  it('captures llm_response errors, finish reason, grounding and model version', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    const invocationContext = makeInvocationContext();
    const callbackContext = makeCallbackContext();
    await plugin.beforeRunCallback({invocationContext});

    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: {
        errorCode: '500',
        errorMessage: 'server error',
        finishReason: 'STOP',
        modelVersion: 'v2',
        groundingMetadata: {},
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 6,
          totalTokenCount: 11,
          cachedContentTokenCount: 1,
        },
      } as unknown as LlmResponse,
    });
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    const data = dataOf(trace, 'llm_response');
    expect(data['errorCode']).toBe('500');
    expect(data['errorMessage']).toBe('server error');
    expect(data['finishReason']).toBe('STOP');
    expect(data['modelVersion']).toBe('v2');
    expect(data['hasGroundingMetadata']).toBe(true);
    expect((data['usageMetadata'] as Dict)['cachedContentTokenCount']).toBe(1);
  });

  it('records model and tool errors and returns undefined', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    const invocationContext = makeInvocationContext();
    const callbackContext = makeCallbackContext();
    const toolContext = makeToolContext();
    const tool = {name: 'my_tool'} as BaseTool;
    await plugin.beforeRunCallback({invocationContext});

    expect(
      await plugin.onModelErrorCallback({
        callbackContext,
        llmRequest: {
          model: 'm',
          contents: [],
          liveConnectConfig: {},
          toolsDict: {},
        } as unknown as LlmRequest,
        error: new TypeError('model failed'),
      }),
    ).toBeUndefined();
    expect(
      await plugin.onToolErrorCallback({
        tool,
        toolArgs: {q: 1},
        toolContext,
        error: new Error('tool failed'),
      }),
    ).toBeUndefined();
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    const modelError = dataOf(trace, 'llm_error');
    expect(modelError['errorType']).toBe('TypeError');
    expect(modelError['errorMessage']).toBe('model failed');
    expect(modelError['model']).toBe('m');

    const toolError = dataOf(trace, 'tool_error');
    expect(toolError['errorType']).toBe('Error');
    expect(toolError['errorMessage']).toBe('tool failed');
    expect(toolError['toolName']).toBe('my_tool');
    expect((toolError['args'] as Dict)['q']).toBe(1);
  });

  it('skips entries when no beforeRunCallback established state', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    const toolContext = makeToolContext();
    const tool = {name: 'my_tool'} as BaseTool;

    await expect(
      plugin.afterToolCallback({
        tool,
        toolArgs: {},
        toolContext,
        result: {output: 'ok'},
      }),
    ).resolves.toBeUndefined();

    expect(warnCalls.some((m) => m.includes('skipping entry'))).toBe(true);
    // afterRunCallback with no state warns and writes nothing.
    await plugin.afterRunCallback({invocationContext: makeInvocationContext()});
    expect(warnCalls.some((m) => m.includes('skipping write'))).toBe(true);
    await expect(fs.access(outputPath)).rejects.toBeDefined();
  });

  it('serializes diverse content part types and omits binary data', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    const invocationContext = makeInvocationContext();
    const callbackContext = makeCallbackContext();
    await plugin.beforeRunCallback({invocationContext});

    const content = {
      role: 'model',
      parts: [
        {functionCall: {id: 'c1', name: 'fn', args: {a: 1}}},
        {functionResponse: {id: 'c1', name: 'fn', response: {result: 'ok'}}},
        {
          inlineData: {
            mimeType: 'image/png',
            displayName: 'img',
            data: 'BASE64BYTES',
          },
        },
        {fileData: {fileUri: 'gs://b/x', mimeType: 'text/plain'}},
        {codeExecutionResult: {outcome: 'OUTCOME_OK', output: '42'}},
        {executableCode: {language: 'PYTHON', code: 'print(1)'}},
        {thought: true},
      ],
    } as unknown as Content;

    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: {content} as unknown as LlmResponse,
    });
    // Content with no parts hits the `parts ?? []` fallback branch.
    const noPartsEvent = createEvent({
      author: 'agent',
      content: {role: 'user'},
    });
    await plugin.onEventCallback({invocationContext, event: noPartsEvent});
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    const responseContent = dataOf(trace, 'llm_response')['content'] as Dict;
    const parts = responseContent['parts'] as Dict[];
    // The thought-only part yields no keys and is dropped.
    expect(parts).toHaveLength(6);

    const inline = parts.find((p) => p['inlineData'])!['inlineData'] as Dict;
    expect(inline['_dataOmitted']).toBe(true);
    expect(inline['data']).toBeUndefined();
    expect(inline['mimeType']).toBe('image/png');

    const fnResp = parts.find((p) => p['functionResponse'])![
      'functionResponse'
    ] as Dict;
    expect((fnResp['response'] as Dict)['result']).toBe('ok');

    const codeResult = parts.find((p) => p['codeExecutionResult'])![
      'codeExecutionResult'
    ] as Dict;
    expect(codeResult['output']).toBe('42');

    const eventContent = dataOf(trace, 'event')['content'] as Dict;
    expect(eventContent['parts']).toEqual([]);
  });

  it('safely serializes bytes, nested structures, nullish and unserializable values', async () => {
    const plugin = new DebugLoggingPlugin({outputPath});
    const invocationContext = makeInvocationContext();
    const toolContext = makeToolContext();
    const tool = {name: 'my_tool'} as BaseTool;
    await plugin.beforeRunCallback({invocationContext});

    await plugin.beforeToolCallback({
      tool,
      toolArgs: {
        bytes: new Uint8Array([1, 2, 3]),
        list: [1, 'two', true, null],
        nested: {inner: 'value'},
        nothing: null,
        fn: () => 42,
      },
      toolContext,
    });

    // An object whose getter throws degrades to the placeholder.
    const throwing: Dict = {};
    Object.defineProperty(throwing, 'bad', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    await plugin.afterToolCallback({
      tool,
      toolArgs: {},
      toolContext,
      result: {broken: throwing},
    });
    await plugin.afterRunCallback({invocationContext});

    const [trace] = await readTraces(outputPath);
    const args = dataOf(trace, 'tool_call')['args'] as Dict;
    expect(args['bytes']).toBe('<bytes: 3 bytes>');
    expect(args['list']).toEqual([1, 'two', true, null]);
    expect((args['nested'] as Dict)['inner']).toBe('value');
    expect(args['nothing']).toBeNull();
    expect(typeof args['fn']).toBe('string');

    const result = dataOf(trace, 'tool_response')['result'] as Dict;
    expect(result['broken']).toBe('<unserializable>');
  });

  it('does not throw and cleans up state when the file write fails', async () => {
    const blocker = path.join(tempDir, 'blocker');
    await fs.writeFile(blocker, 'x');
    const plugin = new DebugLoggingPlugin({
      outputPath: path.join(blocker, 'debug.jsonl'),
    });
    const invocationContext = makeInvocationContext();

    await plugin.beforeRunCallback({invocationContext});
    await expect(
      plugin.afterRunCallback({invocationContext}),
    ).resolves.toBeUndefined();
    expect(
      errorCalls.some((m) => m.includes('Failed to write debug data')),
    ).toBe(true);

    // State was cleaned up in `finally`, so a second call hits the no-state path.
    await plugin.afterRunCallback({invocationContext});
    expect(warnCalls.some((m) => m.includes('skipping write'))).toBe(true);
  });
});
