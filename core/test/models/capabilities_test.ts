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

// The fallback's warn-once registry is module-global and keyed by class name,
// so a class that warns in one test must not be reused by another.

/** Reaches the fallback and is granted the capability by it. */
class FallbackGrantLlm extends BareLlm {}

/** A second granted subclass, proving the registry key is the class name. */
class OtherFallbackGrantLlm extends BareLlm {}

/** Declares every field outright, so it never reaches the fallback. */
class OutrightLlm extends BareLlm {
  override get capabilities(): LlmCapabilities {
    return {outputSchemaAndTools: true};
  }
}

/** Stands in for `ApigeeLlm`, which cannot carry a bare Gemini model id. */
class InheritingGeminiLlm extends Gemini {}

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

  /** Silences the fallback's warning and captures its calls. */
  const spyOnWarn = () =>
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});

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

  describe('the deprecated name-based fallback', () => {
    it('grants a Gemini-named model on Vertex AI, and warns once', () => {
      // A model that does not override `capabilities` keeps resolving from its
      // name, which is how it behaved before `capabilities` existed.
      useVertexEnv();
      const warn = spyOnWarn();
      const llm = new FallbackGrantLlm({model: 'gemini-2.5-pro'});

      expect(llm.capabilities.outputSchemaAndTools).toBe(true);
      expect(llm.capabilities.outputSchemaAndTools).toBe(true);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('FallbackGrantLlm');
    });

    it('warns again for a different subclass', () => {
      useVertexEnv();
      const warn = spyOnWarn();

      expect(
        new OtherFallbackGrantLlm({model: 'gemini-2.5-pro'}).capabilities
          .outputSchemaAndTools,
      ).toBe(true);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('OtherFallbackGrantLlm');
    });

    it.each([
      {
        model: 'not-a-gemini-model',
        vertexEnv: '1',
        why: 'it is not a Gemini model',
      },
      {
        model: 'gemini-2.5-pro',
        vertexEnv: undefined,
        why: 'the Gemini API variant is the default',
      },
      {
        model: 'gemini-2.5-pro',
        vertexEnv: 'false',
        why: 'the variant is not Vertex AI',
      },
      {
        model: 'gemini-1.5-pro',
        vertexEnv: '1',
        why: 'adk-js requires major version 2 or above, unlike adk-python',
      },
    ])(
      'denies "$model" and stays silent, because $why',
      ({model, vertexEnv}) => {
        if (vertexEnv !== undefined) {
          process.env[VERTEX_ENV_VAR] = vertexEnv;
        }
        const warn = spyOnWarn();

        expect(new BareLlm({model}).capabilities.outputSchemaAndTools).toBe(
          false,
        );
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it('is bypassed by a subclass that declares the capability outright', () => {
      useVertexEnv();
      const warn = spyOnWarn();

      expect(
        new OutrightLlm({model: 'gemini-2.5-pro'}).capabilities
          .outputSchemaAndTools,
      ).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('BaseLlm defaults', () => {
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

    it('declares the capability instead of reaching the fallback', () => {
      // The fallback grants this same combination, so only the absence of its
      // warning separates a declaration from a fallback.
      useVertexEnv();
      const warn = spyOnWarn();

      expect(
        new Gemini({model: 'gemini-2.5-pro'}).capabilities.outputSchemaAndTools,
      ).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it('passes the declaration down to a subclass', () => {
      // `ApigeeLlm extends Gemini` relies on this and adds no override.
      useVertexEnv();
      const warn = spyOnWarn();

      expect(
        new InheritingGeminiLlm({model: 'gemini-2.5-pro'}).capabilities
          .outputSchemaAndTools,
      ).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

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
