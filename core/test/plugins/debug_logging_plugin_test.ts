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
  const debugCalls: string[] = [];
  const warnCalls: string[] = [];
  const errorCalls: string[] = [];
  const mockLogger = {
    setLogLevel: () => {},
    log: () => {},
    debug: (...args: unknown[]) => {
      debugCalls.push(args.map((a) => String(a)).join(' '));
    },
    info: () => {},
    warn: (...args: unknown[]) => {
      warnCalls.push(args.map((a) => String(a)).join(' '));
    },
    error: (...args: unknown[]) => {
      errorCalls.push(args.map((a) => String(a)).join(' '));
    },
  };
  return {mockLogger, debugCalls, warnCalls, errorCalls};
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
  let debugCalls: string[];
  let warnCalls: string[];
  let errorCalls: string[];

  beforeEach(async () => {
    const mock = makeMockLogger();
    debugCalls = mock.debugCalls;
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

    // The plugin's own bookkeeping is logged at debug level, not warn: it must
    // not spam an application's logs.
    expect(debugCalls.some((m) => m.includes('skipping entry'))).toBe(true);
    expect(warnCalls.some((m) => m.includes('skipping entry'))).toBe(false);
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

  describe('callback ordering', () => {
    it('captures the user message when onUserMessageCallback runs first', async () => {
      // `Runner.runAsync` fires onUserMessageCallback *before* beforeRunCallback,
      // which is the reverse of the order the other tests use. The plugin has to
      // create its state lazily so the user message is still recorded, and
      // beforeRunCallback must not then discard it.
      const plugin = new DebugLoggingPlugin({outputPath});
      const invocationContext = makeInvocationContext();

      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {role: 'user', parts: [{text: 'hi there'}]},
      });
      await plugin.beforeRunCallback({invocationContext});
      await plugin.afterRunCallback({invocationContext});

      const [trace] = await readTraces(outputPath);
      expect(entryTypes(trace)).toEqual([
        'user_message',
        'invocation_start',
        'session_state_snapshot',
        'invocation_end',
      ]);
      const content = dataOf(trace, 'user_message')['content'] as Dict;
      expect((content['parts'] as Dict[])[0]['text']).toBe('hi there');
      // No warning is emitted on the normal runner path.
      expect(warnCalls).toEqual([]);
    });

    it('keeps a single state when beforeRunCallback is called twice', async () => {
      const plugin = new DebugLoggingPlugin({outputPath});
      const invocationContext = makeInvocationContext();

      await plugin.beforeRunCallback({invocationContext});
      await plugin.beforeRunCallback({invocationContext});
      await plugin.afterRunCallback({invocationContext});

      const traces = await readTraces(outputPath);
      expect(traces).toHaveLength(1);
      expect(
        entryTypes(traces[0]).filter((t) => t === 'invocation_start'),
      ).toHaveLength(2);
    });
  });

  describe('redaction', () => {
    it('applies the redact hook to every captured payload', async () => {
      const seenEntryTypes: string[] = [];
      const plugin = new DebugLoggingPlugin({
        outputPath,
        redact: (entryType, data) => {
          seenEntryTypes.push(entryType);
          if (entryType === 'tool_call') {
            return {...data, args: '<redacted>'};
          }
          if (entryType === 'session_state_snapshot') {
            return {...data, state: '<redacted>'};
          }
          return data;
        },
      });
      const invocationContext = makeInvocationContext({
        session: {
          id: 'session-1',
          appName: 'test-app',
          userId: 'user-1',
          state: {apiCredential: 'CREDENTIAL-DO-NOT-LOG'},
          events: [],
        },
      });
      const toolContext = makeToolContext();
      const tool = {name: 'my_tool'} as BaseTool;

      await plugin.beforeRunCallback({invocationContext});
      await plugin.beforeToolCallback({
        tool,
        toolArgs: {authToken: 'TOKEN-DO-NOT-LOG'},
        toolContext,
      });
      await plugin.afterRunCallback({invocationContext});

      const raw = await fs.readFile(outputPath, 'utf-8');
      expect(raw).not.toContain('TOKEN-DO-NOT-LOG');
      expect(raw).not.toContain('CREDENTIAL-DO-NOT-LOG');

      const [trace] = await readTraces(outputPath);
      expect(dataOf(trace, 'tool_call')['args']).toBe('<redacted>');
      expect(dataOf(trace, 'session_state_snapshot')['state']).toBe(
        '<redacted>',
      );
      expect(seenEntryTypes).toEqual([
        'invocation_start',
        'tool_call',
        'session_state_snapshot',
        'invocation_end',
      ]);
    });

    it('hands redact the raw, unserialized payload', async () => {
      let observed: unknown;
      const plugin = new DebugLoggingPlugin({
        outputPath,
        redact: (entryType, data) => {
          if (entryType === 'tool_call') {
            observed = data['args'];
          }
          return data;
        },
      });
      const invocationContext = makeInvocationContext();
      const bytes = new Uint8Array([1, 2, 3]);

      await plugin.beforeRunCallback({invocationContext});
      await plugin.beforeToolCallback({
        tool: {name: 'my_tool'} as BaseTool,
        toolArgs: {blob: bytes},
        toolContext: makeToolContext(),
      });
      await plugin.afterRunCallback({invocationContext});

      // The hook sees the real Uint8Array, not the '<bytes: 3 bytes>' marker,
      // so it can make decisions on the actual runtime types.
      expect((observed as Dict)['blob']).toBe(bytes);
      const [trace] = await readTraces(outputPath);
      expect((dataOf(trace, 'tool_call')['args'] as Dict)['blob']).toBe(
        '<bytes: 3 bytes>',
      );
    });

    it('fails closed and drops the payload when redact throws', async () => {
      const plugin = new DebugLoggingPlugin({
        outputPath,
        redact: (entryType, data) => {
          if (entryType === 'tool_call') {
            throw new Error('redactor exploded');
          }
          return data;
        },
      });
      const invocationContext = makeInvocationContext();

      await plugin.beforeRunCallback({invocationContext});
      await plugin.beforeToolCallback({
        tool: {name: 'my_tool'} as BaseTool,
        toolArgs: {authToken: 'TOKEN-DO-NOT-LOG'},
        toolContext: makeToolContext(),
      });
      await plugin.afterRunCallback({invocationContext});

      const raw = await fs.readFile(outputPath, 'utf-8');
      expect(raw).not.toContain('TOKEN-DO-NOT-LOG');

      const [trace] = await readTraces(outputPath);
      expect(dataOf(trace, 'tool_call')).toEqual({_redactionFailed: true});
      expect(errorCalls.some((m) => m.includes('redactor exploded'))).toBe(
        true,
      );
    });

    it('marks the entry when redact returns something that cannot be walked', async () => {
      // A Record whose own enumerable getter throws: `Object.entries` on it
      // fails, so the payload degrades to a placeholder instead of the write
      // blowing up and losing the whole trace.
      const hostile: Dict = {};
      Object.defineProperty(hostile, 'bad', {
        enumerable: true,
        get() {
          throw new Error('nope');
        },
      });
      const plugin = new DebugLoggingPlugin({
        outputPath,
        redact: (entryType, data) =>
          entryType === 'tool_call' ? hostile : data,
      });
      const invocationContext = makeInvocationContext();

      await plugin.beforeRunCallback({invocationContext});
      await plugin.beforeToolCallback({
        tool: {name: 'my_tool'} as BaseTool,
        toolArgs: {authToken: 'TOKEN-DO-NOT-LOG'},
        toolContext: makeToolContext(),
      });
      await plugin.afterRunCallback({invocationContext});

      const raw = await fs.readFile(outputPath, 'utf-8');
      expect(raw).not.toContain('TOKEN-DO-NOT-LOG');
      const [trace] = await readTraces(outputPath);
      expect(dataOf(trace, 'tool_call')).toEqual({
        _unserializable: '<unserializable>',
      });
    });

    it('records payloads unchanged when no redact hook is supplied', async () => {
      const plugin = new DebugLoggingPlugin({outputPath});
      const invocationContext = makeInvocationContext();

      await plugin.beforeRunCallback({invocationContext});
      await plugin.beforeToolCallback({
        tool: {name: 'my_tool'} as BaseTool,
        toolArgs: {query: 'plain'},
        toolContext: makeToolContext(),
      });
      await plugin.afterRunCallback({invocationContext});

      const [trace] = await readTraces(outputPath);
      expect((dataOf(trace, 'tool_call')['args'] as Dict)['query']).toBe(
        'plain',
      );
    });
  });

  describe('output file safety', () => {
    // Windows does not implement POSIX permission bits, so `fs.stat().mode`
    // there does not reflect the 0600 requested at creation.
    it.skipIf(process.platform === 'win32')(
      'creates the trace file and its directory without group or world access',
      async () => {
        const nestedPath = path.join(tempDir, 'nested', 'debug.jsonl');
        const plugin = new DebugLoggingPlugin({outputPath: nestedPath});
        const invocationContext = makeInvocationContext();

        await plugin.beforeRunCallback({invocationContext});
        await plugin.afterRunCallback({invocationContext});

        const fileMode = (await fs.stat(nestedPath)).mode;
        expect(fileMode & 0o077).toBe(0);
        const dirMode = (await fs.stat(path.dirname(nestedPath))).mode;
        expect(dirMode & 0o077).toBe(0);
      },
    );

    it('defaults the output path to the temp dir, not the working directory', async () => {
      const plugin = new DebugLoggingPlugin();
      // `outputPath` is private, so assert on the observable behaviour: the
      // default must not resolve next to the caller's package.json.
      const defaultPath = path.join(os.tmpdir(), 'adk_debug.jsonl');
      expect(path.isAbsolute(defaultPath)).toBe(true);
      expect(defaultPath.startsWith(process.cwd())).toBe(false);
      expect(plugin.name).toBe('debug_logging_plugin');
    });
  });

  describe('bounded output size', () => {
    it('rotates the output file once it would exceed maxOutputBytes', async () => {
      const plugin = new DebugLoggingPlugin({
        outputPath,
        maxOutputBytes: 1000,
        includeSessionState: false,
      });
      const padding = 'p'.repeat(2000);

      for (const id of ['inv-a', 'inv-b']) {
        const invocationContext = makeInvocationContext({invocationId: id});
        await plugin.beforeRunCallback({invocationContext});
        await plugin.beforeToolCallback({
          tool: {name: 'my_tool'} as BaseTool,
          toolArgs: {padding},
          toolContext: makeToolContext({invocationId: id}),
        });
        await plugin.afterRunCallback({invocationContext});
      }

      // The first line pushed the file past the cap, so the second write
      // rotated it away: one invocation per file, and nothing lost.
      const current = await readTraces(outputPath);
      expect(current).toHaveLength(1);
      expect(current[0]['invocationId']).toBe('inv-b');

      const rotated = await readTraces(`${outputPath}.1`);
      expect(rotated).toHaveLength(1);
      expect(rotated[0]['invocationId']).toBe('inv-a');
    });

    it('never rotates when maxOutputBytes is non-positive', async () => {
      const plugin = new DebugLoggingPlugin({
        outputPath,
        maxOutputBytes: 0,
        includeSessionState: false,
      });

      for (const id of ['inv-a', 'inv-b', 'inv-c']) {
        const invocationContext = makeInvocationContext({invocationId: id});
        await plugin.beforeRunCallback({invocationContext});
        await plugin.afterRunCallback({invocationContext});
      }

      expect(await readTraces(outputPath)).toHaveLength(3);
      await expect(fs.access(`${outputPath}.1`)).rejects.toBeDefined();
    });

    it('truncates a single oversized captured string', async () => {
      const plugin = new DebugLoggingPlugin({outputPath});
      const invocationContext = makeInvocationContext();
      const huge = 'x'.repeat(150_000);

      await plugin.beforeRunCallback({invocationContext});
      await plugin.beforeToolCallback({
        tool: {name: 'my_tool'} as BaseTool,
        toolArgs: {huge},
        toolContext: makeToolContext(),
      });
      await plugin.afterRunCallback({invocationContext});

      const [trace] = await readTraces(outputPath);
      const captured = (dataOf(trace, 'tool_call')['args'] as Dict)[
        'huge'
      ] as string;
      expect(captured.startsWith('x'.repeat(100_000))).toBe(true);
      expect(captured.endsWith('...<truncated 50000 chars>')).toBe(true);
    });
  });

  describe('defensive serialization', () => {
    it('records <circular> and still writes the trace for a cyclic payload', async () => {
      const plugin = new DebugLoggingPlugin({outputPath});
      const invocationContext = makeInvocationContext();
      const cyclic: Dict = {name: 'parent'};
      cyclic['self'] = cyclic;

      await plugin.beforeRunCallback({invocationContext});
      await plugin.beforeToolCallback({
        tool: {name: 'my_tool'} as BaseTool,
        toolArgs: {node: cyclic},
        toolContext: makeToolContext(),
      });
      await plugin.afterRunCallback({invocationContext});

      // Before cycle detection this recursed until the stack died and the whole
      // invocation trace was dropped; the trace must survive intact.
      const [trace] = await readTraces(outputPath);
      const node = (dataOf(trace, 'tool_call')['args'] as Dict)['node'] as Dict;
      expect(node['name']).toBe('parent');
      expect(node['self']).toBe('<circular>');
      expect(errorCalls).toEqual([]);
    });

    it('serializes a value shared between siblings rather than calling it circular', async () => {
      const plugin = new DebugLoggingPlugin({outputPath});
      const invocationContext = makeInvocationContext();
      const shared = {id: 'shared'};

      await plugin.beforeRunCallback({invocationContext});
      await plugin.beforeToolCallback({
        tool: {name: 'my_tool'} as BaseTool,
        toolArgs: {left: shared, right: shared},
        toolContext: makeToolContext(),
      });
      await plugin.afterRunCallback({invocationContext});

      const [trace] = await readTraces(outputPath);
      const args = dataOf(trace, 'tool_call')['args'] as Dict;
      expect(args['left']).toEqual({id: 'shared'});
      expect(args['right']).toEqual({id: 'shared'});
    });

    it('degrades a value whose toString throws to the placeholder', async () => {
      const plugin = new DebugLoggingPlugin({outputPath});
      const invocationContext = makeInvocationContext();
      const hostile = () => 42;
      hostile.toString = () => {
        throw new Error('no string for you');
      };

      await plugin.beforeRunCallback({invocationContext});
      await plugin.beforeToolCallback({
        tool: {name: 'my_tool'} as BaseTool,
        toolArgs: {hostile},
        toolContext: makeToolContext(),
      });
      await plugin.afterRunCallback({invocationContext});

      const [trace] = await readTraces(outputPath);
      expect((dataOf(trace, 'tool_call')['args'] as Dict)['hostile']).toBe(
        '<unserializable>',
      );
    });

    it('stops at <max depth> for a pathologically nested payload', async () => {
      const plugin = new DebugLoggingPlugin({outputPath});
      const invocationContext = makeInvocationContext();
      const deep: Dict = {};
      let cursor = deep;
      for (let i = 0; i < 40; i++) {
        const next: Dict = {};
        cursor['next'] = next;
        cursor = next;
      }

      await plugin.beforeRunCallback({invocationContext});
      await plugin.beforeToolCallback({
        tool: {name: 'my_tool'} as BaseTool,
        toolArgs: {deep},
        toolContext: makeToolContext(),
      });
      await plugin.afterRunCallback({invocationContext});

      const [trace] = await readTraces(outputPath);
      let value: unknown = (dataOf(trace, 'tool_call')['args'] as Dict)['deep'];
      let levels = 0;
      while (typeof value === 'object' && value !== null) {
        value = (value as Dict)['next'];
        levels++;
        expect(levels).toBeLessThan(40);
      }
      expect(value).toBe('<max depth>');
    });
  });

  describe('bounded memory', () => {
    it('flushes the oldest invocation as incomplete when the buffer is full', async () => {
      const plugin = new DebugLoggingPlugin({
        outputPath,
        maxBufferedInvocations: 2,
        includeSessionState: false,
      });

      // Two invocations that never reach afterRunCallback, exactly as an
      // aborted or failed run leaves them behind.
      for (const id of ['inv-a', 'inv-b']) {
        await plugin.beforeRunCallback({
          invocationContext: makeInvocationContext({invocationId: id}),
        });
      }
      // Starting a third evicts the oldest instead of growing forever.
      await plugin.beforeRunCallback({
        invocationContext: makeInvocationContext({invocationId: 'inv-c'}),
      });

      const traces = await readTraces(outputPath);
      expect(traces).toHaveLength(1);
      expect(traces[0]['invocationId']).toBe('inv-a');
      // The abandoned run still reaches disk, flagged so a consumer can tell.
      expect(traces[0]['incomplete']).toBe(true);
      expect(entryTypes(traces[0])).toContain('invocation_start');
      expect(warnCalls.some((m) => m.includes('never reached'))).toBe(true);

      // The evicted invocation is gone from memory: a later afterRunCallback
      // for it finds no state.
      await plugin.afterRunCallback({
        invocationContext: makeInvocationContext({invocationId: 'inv-a'}),
      });
      expect(warnCalls.some((m) => m.includes('skipping write'))).toBe(true);
      expect(await readTraces(outputPath)).toHaveLength(1);
    });

    it('still evicts when flushing the incomplete trace fails', async () => {
      const blocker = path.join(tempDir, 'blocker');
      await fs.writeFile(blocker, 'x');
      const plugin = new DebugLoggingPlugin({
        outputPath: path.join(blocker, 'debug.jsonl'),
        maxBufferedInvocations: 1,
      });

      await plugin.beforeRunCallback({
        invocationContext: makeInvocationContext({invocationId: 'inv-a'}),
      });
      // Evicting inv-a cannot write it out, but must not throw or keep it.
      await expect(
        plugin.beforeRunCallback({
          invocationContext: makeInvocationContext({invocationId: 'inv-b'}),
        }),
      ).resolves.toBeUndefined();

      expect(
        errorCalls.some((m) =>
          m.includes('Failed to write incomplete debug data'),
        ),
      ).toBe(true);
    });

    it('tolerates a non-positive maxBufferedInvocations without hanging', async () => {
      const plugin = new DebugLoggingPlugin({
        outputPath,
        maxBufferedInvocations: 0,
        includeSessionState: false,
      });
      const invocationContext = makeInvocationContext();

      await expect(
        plugin.beforeRunCallback({invocationContext}),
      ).resolves.toBeUndefined();
      await plugin.afterRunCallback({invocationContext});

      expect(await readTraces(outputPath)).toHaveLength(1);
    });

    it('does not evict while invocations complete normally', async () => {
      const plugin = new DebugLoggingPlugin({
        outputPath,
        maxBufferedInvocations: 2,
        includeSessionState: false,
      });

      for (const id of ['inv-a', 'inv-b', 'inv-c', 'inv-d']) {
        const invocationContext = makeInvocationContext({invocationId: id});
        await plugin.beforeRunCallback({invocationContext});
        await plugin.afterRunCallback({invocationContext});
      }

      expect(await readTraces(outputPath)).toHaveLength(4);
      expect(warnCalls).toEqual([]);
    });
  });
});
