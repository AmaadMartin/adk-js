/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isGemini2OrAbove, isGemini3xFlashLive} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  extractModelName,
  isGemini1Model,
  isGeminiEapOr2OrAbove,
  isGeminiModel,
} from '../../src/utils/model_name.js';

describe('extractModelName', () => {
  describe('simple model names', () => {
    const simpleNames = [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-1.0-pro',
      'claude-3-sonnet',
      'gpt-4',
    ];

    for (const model of simpleNames) {
      it(`should return the input unchanged for: ${model}`, () => {
        expect(extractModelName(model)).toBe(model);
      });
    }
  });

  describe('Vertex AI publisher paths', () => {
    const vertexPaths: Array<[string, string]> = [
      [
        'projects/265104255505/locations/us-central1/publishers/google/models/gemini-2.5-flash',
        'gemini-2.5-flash',
      ],
      [
        'projects/12345/locations/us-east1/publishers/google/models/gemini-1.5-pro-preview',
        'gemini-1.5-pro-preview',
      ],
      [
        'projects/test-project/locations/europe-west1/publishers/google/models/claude-3-sonnet',
        'claude-3-sonnet',
      ],
      [
        'projects/my-test-project/locations/us-central1/publishers/google/models/gemini-1.5-pro',
        'gemini-1.5-pro',
      ],
    ];

    for (const [modelString, expected] of vertexPaths) {
      it(`should extract "${expected}" from: ${modelString}`, () => {
        expect(extractModelName(modelString)).toBe(expected);
      });
    }
  });

  describe('Apigee paths', () => {
    const apigeePaths: Array<[string, string]> = [
      ['apigee/gemini-2.5-flash', 'gemini-2.5-flash'],
      ['apigee/v1/gemini-2.5-flash', 'gemini-2.5-flash'],
      ['apigee/gemini/gemini-2.5-flash', 'gemini-2.5-flash'],
      ['apigee/vertex_ai/gemini-2.5-flash', 'gemini-2.5-flash'],
      ['apigee/gemini/v1/gemini-2.5-flash', 'gemini-2.5-flash'],
      ['apigee/vertex_ai/v1beta/gemini-2.5-flash', 'gemini-2.5-flash'],
      ['apigee/vertex_ai/v1beta/claude-3-sonnet', 'claude-3-sonnet'],
      ['apigee/a/b/c/gemini-2.5-flash', 'c/gemini-2.5-flash'],
    ];

    for (const [modelString, expected] of apigeePaths) {
      it(`should extract "${expected}" from: ${modelString}`, () => {
        expect(extractModelName(modelString)).toBe(expected);
      });
    }
  });

  describe('"models/" prefixed names', () => {
    const prefixedNames: Array<[string, string]> = [
      ['models/gemini-2.5-pro', 'gemini-2.5-pro'],
      ['models/gemini-2.5-flash', 'gemini-2.5-flash'],
      ['models/claude-3-sonnet', 'claude-3-sonnet'],
    ];

    for (const [modelString, expected] of prefixedNames) {
      it(`should extract "${expected}" from: ${modelString}`, () => {
        expect(extractModelName(modelString)).toBe(expected);
      });
    }
  });

  describe('provider-prefixed names', () => {
    const providerPrefixed: Array<[string, string]> = [
      ['gemini/gemini-2.5-flash', 'gemini-2.5-flash'],
      ['vertex_ai/gemini-2.5-flash', 'gemini-2.5-flash'],
      ['openrouter/google/gemini-2.5-pro:online', 'gemini-2.5-pro:online'],
      ['openrouter/google/gemini-1.5-pro:online', 'gemini-1.5-pro:online'],
      [
        'openrouter/anthropic/claude-sonnet-4',
        'openrouter/anthropic/claude-sonnet-4',
      ],
    ];

    for (const [modelString, expected] of providerPrefixed) {
      it(`should extract "${expected}" from: ${modelString}`, () => {
        expect(extractModelName(modelString)).toBe(expected);
      });
    }
  });

  describe('malformed or unrecognised strings', () => {
    const unchanged = [
      'projects/invalid/path/format',
      'invalid/path/format',
      // Missing the 'publishers' segment.
      'projects/123/locations/us-central1/models/gemini-2.5-flash',
      // Missing the 'locations' segment.
      'projects/123/publishers/google/models/gemini-2.5-flash',
      // Missing the 'models' segment: the 'projects/' guard must return this
      // before the provider-prefix branch reads the trailing Gemini id.
      'projects/123/locations/us-central1/publishers/google/gemini-2.5-flash',
      'openai/gpt-4',
    ];

    for (const modelString of unchanged) {
      it(`should return the input unchanged for: ${modelString}`, () => {
        expect(extractModelName(modelString)).toBe(modelString);
      });
    }
  });

  it('should return an empty string for an empty string', () => {
    expect(extractModelName('')).toBe('');
  });
});

