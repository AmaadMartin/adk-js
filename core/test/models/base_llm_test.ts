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
import {describe, expect, it} from 'vitest';

class TestLlm extends BaseLlm {
  constructor() {
    super({model: 'test-llm'});
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

const IMPLEMENTED_RESPONSE: LlmResponse = {
  content: {role: 'model', parts: [{text: 'hi'}]},
};

const IMPLEMENTED_CONNECTION = {
  sendHistory: async () => {},
  sendContent: async () => {},
  sendRealtime: async () => {},
  receive: async function* () {},
  close: async () => {},
} satisfies BaseLlmConnection;

/** A model that does not connect, so the BaseLlm default applies. */
class BareLlm extends BaseLlm {
  constructor() {
    super({model: 'bare-model'});
  }
  override async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    yield IMPLEMENTED_RESPONSE;
  }
}

/** A model that connects, so the BaseLlm default does not apply. */
class ImplementedLlm extends BareLlm {
  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return IMPLEMENTED_CONNECTION;
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

describe('BaseLlm default connect', () => {
  const request: LlmRequest = {
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    liveConnectConfig: {},
    toolsDict: {},
  };

  it('rejects, naming the model that does not support it', async () => {
    await expect(new BareLlm().connect(request)).rejects.toThrow(
      'Live connection is not supported for bare-model.',
    );
  });

  it('gives way to a subclass implementation', async () => {
    await expect(new ImplementedLlm().connect(request)).resolves.toBe(
      IMPLEMENTED_CONNECTION,
    );
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
