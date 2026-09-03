/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ParallelAgentYamlConfig,
  parallelAgentYamlConfigSchema,
  parseParallelAgentYamlConfig,
} from '../../src/agents/parallel_agent_config.js';
import {InputValidationError} from '../../src/errors/input_validation_error.js';
import {
  FeatureName,
  FeatureStage,
  getFeatureConfig,
  isFeatureEnabled,
  overrideFeatureEnabled,
} from '../../src/features/feature_registry.js';
import {resetDeprecationWarnings} from '../../src/utils/deprecated.js';
import {logger} from '../../src/utils/logger.js';
import {toJsonSchema} from '../../src/utils/schema.js';

/** Returns the `InputValidationError` a document rejection throws. */
function rejectionOf(document: unknown): InputValidationError {
  try {
    parseParallelAgentYamlConfig(document);
  } catch (error: unknown) {
    if (error instanceof InputValidationError) {
      return error;
    }
    expect.fail(`expected InputValidationError, got ${String(error)}`);
  }
  return expect.fail('expected the document to be rejected');
}

describe('parseParallelAgentYamlConfig', () => {
  beforeEach(() => {
    resetDeprecationWarnings();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    overrideFeatureEnabled(FeatureName.AGENT_CONFIG, undefined);
    vi.restoreAllMocks();
    resetDeprecationWarnings();
  });

  describe('defaults and the discriminator', () => {
    it('defaults agentClass and description when only name is given', () => {
      expect(parseParallelAgentYamlConfig({name: 'research_fanout'})).toEqual({
        agentClass: 'ParallelAgent',
        name: 'research_fanout',
        description: '',
      });
    });

    it.each([
      'ParallelAgent',
      'google.adk.agents.ParallelAgent',
      'my_library.agents.MyParallelAgent',
    ])('keeps the agent_class spelling %s', (agentClass) => {
      const config = parseParallelAgentYamlConfig({
        agent_class: agentClass,
        name: 'a',
      });

      expect(config.agentClass).toBe(agentClass);
    });

    it('rejects a document with no name', () => {
      expect(rejectionOf({agent_class: 'ParallelAgent'}).message).toContain(
        'at name',
      );
    });
  });

  describe('unknown keys', () => {
    it('rejects an unknown top-level key', () => {
      expect(rejectionOf({name: 'a', sub_agent: []}).message).toContain(
        'Unrecognized key: "subAgent"',
      );
    });

    it('rejects maxIterations, which belongs to a loop agent', () => {
      expect(rejectionOf({name: 'a', maxIterations: 3}).message).toContain(
        'Unrecognized key: "maxIterations"',
      );
    });

    it('rejects an unknown key inside a sub-agent entry', () => {
      const error = rejectionOf({
        name: 'a',
        sub_agents: [{config_path: 'a.yaml', agent: 'x'}],
      });

      expect(error.message).toContain('Unrecognized key: "agent"');
      expect(error.message).toContain('at subAgents[0]');
    });

    it('rejects an unknown key inside a callback entry', () => {
      const error = rejectionOf({
        name: 'a',
        before_agent_callbacks: [{name: 'my_library.cb', args: []}],
      });

      expect(error.message).toContain('Unrecognized key: "args"');
      expect(error.message).toContain('at beforeAgentCallbacks[0]');
    });
  });

  describe('key casing', () => {
    const expected: ParallelAgentYamlConfig = {
      agentClass: 'ParallelAgent',
      name: 'research_fanout',
      description: 'Runs two researchers at once.',
      subAgents: [{configPath: 'web_researcher.yaml'}],
      beforeAgentCallbacks: [{name: 'my_library.callbacks.before'}],
      afterAgentCallbacks: [{name: 'my_library.callbacks.after'}],
    };

    it('accepts the snake_case spelling a document on disk uses', () => {
      expect(
        parseParallelAgentYamlConfig({
          agent_class: 'ParallelAgent',
          name: 'research_fanout',
          description: 'Runs two researchers at once.',
          sub_agents: [{config_path: 'web_researcher.yaml'}],
          before_agent_callbacks: [{name: 'my_library.callbacks.before'}],
          after_agent_callbacks: [{name: 'my_library.callbacks.after'}],
        }),
      ).toEqual(expected);
    });

    it('accepts the camelCase spelling and produces the same object', () => {
      expect(parseParallelAgentYamlConfig(expected)).toEqual(expected);
    });
  });

  describe('sub-agent and callback references', () => {
    it('accepts a sub-agent named by config file or by code', () => {
      const config = parseParallelAgentYamlConfig({
        name: 'a',
        sub_agents: [
          {config_path: 'a.yaml'},
          {code: 'my_library.agents.researcher'},
        ],
      });

      expect(config.subAgents).toEqual([
        {configPath: 'a.yaml'},
        {code: 'my_library.agents.researcher'},
      ]);
    });

    it('rejects a sub-agent that sets both code and config_path', () => {
      const error = rejectionOf({
        name: 'a',
        sub_agents: [{config_path: 'a.yaml', code: 'my_library.agents.a'}],
      });

      expect(error.message).toContain(
        'Only one of `code` or `config_path` should be provided',
      );
    });

    it('counts an empty code string as provided, not as absent', () => {
      const error = rejectionOf({
        name: 'a',
        sub_agents: [{config_path: 'a.yaml', code: ''}],
      });

      expect(error.message).toContain(
        'Only one of `code` or `config_path` should be provided',
      );
    });

    it('rejects a sub-agent that sets neither code nor config_path', () => {
      const error = rejectionOf({name: 'a', sub_agents: [{}]});

      expect(error.message).toContain(
        'Exactly one of `code` or `config_path` must be provided',
      );
    });

    it('accepts callbacks named by their fully qualified name', () => {
      const config = parseParallelAgentYamlConfig({
        name: 'a',
        before_agent_callbacks: [{name: 'my_library.callbacks.before'}],
        after_agent_callbacks: [{name: 'my_library.callbacks.after'}],
      });

      expect(config.beforeAgentCallbacks).toEqual([
        {name: 'my_library.callbacks.before'},
      ]);
      expect(config.afterAgentCallbacks).toEqual([
        {name: 'my_library.callbacks.after'},
      ]);
    });

    it('rejects a callback entry with no name', () => {
      expect(
        rejectionOf({name: 'a', after_agent_callbacks: [{}]}).message,
      ).toContain('at afterAgentCallbacks[0].name');
    });
  });

  describe('the error it throws', () => {
    it.each([
      ['null', null],
      ['a string', 'name: a'],
      ['an array', [{name: 'a'}]],
      ['a number', 42],
    ])('rejects %s', (_label, document) => {
      const error = rejectionOf(document);

      expect(error).toBeInstanceOf(InputValidationError);
      expect(error.message).toContain('expected object');
    });

    it('prefixes the message with the config it was validating', () => {
      expect(rejectionOf({}).message).toMatch(
        /^Invalid ParallelAgent config: /,
      );
    });
  });

  describe('deprecation and the feature gate', () => {
    it('logs the deprecation once per process', () => {
      parseParallelAgentYamlConfig({name: 'a'});
      parseParallelAgentYamlConfig({name: 'b'});

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain(
        'ParallelAgentYamlConfig is deprecated',
      );
    });

    it('throws when the AGENT_CONFIG feature is disabled', () => {
      overrideFeatureEnabled(FeatureName.AGENT_CONFIG, false);

      expect(() => parseParallelAgentYamlConfig({name: 'a'})).toThrow(
        'Feature AGENT_CONFIG is not enabled.',
      );
    });

    it('logs the deprecation even when the gate throws', () => {
      overrideFeatureEnabled(FeatureName.AGENT_CONFIG, false);

      expect(() => parseParallelAgentYamlConfig({name: 'a'})).toThrow();
      expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain(
        'ParallelAgentYamlConfig is deprecated',
      );
    });
  });
});

describe('the AGENT_CONFIG feature', () => {
  it('is experimental and on by default, as in adk-python', () => {
    expect(getFeatureConfig(FeatureName.AGENT_CONFIG)).toEqual({
      stage: FeatureStage.EXPERIMENTAL,
      defaultOn: true,
    });
    expect(isFeatureEnabled(FeatureName.AGENT_CONFIG)).toBe(true);
  });
});

describe('parallelAgentYamlConfigSchema', () => {
  it('reports issues without throwing, for a caller that wants them', () => {
    const result = parallelAgentYamlConfigSchema.safeParse({name: 42});

    expect(result.success).toBe(false);
  });

  it('renders a JSON Schema that forbids unknown keys and requires name', () => {
    const document = toJsonSchema(parallelAgentYamlConfigSchema);

    expect(document['additionalProperties']).toBe(false);
    expect(document['required']).toContain('name');
    expect(document['properties']).toMatchObject({
      agentClass: {type: 'string', default: 'ParallelAgent'},
    });
  });
});
