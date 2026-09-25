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
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

// Eval-system internal, so deliberately absent from the public barrel.
import {
  addDefaultRetryOptionsIfNotPresent,
  DEFAULT_RETRY_ATTEMPTS,
  EnsureRetryOptionsPlugin,
} from '../../src/evaluation/retry_options_utils.js';

function createLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
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

describe('addDefaultRetryOptionsIfNotPresent', () => {
  it('stamps the default policy onto a request carrying no config', () => {
    const llmRequest = createLlmRequest();

    addDefaultRetryOptionsIfNotPresent(llmRequest);

    expect(llmRequest.config?.httpOptions?.retryOptions).toEqual({
      attempts: DEFAULT_RETRY_ATTEMPTS,
    });
  });

  it('retries seven times by default', () => {
    const llmRequest = createLlmRequest();

    addDefaultRetryOptionsIfNotPresent(llmRequest);

    expect(llmRequest.config?.httpOptions?.retryOptions?.attempts).toBe(7);
  });

  it('stamps the default policy onto a request with no http options', () => {
    const llmRequest = createLlmRequest();
    llmRequest.config = {temperature: 0.5};

    addDefaultRetryOptionsIfNotPresent(llmRequest);

    expect(llmRequest.config.temperature).toBe(0.5);
    expect(llmRequest.config.httpOptions?.retryOptions).toEqual({
      attempts: DEFAULT_RETRY_ATTEMPTS,
    });
  });

  it('leaves an existing policy untouched', () => {
    const llmRequest = createLlmRequest();
    llmRequest.config = {httpOptions: {retryOptions: {attempts: 1}}};

    addDefaultRetryOptionsIfNotPresent(llmRequest);

    expect(llmRequest.config.httpOptions?.retryOptions).toEqual({attempts: 1});
  });

  it('leaves an empty policy untouched rather than filling it in', () => {
    const llmRequest = createLlmRequest();
    llmRequest.config = {httpOptions: {retryOptions: {}}};

    addDefaultRetryOptionsIfNotPresent(llmRequest);

    expect(llmRequest.config.httpOptions?.retryOptions).toEqual({});
  });

  it('gives each request its own policy object', () => {
    const first = createLlmRequest();
    const second = createLlmRequest();

    addDefaultRetryOptionsIfNotPresent(first);
    addDefaultRetryOptionsIfNotPresent(second);
    const firstOptions = first.config?.httpOptions?.retryOptions;
    if (firstOptions === undefined) {
      expect.fail('the first request was not stamped');
    }
    firstOptions.attempts = 2;

    expect(second.config?.httpOptions?.retryOptions?.attempts).toBe(
      DEFAULT_RETRY_ATTEMPTS,
    );
  });
});

describe('EnsureRetryOptionsPlugin', () => {
  it('stamps the request and lets the model call proceed', async () => {
    const plugin = new EnsureRetryOptionsPlugin('ensure_retry_options');
    const llmRequest = createLlmRequest();

    const result = await plugin.beforeModelCallback({
      callbackContext: await createCallbackContext(),
      llmRequest,
    });

    expect(result).toBeUndefined();
    expect(llmRequest.config?.httpOptions?.retryOptions).toEqual({
      attempts: DEFAULT_RETRY_ATTEMPTS,
    });
  });
});
