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

/** A model that adds nothing on top of BaseLlm, so the defaults apply. */
class BareLlm extends BaseLlm {
  constructor() {
    super({model: 'bare-model'});
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

/** A model that implements both transports, so neither default applies. */
class ImplementedLlm extends BaseLlm {
  constructor() {
    super({model: 'implemented-model'});
  }
  override async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    yield IMPLEMENTED_RESPONSE;
  }
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

describe('BaseLlm defaults for unimplemented transports', () => {
  const request: LlmRequest = {
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    liveConnectConfig: {},
    toolsDict: {},
  };

  it('rejects connect, naming the model that does not support it', async () => {
    await expect(new BareLlm().connect(request)).rejects.toThrow(
      'Live connection is not supported for bare-model.',
    );
  });

  it('throws from generateContentAsync only once it is iterated', async () => {
    const generator = new BareLlm().generateContentAsync(request);

    await expect(generator.next()).rejects.toThrow(
      'Async generation is not supported for bare-model.',
    );
  });

  it('keeps a subclass implementation of either transport', async () => {
    const llm = new ImplementedLlm();

    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(request)) {
      responses.push(response);
    }

    expect(responses).toEqual([IMPLEMENTED_RESPONSE]);
    await expect(llm.connect(request)).resolves.toBe(IMPLEMENTED_CONNECTION);
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