describe('isGeminiModel', () => {
  describe('extended model id forms', () => {
    const geminiModels = [
      'gemini/gemini-2.5-flash',
      'vertex_ai/gemini-2.5-flash',
      'openrouter/google/gemini-2.5-pro:online',
      'models/gemini-2.5-pro',
      'apigee/vertex_ai/gemini-2.5-flash',
    ];

    for (const model of geminiModels) {
      it(`should return true for model: ${model}`, () => {
        expect(isGeminiModel(model)).toBe(true);
      });
    }

    const nonGeminiModels = [
      'openrouter/anthropic/claude-sonnet-4',
      'openai/gpt-4',
      'apigee/vertex_ai/v1beta/claude-3-sonnet',
      'projects/265104255505/locations/us-central1/publishers/gemini/models/claude-3-sonnet',
    ];

    for (const model of nonGeminiModels) {
      it(`should return false for model: ${model}`, () => {
        expect(isGeminiModel(model)).toBe(false);
      });
    }
  });
});

describe('isGemini1Model', () => {
  describe('extended model id forms', () => {
    it('should return true for a provider-prefixed Gemini 1.x model', () => {
      expect(isGemini1Model('openrouter/google/gemini-1.5-pro:online')).toBe(
        true,
      );
      expect(isGemini1Model('models/gemini-1.5-pro')).toBe(true);
    });

    it('should return false for a provider-prefixed Gemini 2.x model', () => {
      expect(isGemini1Model('gemini/gemini-2.5-flash')).toBe(false);
    });
  });

  describe('version boundary', () => {
    const gemini1Models = [
      'gemini-1.5-flash',
      'gemini-1.0-pro',
      'gemini-1.5-pro-preview',
      'gemini-1.9-experimental',
      'projects/12345/locations/us-east1/publishers/google/models/gemini-1.0-pro-preview',
      'gemini/gemini-1.5-flash',
    ];

    for (const model of gemini1Models) {
      it(`should return true for model: ${model}`, () => {
        expect(isGemini1Model(model)).toBe(true);
      });
    }

    const nonGemini1Models = [
      // A double-digit major must not be read as Gemini 1.x.
      'gemini-10.0-pro',
      'gemini-10-flash',
      // The dotted minor version is mandatory.
      'gemini-1',
      'gemini-1-pro',
      'gemini-1.',
      'gemini-2.5-flash',
      'claude-3-sonnet',
      'my-gemini-1.5-model',
      '',
    ];

    for (const model of nonGemini1Models) {
      it(`should return false for model: ${model || '<empty string>'}`, () => {
        expect(isGemini1Model(model)).toBe(false);
      });
    }
  });
});

