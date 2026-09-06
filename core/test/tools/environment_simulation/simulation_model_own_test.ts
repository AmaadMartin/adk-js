/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  generateSimulationText,
  stripJsonFence,
} from '../../../src/tools/environment_simulation/simulation_model.js';

import {PARTLESS_SIMULATION_MODEL} from './simulation_test_support.js';

describe('generateSimulationText', () => {
  it('skips the responses and the parts that carry no text', async () => {
    const responseText = await generateSimulationText({
      model: PARTLESS_SIMULATION_MODEL,
      modelConfig: {},
      prompt: 'anything',
    });

    expect(responseText).toBe('{"ok": true}');
  });

  it('reports a model no registry entry matches', async () => {
    await expect(
      generateSimulationText({
        model: 'no-such-simulation-model',
        modelConfig: {},
        prompt: 'anything',
      }),
    ).rejects.toThrow('Model no-such-simulation-model not found.');
  });
});

describe('stripJsonFence', () => {
  it('removes a fence that names a language', () => {
    expect(stripJsonFence('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('removes a fence that names no language', () => {
    expect(stripJsonFence('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('leaves unfenced text alone, apart from trimming it', () => {
    expect(stripJsonFence('  {"a": 1}  ')).toBe('{"a": 1}');
  });

  it('leaves a fence in the middle of the text alone', () => {
    expect(stripJsonFence('{"a": "```json"}')).toBe('{"a": "```json"}');
  });
});
