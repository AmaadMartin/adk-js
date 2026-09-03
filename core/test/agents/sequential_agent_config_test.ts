/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  InputValidationError,
  parseSequentialAgentYamlConfig,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {sequentialAgentYamlConfigSchema} from '../../src/agents/sequential_agent_config.js';
import {resetDeprecationWarnings} from '../../src/utils/deprecated.js';
import {logger} from '../../src/utils/logger.js';

/** The wording adk-python puts on the deprecated class. */
const DEPRECATION_MESSAGE =
  'SequentialAgentConfig is deprecated and will be removed in future ' +
  'versions. Config is now loaded via reflection so the separate config ' +
  'class is no longer needed.';

function deprecationWarnings(): unknown[][] {
  return vi
    .mocked(logger.warn)
    .mock.calls.filter((call) => call[0] === DEPRECATION_MESSAGE);
}

describe('parseSequentialAgentYamlConfig', () => {
  beforeEach(() => {
    resetDeprecationWarnings();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDeprecationWarnings();
  });

  it('applies the adk-python defaults and leaves the lists absent', () => {
    const config = parseSequentialAgentYamlConfig({name: 's'});

    expect(config).toEqual({
      agentClass: 'SequentialAgent',
      name: 's',
      description: '',
    });
    expect('subAgents' in config).toBe(false);
    expect('beforeAgentCallbacks' in config).toBe(false);
    expect('afterAgentCallbacks' in config).toBe(false);
  });

  it('accepts the on-disk snake_case document and returns camelCase', () => {
    const config = parseSequentialAgentYamlConfig({
      agent_class: 'SequentialAgent',
      name: 'CodePipelineAgent',
      description: 'Executes a sequence of code writing and reviewing.',
      sub_agents: [{config_path: 'code_writer.yaml'}],
      before_agent_callbacks: [{name: 'my_library.callbacks.before'}],
      after_agent_callbacks: [{name: 'my_library.callbacks.after'}],
    });

    expect(config).toEqual({
      agentClass: 'SequentialAgent',
      name: 'CodePipelineAgent',
      description: 'Executes a sequence of code writing and reviewing.',
      subAgents: [{configPath: 'code_writer.yaml'}],
      beforeAgentCallbacks: [{name: 'my_library.callbacks.before'}],
      afterAgentCallbacks: [{name: 'my_library.callbacks.after'}],
    });
  });

  it.each([
    'SequentialAgent',
    'google.adk.agents.SequentialAgent',
    'google.adk.agents.sequential_agent.SequentialAgent',
  ])('keeps the agent_class value %s verbatim', (agentClass) => {
    const config = parseSequentialAgentYamlConfig({
      agent_class: agentClass,
      name: 's',
    });

    expect(config.agentClass).toBe(agentClass);
  });

  it('rejects an unknown key instead of ignoring it', () => {
    expect(() =>
      parseSequentialAgentYamlConfig({name: 's', other_field: 'other value'}),
    ).toThrow(InputValidationError);
    // The camelCase preprocess runs first, so the key is reported camelCased.
    expect(() =>
      parseSequentialAgentYamlConfig({name: 's', other_field: 'other value'}),
    ).toThrow(/otherField/);
  });

  it('rejects a document with no name', () => {
    expect(() =>
      parseSequentialAgentYamlConfig({description: 'no name'}),
    ).toThrow(InputValidationError);
  });

  it.each([
    ['null, which is what an empty YAML file loads as', null],
    ['undefined', undefined],
    ['a string', 'name: s'],
    ['an array', [{name: 's'}]],
    ['a number', 42],
  ])('rejects %s', (_label, document) => {
    expect(() => parseSequentialAgentYamlConfig(document)).toThrow(
      InputValidationError,
    );
  });

  it('prefixes the validation failure with the config name', () => {
    expect(() => parseSequentialAgentYamlConfig({})).toThrow(
      /^Invalid SequentialAgent config: /,
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
      const config = parseSequentialAgentYamlConfig({
        name: 's',
        sub_agents: [ref],
      });

      expect(config.subAgents).toEqual([expected]);
    });

    it('rejects a reference naming neither code nor config_path', () => {
      expect(() =>
        parseSequentialAgentYamlConfig({name: 's', sub_agents: [{}]}),
      ).toThrow(/Exactly one of `code` or `config_path` must be provided/);
    });

    it('rejects a reference naming both code and config_path', () => {
      expect(() =>
        parseSequentialAgentYamlConfig({
          name: 's',
          sub_agents: [{code: 'my_library.agents.a', config_path: 'a.yaml'}],
        }),
      ).toThrow(/Only one of `code` or `config_path` should be provided/);
    });

    it('rejects an unknown key inside a reference', () => {
      expect(() =>
        parseSequentialAgentYamlConfig({
          name: 's',
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
          parseSequentialAgentYamlConfig({name: 's', [key]: [{}]}),
        ).toThrow(InputValidationError);
      },
    );

    it.each(['before_agent_callbacks', 'after_agent_callbacks'])(
      'rejects a %s entry carrying an unknown key',
      (key) => {
        expect(() =>
          parseSequentialAgentYamlConfig({
            name: 's',
            [key]: [{name: 'my_library.callbacks.cb', extra: 'x'}],
          }),
        ).toThrow(InputValidationError);
      },
    );
  });

  it('warns about the deprecation once, not once per call', () => {
    parseSequentialAgentYamlConfig({name: 's'});
    parseSequentialAgentYamlConfig({name: 's'});
    parseSequentialAgentYamlConfig({name: 's'});

    expect(deprecationWarnings()).toEqual([[DEPRECATION_MESSAGE]]);
  });

  it('refuses to parse when the AGENT_CONFIG feature is disabled', async () => {
    await withTemporaryFeatureOverride(FeatureName.AGENT_CONFIG, false, () => {
      expect(() => parseSequentialAgentYamlConfig({name: 's'})).toThrow(
        'Feature AGENT_CONFIG is not enabled.',
      );
    });

    // The deprecation reaches the caller whatever the gate decides.
    expect(deprecationWarnings()).toEqual([[DEPRECATION_MESSAGE]]);
  });

  it('parses when the AGENT_CONFIG feature is left at its default', async () => {
    await withTemporaryFeatureOverride(FeatureName.AGENT_CONFIG, true, () => {
      expect(parseSequentialAgentYamlConfig({name: 's'}).name).toBe('s');
    });
  });
});

describe('sequentialAgentYamlConfigSchema', () => {
  it('reports a bad document through safeParse instead of throwing', () => {
    const result = sequentialAgentYamlConfigSchema.safeParse({name: 42});

    expect(result.success).toBe(false);
  });

  it('parses a good document without the deprecation or feature gate', () => {
    const result = sequentialAgentYamlConfigSchema.safeParse({name: 's'});

    expect(result).toEqual({
      success: true,
      data: {agentClass: 'SequentialAgent', name: 's', description: ''},
    });
  });
});
