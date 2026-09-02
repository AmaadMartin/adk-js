/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApigeeLlm,
  BaseLlm,
  Gemini,
  getLogger,
  LlmCapabilities,
  LlmRequest,
  LlmResponse,
  Logger,
} from '@google/adk';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';

const ENTERPRISE_ENV_VAR = 'GOOGLE_GENAI_USE_ENTERPRISE';
/** Consulted as a deprecated fallback when the preferred variable is absent. */
const DEPRECATED_ENTERPRISE_ENV_VAR = 'GOOGLE_GENAI_USE_VERTEXAI';

/** A model id the name-based fallback grants once Vertex AI is on. */
const GRANTED_MODEL = 'gemini-2.5-pro';

/** A model that adds nothing on top of BaseLlm but the required generation. */
class BareLlm extends BaseLlm {
  constructor(model = 'bare-model') {
    super({model});
  }
  override async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    yield {};
  }
}

/**
 * Builds a Gemini that needs no ambient credentials on either backend, so the
 * only environment variable a case varies is the one it is about.
 */
function newGemini(model: string): Gemini {
  return new Gemini({
    model,
    apiKey: 'test-api-key',
    project: 'test-project',
    location: 'test-location',
  });
}

let warn: MockInstance<Logger['warn']>;

beforeEach(() => {
  vi.stubEnv(ENTERPRISE_ENV_VAR, undefined);
  vi.stubEnv(DEPRECATED_ENTERPRISE_ENV_VAR, undefined);
  warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('LlmCapabilities', () => {
  it('holds exactly one capability, denied by default', () => {
    const capabilities = new BareLlm().capabilities;

    expect(Object.keys(capabilities)).toEqual(['outputSchemaAndTools']);
    expect(capabilities.outputSchemaAndTools).toBe(false);
  });

  it('stays out of the serialized model, being a getter', () => {
    const serialized: unknown = JSON.parse(JSON.stringify(new BareLlm()));

    expect(serialized).not.toHaveProperty('capabilities');
  });

  it('is recomputed on every access rather than cached', () => {
    const model = new BareLlm();

    const first = model.capabilities;
    const second = model.capabilities;

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

describe('BaseLlm name-based fallback', () => {
  it('grants a Gemini-named model and warns it to migrate', () => {
    vi.stubEnv(ENTERPRISE_ENV_VAR, '1');
    class GrantedLlm extends BareLlm {}

    expect(
      new GrantedLlm(GRANTED_MODEL).capabilities.outputSchemaAndTools,
    ).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'GrantedLlm relies on name-based detection of outputSchemaAndTools. ' +
        'Override BaseLlm.capabilities to declare it explicitly; this ' +
        'fallback will be removed in a future release.',
    );
  });

  it('warns once per class, not once per access', () => {
    vi.stubEnv(ENTERPRISE_ENV_VAR, '1');
    class RepeatedlyReadLlm extends BareLlm {}
    const model = new RepeatedlyReadLlm(GRANTED_MODEL);

    void model.capabilities;
    void model.capabilities;
    void new RepeatedlyReadLlm(GRANTED_MODEL).capabilities;

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns a second granted class on its own', () => {
    vi.stubEnv(ENTERPRISE_ENV_VAR, '1');
    class FirstGrantedLlm extends BareLlm {}
    class SecondGrantedLlm extends BareLlm {}

    void new FirstGrantedLlm(GRANTED_MODEL).capabilities;
    void new SecondGrantedLlm(GRANTED_MODEL).capabilities;

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      expect.stringContaining('SecondGrantedLlm relies on name-based'),
    );
  });

  const DENIAL_CASES: Array<{
    model: string;
    enterpriseMode: string | undefined;
    why: string;
  }> = [
    {
      model: 'bare-model',
      enterpriseMode: '1',
      why: 'it is not a Gemini id at all',
    },
    {
      model: GRANTED_MODEL,
      enterpriseMode: '0',
      why: 'enterprise mode is off',
    },
    {
      model: GRANTED_MODEL,
      enterpriseMode: undefined,
      why: 'enterprise mode is unset',
    },
    {
      model: 'gemini-1.5-pro',
      enterpriseMode: '1',
      why: 'Gemini 1.x is below the 2.0 floor',
    },
  ];

  for (const {model, enterpriseMode, why} of DENIAL_CASES) {
    const envLabel =
      enterpriseMode === undefined ? 'unset' : `"${enterpriseMode}"`;
    it(`denies "${model}" silently with ${ENTERPRISE_ENV_VAR} ${envLabel}, because ${why}`, () => {
      vi.stubEnv(ENTERPRISE_ENV_VAR, enterpriseMode);
      class DeniedLlm extends BareLlm {}

      expect(new DeniedLlm(model).capabilities.outputSchemaAndTools).toBe(
        false,
      );
      expect(warn).not.toHaveBeenCalled();
    });
  }

  it('is bypassed by a subclass that declares the capability outright', () => {
    vi.stubEnv(ENTERPRISE_ENV_VAR, '1');
    class SelfReportingLlm extends BareLlm {
      override get capabilities(): LlmCapabilities {
        return {outputSchemaAndTools: true};
      }
    }

    expect(
      new SelfReportingLlm('not-a-gemini-model').capabilities
        .outputSchemaAndTools,
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets a subclass force-enable a capability its parent denies', () => {
    class OverridingLlm extends BareLlm {
      override get capabilities(): LlmCapabilities {
        return {...super.capabilities, outputSchemaAndTools: true};
      }
    }

    expect(new OverridingLlm().capabilities.outputSchemaAndTools).toBe(true);
  });
});

describe('Gemini capabilities', () => {
  const GEMINI_CASES: Array<{
    model: string;
    enterpriseMode: string | undefined;
    expected: boolean;
  }> = [
    {model: GRANTED_MODEL, enterpriseMode: '1', expected: true},
    {model: 'gemini-2.5-flash', enterpriseMode: '1', expected: true},
    {model: GRANTED_MODEL, enterpriseMode: '0', expected: false},
    {model: GRANTED_MODEL, enterpriseMode: undefined, expected: false},
  ];

  for (const {model, enterpriseMode, expected} of GEMINI_CASES) {
    const envLabel =
      enterpriseMode === undefined ? 'unset' : `"${enterpriseMode}"`;
    it(`reports ${expected} for "${model}" with ${ENTERPRISE_ENV_VAR} ${envLabel}, without warning`, () => {
      vi.stubEnv(ENTERPRISE_ENV_VAR, enterpriseMode);

      expect(newGemini(model).capabilities.outputSchemaAndTools).toBe(expected);
      expect(warn).not.toHaveBeenCalled();
    });
  }

  it('follows an environment change between two accesses', () => {
    const gemini = newGemini(GRANTED_MODEL);
    expect(gemini.capabilities.outputSchemaAndTools).toBe(false);

    vi.stubEnv(ENTERPRISE_ENV_VAR, '1');

    expect(gemini.capabilities.outputSchemaAndTools).toBe(true);
  });

  it('is inherited by a subclass, which never reaches the fallback', () => {
    vi.stubEnv(ENTERPRISE_ENV_VAR, '1');
    class ExtendedGemini extends Gemini {}

    const extended = new ExtendedGemini({
      model: GRANTED_MODEL,
      apiKey: 'test-api-key',
      project: 'test-project',
      location: 'test-location',
    });

    expect(extended.capabilities.outputSchemaAndTools).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is inherited by ApigeeLlm rather than resolved by the fallback', () => {
    vi.stubEnv(ENTERPRISE_ENV_VAR, '1');
    const apigee = new ApigeeLlm({
      model: `apigee/vertex_ai/${GRANTED_MODEL}`,
      proxyUrl: 'https://proxy.example.com',
      project: 'test-project',
      location: 'test-location',
    });

    void apigee.capabilities;

    expect(warn).not.toHaveBeenCalled();
  });
});
