/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  LlmRequest,
  LlmResponse,
  isBaseLlm,
  runWithClientLabel,
  version,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

class TestLlm extends BaseLlm {
  constructor(model = 'test-llm') {
    super({model});
  }
  generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    throw new Error('Not implemented');
  }
  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
  getTrackingHeaders(): Record<string, string> {
    return this.trackingHeaders;
  }
}

class FakeLlm {
  private readonly model: string = 'fake-llm';

  generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    throw new Error('Not implemented');
  }
  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
}

describe('BaseLlm', () => {
  it('should set tracking headers correctly when GOOGLE_CLOUD_AGENT_ENGINE_ID is not set', () => {
    delete process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'];
    const llm = new TestLlm();
    const headers = llm.getTrackingHeaders();
    const expectedValue = `google-adk/${version} gl-typescript/${process.version}`;
    expect(headers['x-goog-api-client']).toEqual(expectedValue);
    expect(headers['user-agent']).toEqual(expectedValue);
  });

  it('should set tracking headers correctly when GOOGLE_CLOUD_AGENT_ENGINE_ID is set', () => {
    process.env['GOOGLE_CLOUD_AGENT_ENGINE_ID'] = 'test-engine';
    const llm = new TestLlm();
    const headers = llm.getTrackingHeaders();
    const expectedValue = `google-adk/${
      version
    }+remote_reasoning_engine gl-typescript/${process.version}`;
    expect(headers['x-goog-api-client']).toEqual(expectedValue);
    expect(headers['user-agent']).toEqual(expectedValue);
  });

  it('should include context client label in tracking headers when run within runWithClientLabel', () => {
    const llm = new TestLlm();
    const customLabel = 'my-custom-label';
    runWithClientLabel(customLabel, () => {
      const headers = llm.getTrackingHeaders();
      expect(headers['x-goog-api-client']).toContain(customLabel);
      expect(headers['user-agent']).toContain(customLabel);
    });
  });
});

describe('isBaseLlm', () => {
  it('should return true for BaseLlm', () => {
    const llm = new TestLlm();
    expect(isBaseLlm(llm)).toBe(true);
  });

  it('should return false for non-BaseLlm', () => {
    expect(isBaseLlm(123)).toBe(false);
  });

  it('should return false for null', () => {
    expect(
      isBaseLlm({
        model: 'test-llm',
      }),
    ).toBe(false);
  });

  it('should return false for FakeLlm instance (not extending BaseLlm)', () => {
    expect(isBaseLlm(new FakeLlm())).toBe(false);
  });
});

describe('BaseLlm.capabilities', () => {
  const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['gemini-2.5-pro', 'true', true],
    ['gemini-2.5-pro', 'false', false],
    ['gemini-1.5-flash', 'true', false],
    ['test-llm', 'true', false],
  ])(
    'reports %s under GOOGLE_GENAI_USE_VERTEXAI=%s as %s',
    (model, vertexEnv, expected) => {
      vi.stubEnv(VERTEX_ENV_VAR, vertexEnv);

      expect(new TestLlm(model).capabilities).toEqual({
        outputSchemaAndTools: expected,
      });
    },
  );
});
