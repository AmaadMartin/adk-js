/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

// This helper is intentionally internal (not part of the public API), so it and
// the LlmRequest type are imported via relative paths rather than the
// `@google/adk` entry point.
import {addDefaultRetryOptionsIfNotPresent} from '../../src/evaluation/retry_options_utils.js';
import {LlmRequest} from '../../src/models/llm_request.js';

describe('addDefaultRetryOptionsIfNotPresent', () => {
  it('adds default retry options when config is absent', () => {
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };
    addDefaultRetryOptionsIfNotPresent(request);
    expect(request.config?.httpOptions?.retryOptions).toEqual({attempts: 7});
  });

  it('does not overwrite existing retry options', () => {
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
      config: {httpOptions: {retryOptions: {attempts: 3}}},
    };
    addDefaultRetryOptionsIfNotPresent(request);
    expect(request.config?.httpOptions?.retryOptions).toEqual({attempts: 3});
  });
});
