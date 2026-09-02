/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  addDefaultRetryOptionsIfNotPresent,
  DEFAULT_HTTP_RETRY_ATTEMPTS,
  EnsureRetryOptionsPlugin,
  InMemorySessionService,
  InvocationContext,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {Context} from '../../src/agents/context.js';

function newRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

async function newCallbackContext(): Promise<Context> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'retry_options_app',
    userId: 'retry_options_user',
  });
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv1',
      session,
      pluginManager: new PluginManager([]),
    }),
  });
}

describe('addDefaultRetryOptionsIfNotPresent', () => {
  it('adds the default attempts to a request that carries no config', () => {
    const llmRequest = newRequest();

    addDefaultRetryOptionsIfNotPresent(llmRequest);

    expect(llmRequest.config?.httpOptions?.retryOptions).toEqual({
      attempts: DEFAULT_HTTP_RETRY_ATTEMPTS,
    });
  });

  it('adds the default attempts when httpOptions carries no retryOptions', () => {
    const llmRequest = newRequest();
    llmRequest.config = {httpOptions: {}};

    addDefaultRetryOptionsIfNotPresent(llmRequest);

    expect(llmRequest.config.httpOptions?.retryOptions).toEqual({
      attempts: DEFAULT_HTTP_RETRY_ATTEMPTS,
    });
  });

  it('creates httpOptions on a config that has none', () => {
    const llmRequest = newRequest();
    llmRequest.config = {temperature: 0.5};

    addDefaultRetryOptionsIfNotPresent(llmRequest);

    expect(llmRequest.config.temperature).toBe(0.5);
    expect(llmRequest.config.httpOptions?.retryOptions).toEqual({
      attempts: DEFAULT_HTTP_RETRY_ATTEMPTS,
    });
  });

  it('leaves a retry policy the caller already set alone', () => {
    const llmRequest = newRequest();
    llmRequest.config = {httpOptions: {retryOptions: {attempts: 1}}};

    addDefaultRetryOptionsIfNotPresent(llmRequest);

    expect(llmRequest.config.httpOptions?.retryOptions).toEqual({attempts: 1});
  });

  it('defaults to seven attempts, matching adk-python', () => {
    expect(DEFAULT_HTTP_RETRY_ATTEMPTS).toBe(7);
  });
});

describe('EnsureRetryOptionsPlugin', () => {
  it('completes the request in place and short-circuits nothing', async () => {
    const plugin = new EnsureRetryOptionsPlugin('ensure_retry_options');
    const llmRequest = newRequest();

    const response = await plugin.beforeModelCallback({
      callbackContext: await newCallbackContext(),
      llmRequest,
    });

    expect(response).toBeUndefined();
    expect(llmRequest.config?.httpOptions?.retryOptions).toEqual({
      attempts: DEFAULT_HTTP_RETRY_ATTEMPTS,
    });
  });
});
