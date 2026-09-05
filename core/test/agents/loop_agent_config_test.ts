/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  InputValidationError,
  loopAgentYamlConfigSchema,
  parseLoopAgentYamlConfig,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {resetDeprecationWarnings} from '../../src/utils/deprecated.js';
import {logger} from '../../src/utils/logger.js';

/** The wording adk-python puts on the deprecated class. */
const DEPRECATION_MESSAGE =
  'LoopAgentConfig is deprecated and will be removed in future versions. ' +
  'Config is now loaded via reflection so the separate config class is no ' +
  'longer needed.';

function deprecationWarnings(): unknown[][] {
  return vi
    .mocked(logger.warn)
    .mock.calls.filter((call) => call[0] === DEPRECATION_MESSAGE);
}

describe('parseLoopAgentYamlConfig', () => {
  beforeEach(() => {
    resetDeprecationWarnings();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDeprecationWarnings();
  });

  it('applies the adk-python defaults and leaves the optional keys absent', () => {
    const config = parseLoopAgentYamlConfig({name: 'looper'});

    expect(config).toEqual({
      agentClass: 'LoopAgent',
      name: 'looper',
      description: '',
    });
    expect('maxIterations' in config).toBe(false);
    expect('subAgents' in config).toBe(false);
    expect('beforeAgentCallbacks' in config).toBe(false);
    expect('afterAgentCallbacks' in config).toBe(false);
  });

  it('accepts the on-disk snake_case document and returns camelCase', () => {
    const config = parseLoopAgentYamlConfig({
      agent_class: 'LoopAgent',
      name: 'looper',
      description: 'repeats its sub agents',
      max_iterations: 3,
      sub_agents: [{config_path: 'code_writer.yaml'}],
      before_agent_callbacks: [{name: 'my_library.callbacks.before'}],
      after_agent_callbacks: [{name: 'my_library.callbacks.after'}],
    });

    expect(config).toEqual({
      agentClass: 'LoopAgent',
      name: 'looper',
      description: 'repeats its sub agents',
      maxIterations: 3,
      subAgents: [{configPath: 'code_writer.yaml'}],
      beforeAgentCallbacks: [{name: 'my_library.callbacks.before'}],
      afterAgentCallbacks: [{name: 'my_library.callbacks.after'}],
    });
  });

  // Zero is the interesting value: a falsy maxIterations must survive the
  // round trip rather than collapse into "unbounded".
  it.each([3, 0])('carries max_iterations %i through unchanged', (value) => {
    const config = parseLoopAgentYamlConfig({
      name: 'looper',
      max_iterations: value,
    });

    expect(config.maxIterations).toBe(value);
  });

  it.each([
    'LoopAgent',
    'google.adk.agents.LoopAgent',
    'google.adk.agents.loop_agent.LoopAgent',
  ])('keeps the agent_class value %s verbatim', (agentClass) => {
    const config = parseLoopAgentYamlConfig({
      agent_class: agentClass,
      name: 'looper',
    });

    expect(config.agentClass).toBe(agentClass);
  });

  it('rejects an unknown key instead of ignoring it', () => {
    expect(() =>
      parseLoopAgentYamlConfig({name: 'looper', other_field: 'other value'}),
    ).toThrow(InputValidationError);
    // The camelCase preprocess runs first, so the key is reported camelCased.
    expect(() =>
      parseLoopAgentYamlConfig({name: 'looper', other_field: 'other value'}),
    ).toThrow(/otherField/);
  });

  it('rejects the max_iteration typo rather than dropping it', () => {
    expect(() =>
      parseLoopAgentYamlConfig({name: 'looper', max_iteration: 3}),
    ).toThrow(/maxIteration/);
  });

  it('rejects a document with no name', () => {
    expect(() => parseLoopAgentYamlConfig({description: 'no name'})).toThrow(
      InputValidationError,
    );
  });

  it.each([
    ['a string', '3'],
    ['a fraction', 1.5],
  ])('rejects max_iterations given as %s', (_label, value) => {
    expect(() =>
      parseLoopAgentYamlConfig({name: 'looper', max_iterations: value}),
    ).toThrow(InputValidationError);
  });

  it.each([
    ['null, which is what an empty YAML file loads as', null],
    ['undefined', undefined],
    ['a string', 'name: looper'],
    ['an array', [{name: 'looper'}]],
    ['a number', 42],
  ])('rejects %s', (_label, document) => {
    expect(() => parseLoopAgentYamlConfig(document)).toThrow(
      InputValidationError,
    );
  });

  it('prefixes the validation failure with the config name', () => {
    expect(() => parseLoopAgentYamlConfig({})).toThrow(
      /^Invalid LoopAgent config: /,
    );
  });

  describe('sub-agent references', () => {
    it.each([
      ['a config path', {config_path: 'sub.yaml'}, {configPath: 'sub.yaml'}],
      [
        'a code reference',
        {code: 'my_library.agents.my_agent'},
        {code: 'my_library.agents.my_agent'},
      ],
    ])('accepts %s', (_label, ref, expected) => {
      const config = parseLoopAgentYamlConfig({
        name: 'looper',
        sub_agents: [ref],
      });

      expect(config.subAgents).toEqual([expected]);
    });

    it('rejects a reference naming neither code nor config_path', () => {
      expect(() =>
        parseLoopAgentYamlConfig({name: 'looper', sub_agents: [{}]}),
      ).toThrow(/Exactly one of `code` or `config_path` must be provided/);
    });

    it('rejects a reference naming both code and config_path', () => {
      expect(() =>
        parseLoopAgentYamlConfig({
          name: 'looper',
          sub_agents: [{code: 'my_library.agents.a', config_path: 'a.yaml'}],
        }),
      ).toThrow(/Only one of `code` or `config_path` should be provided/);
    });

    it('rejects an unknown key inside a reference', () => {
      expect(() =>
        parseLoopAgentYamlConfig({
          name: 'looper',
          sub_agents: [{config_path: 'sub.yaml', extra: 'x'}],
        }),
      ).toThrow(InputValidationError);
    });
  });

  describe('callback references', () => {
    it.each(['before_agent_callbacks', 'after_agent_callbacks'])(
      'rejects a %s entry with no name',
      (key) => {
        expect(() =>
          parseLoopAgentYamlConfig({name: 'looper', [key]: [{}]}),
        ).toThrow(InputValidationError);
      },
    );

    it.each(['before_agent_callbacks', 'after_agent_callbacks'])(
      'rejects a %s entry carrying an unknown key',
      (key) => {
        expect(() =>
          parseLoopAgentYamlConfig({
            name: 'looper',
            [key]: [{name: 'my_library.callbacks.cb', extra: 'x'}],
          }),
        ).toThrow(InputValidationError);
      },
    );
  });

  it('warns about the deprecation once, not once per call', () => {
    parseLoopAgentYamlConfig({name: 'looper'});
    parseLoopAgentYamlConfig({name: 'looper'});
    parseLoopAgentYamlConfig({name: 'looper'});

    expect(deprecationWarnings()).toEqual([[DEPRECATION_MESSAGE]]);
  });

  it('refuses to parse when the AGENT_CONFIG feature is disabled', async () => {
    await withTemporaryFeatureOverride(FeatureName.AGENT_CONFIG, false, () => {
      expect(() => parseLoopAgentYamlConfig({name: 'looper'})).toThrow(
        'Feature AGENT_CONFIG is not enabled.',
      );
    });

    // The deprecation reaches the caller whatever the gate decides.
    expect(deprecationWarnings()).toEqual([[DEPRECATION_MESSAGE]]);
  });

  it('parses when the AGENT_CONFIG feature is on', async () => {
    await withTemporaryFeatureOverride(FeatureName.AGENT_CONFIG, true, () => {
      expect(parseLoopAgentYamlConfig({name: 'looper'}).name).toBe('looper');
    });
  });
});

describe('loopAgentYamlConfigSchema', () => {
  it('reports a bad document through safeParse instead of throwing', () => {
    const result = loopAgentYamlConfigSchema.safeParse({name: 42});

    expect(result.success).toBe(false);
  });

  it('parses a good document without the deprecation or feature gate', () => {
    const result = loopAgentYamlConfigSchema.safeParse({name: 'looper'});

    expect(result).toEqual({
      success: true,
      data: {agentClass: 'LoopAgent', name: 'looper', description: ''},
    });
  });
});
