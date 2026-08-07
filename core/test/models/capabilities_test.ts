/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApigeeLlm,
  BaseLlm,
  BaseLlmConnection,
  Gemini,
  getLogger,
  LlmCapabilities,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';

const VERTEX_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';
const TEST_API_KEY = 'test-api-key';
const TEST_PROJECT = 'test-project';
const TEST_LOCATION = 'us-central1';

/** A `BaseLlm` subclass that declares nothing, so it reports the defaults. */
class BareLlm extends BaseLlm {
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

/** A `BaseLlm` subclass that grants the capability outright. */
class DeclaredLlm extends BareLlm {
  override get capabilities(): LlmCapabilities {
    return {...super.capabilities, outputSchemaAndTools: true};
  }
}

describe('LlmCapabilities', () => {
  const clearEnv = () => {
    delete process.env[VERTEX_ENV_VAR];
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
    delete process.env['GOOGLE_GENAI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
  };

  /** Selects the Vertex AI backend and supplies the credentials it needs. */
  const useVertexEnv = () => {
    process.env[VERTEX_ENV_VAR] = '1';
    process.env['GOOGLE_CLOUD_PROJECT'] = TEST_PROJECT;
    process.env['GOOGLE_CLOUD_LOCATION'] = TEST_LOCATION;
  };

  beforeEach(clearEnv);

  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  describe('the value object', () => {
    it('holds exactly one readonly boolean field', () => {
      expectTypeOf<LlmCapabilities>().toEqualTypeOf<{
        readonly outputSchemaAndTools: boolean;
      }>();

      const gemini = new Gemini({
        model: 'gemini-2.5-pro',
        apiKey: TEST_API_KEY,
      });

      expect(Object.keys(gemini.capabilities)).toEqual([
        'outputSchemaAndTools',
      ]);
    });

    it('returns a fresh snapshot on every read', () => {
      const llm = new BareLlm({model: 'gemini-2.5-pro'});

      expect(llm.capabilities).not.toBe(llm.capabilities);
      expect(llm.capabilities).toEqual(llm.capabilities);
    });
  });

  describe('BaseLlm defaults', () => {
    it('denies a Gemini-named model, and logs nothing', () => {
      // adk-python resolves this exact combination through a deprecated
      // name-based fallback that grants the capability and warns. adk-js
      // carries no fallback, so the base class reports the default and stays
      // silent.
      useVertexEnv();
      const activeLogger = getLogger();
      const logSpies = [
        vi.spyOn(activeLogger, 'debug'),
        vi.spyOn(activeLogger, 'info'),
        vi.spyOn(activeLogger, 'warn'),
        vi.spyOn(activeLogger, 'error'),
      ];

      const llm = new BareLlm({model: 'gemini-2.5-pro'});

      expect(llm.capabilities.outputSchemaAndTools).toBe(false);
      for (const spy of logSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it('keeps capabilities off the instance and out of its JSON form', () => {
      const llm = new BareLlm({model: 'gemini-2.5-pro'});

      expect(Object.keys(llm)).not.toContain('capabilities');
      expect(JSON.parse(JSON.stringify(llm))).not.toHaveProperty(
        'capabilities',
      );
    });

    it('lets a subclass grant a capability outright', () => {
      const llm = new DeclaredLlm({model: 'not-a-gemini-model'});

      expect(llm.capabilities.outputSchemaAndTools).toBe(true);
    });
  });

  describe('Gemini self-report', () => {
    // The full truth table of the underlying predicate is covered by
    // core/test/utils/output_schema_utils_test.ts. These rows only prove that
    // Gemini reports that predicate.
    it.each([
      {model: 'gemini-2.5-pro', vertex: true, expected: true},
      {model: 'gemini-2.5-pro', vertex: false, expected: false},
      {model: 'not-a-gemini-model', vertex: true, expected: false},
    ])(
      'reports $expected for $model on vertex=$vertex',
      ({model, vertex, expected}) => {
        if (vertex) {
          useVertexEnv();
        }
        const gemini = vertex
          ? new Gemini({model})
          : new Gemini({model, apiKey: TEST_API_KEY});

        expect(gemini.capabilities.outputSchemaAndTools).toBe(expected);
      },
    );

    it('follows a backend variant change on the same instance', () => {
      const gemini = new Gemini({
        model: 'gemini-2.5-pro',
        apiKey: TEST_API_KEY,
      });
      expect(gemini.capabilities.outputSchemaAndTools).toBe(false);

      useVertexEnv();

      expect(gemini.capabilities.outputSchemaAndTools).toBe(true);
    });

    it('follows a model reassignment on the same instance', () => {
      useVertexEnv();
      const gemini = new Gemini({model: 'not-a-gemini-model'});
      expect(gemini.capabilities.outputSchemaAndTools).toBe(false);

      // `readonly` is erased at compile time, so a JavaScript caller can do
      // this. The getter must re-read `this.model` instead of caching it.
      Object.assign(gemini, {model: 'gemini-2.5-pro'});

      expect(gemini.capabilities.outputSchemaAndTools).toBe(true);
    });

    it('denies an apigee-prefixed Gemini id', () => {
      // adk-python's extract_model_name strips the `apigee/` prefix and grants
      // this id; adk-js's extractModelName does not, so the id fails the
      // Gemini test. Pinned as it behaves today, not changed here.
      useVertexEnv();
      const apigee = new ApigeeLlm({
        model: 'apigee/vertex_ai/gemini-2.5-pro',
        proxyUrl: 'https://apigee.example.com/v1',
      });

      expect(apigee.capabilities.outputSchemaAndTools).toBe(false);
    });
  });
});