describe('isGemini2OrAbove', () => {
  describe('valid models', () => {
    const validModels = [
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
      'gemini-3-pro-image-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash-image',
      'gemini-2.5-flash',
      'gemini-2.5-flash-preview-09-2025',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash-lite-preview-09-2025',
      'gemini-2.0-flash-001',
      'gemini-2.0-flash-lite-001',
      'gemini-live-2.5-flash-native-audio',
    ];

    for (const model of validModels) {
      it(`should return true for model: ${model}`, () => {
        expect(isGemini2OrAbove(model)).toBe(true);
      });
    }
  });

  describe('invalid models', () => {
    const invalidModels = [
      'veo-3.1-generate-001',
      'veo-3.0-fast-generate-001',
      'imagen-4.0-ultra-generate-001',
      'imagen-3.0-generate-001',
      'deepseek-ocr-maas',
      'kimi-k2-thinking-maas',
      'llama-4-scout-17b-16e-instruct-maas',
      'minimax-m2-maas',
      'gpt-oss-120b-maas',
      'qwen3-next-80b-a3b-instruct-maas',
      'gemini-1.5-pro',
      'gemini-1.0-pro',
    ];

    for (const model of invalidModels) {
      it(`should return false for model: ${model}`, () => {
        expect(isGemini2OrAbove(model)).toBe(false);
      });
    }
  });

  describe('EAP models', () => {
    const eapModels = [
      'gemini-flash-early-exp',
      'gemini-flash-early-exp3',
      'gemini-flash-lite-early-exp',
      'projects/my-project/locations/us-central1/publishers/google/models/gemini-flash-early-exp',
    ];

    for (const model of eapModels) {
      it(`should return false for EAP model: ${model}`, () => {
        expect(isGemini2OrAbove(model)).toBe(false);
      });
    }
  });
});

describe('isGeminiEapOr2OrAbove', () => {
  describe('EAP models', () => {
    const eapModels = [
      'gemini-flash-early-exp',
      'gemini-flash-early-exp3',
      'gemini-flash-early-exp12',
      'gemini-flash-lite-early-exp',
      'gemini-pro-early-exp',
      'gemini-flash_lite-early-exp',
      'projects/my-project/locations/us-central1/publishers/google/models/gemini-flash-early-exp',
    ];

    for (const model of eapModels) {
      it(`should return true for EAP model: ${model}`, () => {
        expect(isGeminiEapOr2OrAbove(model)).toBe(true);
      });
    }

    const nonEapModels = [
      'gemini-flash-early',
      'gemini-early-exp-flash',
      'gemini-early-exp',
      'gemini-flash-early-exp-001',
      'gemini-Flash-early-exp',
      'my-gemini-flash-early-exp',
      'claude-3.7-sonnet',
    ];

    for (const model of nonEapModels) {
      it(`should return false for non-EAP model: ${model}`, () => {
        expect(isGeminiEapOr2OrAbove(model)).toBe(false);
      });
    }

    it('should not let the EAP pattern reclassify a Gemini 1.x model', () => {
      // The EAP character class excludes '.', so a 1.x name carrying the
      // suffix cannot match and stays below the 2.0 bar.
      expect(isGeminiEapOr2OrAbove('gemini-1.5-flash-early-exp')).toBe(false);
    });

    const eapPathForms = [
      'models/gemini-flash-early-exp',
      'apigee/gemini-flash-early-exp',
      'gemini/gemini-flash-early-exp',
    ];

    for (const model of eapPathForms) {
      it(`should return true for EAP model in path form: ${model}`, () => {
        expect(isGeminiEapOr2OrAbove(model)).toBe(true);
      });
    }
  });

  describe('numeric versions', () => {
    const validModels = [
      'gemini-2',
      'gemini-2-pro',
      'gemini-2.5-flash',
      'gemini-3.0-pro',
      'projects/12345/locations/us-east1/publishers/google/models/gemini-2.5-pro-preview',
      'models/gemini-2.5-pro',
      'apigee/v1/gemini-2.5-flash',
      'gemini/gemini-2.5-flash',
      'openrouter/google/gemini-2.5-pro:online',
    ];

    for (const model of validModels) {
      it(`should return true for model: ${model}`, () => {
        expect(isGeminiEapOr2OrAbove(model)).toBe(true);
      });
    }

    const invalidModels = [
      'gemini-1.5-flash',
      'gemini-1.0-pro',
      'openrouter/google/gemini-1.5-pro:online',
      'gemini-2.',
      'gemini-0.9-test',
      'gemini-one',
      'claude-3-sonnet',
      '',
      'my-gemini-2.5-model',
    ];

    for (const model of invalidModels) {
      it(`should return false for model: ${model || '<empty string>'}`, () => {
        expect(isGeminiEapOr2OrAbove(model)).toBe(false);
      });
    }
  });
});

