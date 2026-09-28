/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InMemorySessionService,
  InvocationContext,
  LlmRequest,
  LlmResponse,
  Logger,
  PluginManager,
  getLogger,
  setLogger,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  LLM_REQUEST_ID_KEY,
  MAX_CACHED_REQUESTS,
  RequestIntercepterPlugin,
} from '../../src/evaluation/request_intercepter_plugin.js';

/** Captures the warnings the plugin emits, in place of the ADK logger. */
class RecordingLogger implements Logger {
  readonly warnings: string[] = [];

  log(): void {}
  debug(): void {}
  info(): void {}
  error(): void {}
  setLogLevel(): void {}

  warn(...args: unknown[]): void {
    this.warnings.push(args.join(' '));
  }
}

async function createCallbackContext(): Promise<Context> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'eval_app',
    userId: 'eval_user',
  });
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session,
      pluginManager: new PluginManager(),
    }),
  });
}

function createLlmRequest(text: string): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text}]}],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

describe('RequestIntercepterPlugin', () => {
  let plugin: RequestIntercepterPlugin;
  let callbackContext: Context;
  let recordingLogger: RecordingLogger;
  let previousLogger: Logger;

  beforeEach(async () => {
    plugin = new RequestIntercepterPlugin('test_plugin');
    callbackContext = await createCallbackContext();
    recordingLogger = new RecordingLogger();
    previousLogger = getLogger();
    setLogger(recordingLogger);
  });

  afterEach(() => {
    setLogger(previousLogger);
  });

  it('couples an intercepted request with the response it produced', async () => {
    const llmRequest = createLlmRequest('hello');
    const llmResponse: LlmResponse = {};

    const beforeResult = await plugin.beforeModelCallback({
      callbackContext,
      llmRequest,
    });

    expect(beforeResult).toBeUndefined();
    const requestId = callbackContext.state.get<string>(LLM_REQUEST_ID_KEY);
    expect(typeof requestId).toBe('string');

    const afterResult = await plugin.afterModelCallback({
      callbackContext,
      llmResponse,
    });

    expect(afterResult).toBeUndefined();
    expect(llmResponse.customMetadata).toEqual({
      [LLM_REQUEST_ID_KEY]: requestId,
    });
    expect(plugin.getModelRequest(llmResponse)).toBe(llmRequest);
  });

  it('keeps the metadata the response already carried', async () => {
    const llmResponse: LlmResponse = {customMetadata: {trace: 'abc'}};

    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: createLlmRequest('hello'),
    });
    await plugin.afterModelCallback({callbackContext, llmResponse});

    expect(llmResponse.customMetadata?.['trace']).toBe('abc');
    expect(llmResponse.customMetadata?.[LLM_REQUEST_ID_KEY]).toBeDefined();
  });

  it('leaves the response alone when no request passed through', async () => {
    const llmResponse: LlmResponse = {};

    await plugin.afterModelCallback({callbackContext, llmResponse});

    expect(llmResponse.customMetadata).toBeUndefined();
  });

  it('returns undefined for a response carrying no request id', () => {
    expect(plugin.getModelRequest({})).toBeUndefined();
    expect(
      plugin.getModelRequest({customMetadata: {other: 'value'}}),
    ).toBeUndefined();
    expect(recordingLogger.warnings).toEqual([]);
  });

  it('warns and returns undefined for an unknown request id', () => {
    const result = plugin.getModelRequest({
      customMetadata: {[LLM_REQUEST_ID_KEY]: 'non_existent_id'},
    });

    expect(result).toBeUndefined();
    expect(recordingLogger.warnings).toEqual([
      '`non_existent_id` not found in llm_request_cache.',
    ]);
  });

  it('drops the oldest request once the cache is full', async () => {
    const oldestRequest = createLlmRequest('oldest');
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: oldestRequest,
    });
    const oldestResponse: LlmResponse = {};
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: oldestResponse,
    });
    expect(plugin.getModelRequest(oldestResponse)).toBe(oldestRequest);

    for (let i = 0; i < MAX_CACHED_REQUESTS; i++) {
      await plugin.beforeModelCallback({
        callbackContext,
        llmRequest: createLlmRequest(`filler-${i}`),
      });
    }

    expect(plugin.getModelRequest(oldestResponse)).toBeUndefined();

    const newestResponse: LlmResponse = {};
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: newestResponse,
    });
    expect(plugin.getModelRequest(newestResponse)).toBeDefined();
  });
});
