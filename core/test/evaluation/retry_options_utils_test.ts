/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  DEFAULT_HTTP_RETRY_OPTIONS,
  EnsureRetryOptionsPlugin,
  InvocationContext,
  LlmRequest,
  addDefaultRetryOptionsIfNotPresent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function makeLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

function makeCallbackContext(): Context {
  const invocationContext = {
    session: {state: {}},
    abortSignal: undefined,
  } as unknown as InvocationContext;
  return new Context({invocationContext});
}

describe('addDefaultRetryOptionsIfNotPresent', () => {
  it('adds defaults when config is undefined', () => {
    const request = makeLlmRequest();
    addDefaultRetryOptionsIfNotPresent(request);
    expect(request.config).toBeDefined();
    expect(request.config?.httpOptions).toBeDefined();
    expect(request.config?.httpOptions?.retryOptions).toEqual(
      DEFAULT_HTTP_RETRY_OPTIONS,
    );
  });

  it('adds httpOptions and retry options when config has no httpOptions', () => {
    const request = makeLlmRequest();
    request.config = {};
    addDefaultRetryOptionsIfNotPresent(request);
    expect(request.config.httpOptions?.retryOptions).toEqual(
      DEFAULT_HTTP_RETRY_OPTIONS,
    );
  });

  it('fills retry options when httpOptions.retryOptions is undefined', () => {
    const request = makeLlmRequest();
    request.config = {httpOptions: {}};
    addDefaultRetryOptionsIfNotPresent(request);
    expect(request.config.httpOptions?.retryOptions).toEqual(
      DEFAULT_HTTP_RETRY_OPTIONS,
    );
  });

  it('does not override existing retry options', () => {
    const myRetryOptions = {attempts: 1};
    const request = makeLlmRequest();
    request.config = {httpOptions: {retryOptions: myRetryOptions}};
    addDefaultRetryOptionsIfNotPresent(request);
    expect(request.config.httpOptions?.retryOptions).toBe(myRetryOptions);
  });
});

describe('EnsureRetryOptionsPlugin', () => {
  it('adds default retry options in beforeModelCallback', async () => {
    const request = makeLlmRequest();
    const plugin = new EnsureRetryOptionsPlugin('test_plugin');

    const result = await plugin.beforeModelCallback({
      callbackContext: makeCallbackContext(),
      llmRequest: request,
    });

    expect(result).toBeUndefined();
    expect(request.config?.httpOptions?.retryOptions).toEqual(
      DEFAULT_HTTP_RETRY_OPTIONS,
    );
  });
});