describe('isGemini2OrAbove with extended model id forms', () => {
  const validModels = [
    'gemini/gemini-2.5-flash',
    'vertex_ai/gemini-2.5-flash',
    'openrouter/google/gemini-2.5-pro:online',
    'models/gemini-2.5-pro',
    'apigee/gemini-2.5-flash',
    'apigee/vertex_ai/v1beta/gemini-2.5-flash',
  ];

  for (const model of validModels) {
    it(`should return true for model: ${model}`, () => {
      expect(isGemini2OrAbove(model)).toBe(true);
    });
  }

  const invalidModels = [
    'openrouter/google/gemini-1.5-pro:online',
    'openai/gpt-4',
    'openrouter/anthropic/claude-sonnet-4',
    // Malformed Vertex path: the trailing segment must not be read as an id.
    'projects/123/locations/us-central1/publishers/google/gemini-2.5-flash',
  ];

  for (const model of invalidModels) {
    it(`should return false for model: ${model}`, () => {
      expect(isGemini2OrAbove(model)).toBe(false);
    });
  }
});

describe('classification consistency', () => {
  const allModels = [
    'gemini-1.5-flash',
    'gemini-2.5-flash',
    'gemini-3.0-pro',
    'gemini-flash-early-exp',
    'gemini/gemini-2.5-flash',
    'openrouter/google/gemini-2.5-pro:online',
    'apigee/gemini-2.5-flash',
    'models/gemini-2.5-pro',
    'claude-3-sonnet',
    'gpt-4',
  ];

  it('should never classify a model as both Gemini 1.x and Gemini EAP/2+', () => {
    expect(
      allModels.filter(
        (model) => isGemini1Model(model) && isGeminiEapOr2OrAbove(model),
      ),
    ).toEqual([]);
  });

  it('should classify every version-matched model as a Gemini model', () => {
    const versionMatched = allModels.filter(
      (model) => isGemini1Model(model) || isGeminiEapOr2OrAbove(model),
    );

    expect(versionMatched.length).toBeGreaterThan(0);
    expect(versionMatched.filter((model) => !isGeminiModel(model))).toEqual([]);
  });

  const bareNames = [
    'gemini-1.5-flash',
    'gemini-2.5-flash',
    'gemini-3.0-pro',
    'claude-3-sonnet',
  ];

  for (const bareName of bareNames) {
    it(`should classify the bare and path forms of ${bareName} identically`, () => {
      const pathForm = `projects/12345/locations/us-central1/publishers/google/models/${bareName}`;

      expect(isGeminiModel(pathForm)).toBe(isGeminiModel(bareName));
      expect(isGemini1Model(pathForm)).toBe(isGemini1Model(bareName));
      expect(isGeminiEapOr2OrAbove(pathForm)).toBe(
        isGeminiEapOr2OrAbove(bareName),
      );
    });
  }
});

describe('isGemini3xFlashLive', () => {
  it('should return true for valid Gemini 3.x Flash Live models', () => {
    expect(isGemini3xFlashLive('gemini-3.1-flash-live')).toBe(true);
    expect(isGemini3xFlashLive('gemini-3.1-flash-live-preview')).toBe(true);
    expect(isGemini3xFlashLive('gemini-3.5-flash-live')).toBe(true);
    expect(isGemini3xFlashLive('gemini-3.5-flash-live-preview')).toBe(true);
    expect(
      isGemini3xFlashLive(
        'projects/my-project/locations/us-central1/publishers/google/models/gemini-3.1-flash-live-001',
      ),
    ).toBe(true);
    expect(
      isGemini3xFlashLive(
        'projects/my-project/locations/us-central1/publishers/google/models/gemini-3.5-flash-live-001',
      ),
    ).toBe(true);
  });

  it('should return false for other models', () => {
    expect(isGemini3xFlashLive('gemini-2.5-flash')).toBe(false);
    expect(isGemini3xFlashLive('gemini-3.0-flash')).toBe(false);
    expect(isGemini3xFlashLive(undefined)).toBe(false);
    expect(isGemini3xFlashLive('')).toBe(false);
  });
});
