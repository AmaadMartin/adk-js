/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  InputValidationError,
  parseBaseAgentYamlConfig,
  withTemporaryFeatureOverride,
} from '@google/adk';
import yaml from 'js-yaml';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {resetDeprecationWarnings} from '../../src/utils/deprecated.js';
import {logger} from '../../src/utils/logger.js';

const DEPRECATION_REASON =
  'BaseAgentYamlConfig is deprecated and will be removed in future versions. ' +
  'Config is now loaded via reflection so the separate config class is no ' +
  'longer needed.';

/** Runs `run`, and returns the error it threw. */
function caught(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    expect.fail(`expected an Error, got ${String(error)}`);
  }
  expect.fail('expected a throw, got a value');
}

describe('parseBaseAgentYamlConfig', () => {
  beforeEach(() => {
    resetDeprecationWarnings();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDeprecationWarnings();
  });

  it('applies the documented defaults to a minimal document', () => {
    const config = parseBaseAgentYamlConfig({name: 'code_pipeline_agent'});

    expect(config.agentClass).toBe('BaseAgent');
    expect(config.description).toBe('');
    expect(config.subAgents).toBeUndefined();
    expect(config.beforeAgentCallbacks).toBeUndefined();
    expect(config.afterAgentCallbacks).toBeUndefined();
  });

  it('keeps a custom agent class and the keys it does not know', () => {
    const config = parseBaseAgentYamlConfig({
      agent_class: 'my_library.agents.MyCustomAgent',
      name: 'code_pipeline_agent',
      other_field: 'other value',
    });

    expect(config.agentClass).toBe('my_library.agents.MyCustomAgent');
    expect(config['otherField']).toBe('other value');
  });

  it('parses a full snake_case document and keeps the callback order', () => {
    const config = parseBaseAgentYamlConfig({
      name: 'code_pipeline_agent',
      description: 'Writes, reviews and refactors code.',
      sub_agents: [
        {config_path: 'sub_agents/writer.yaml'},
        {code: 'my_library.custom_agents.reviewer_agent'},
      ],
      before_agent_callbacks: [
        {name: 'my_library.security_callbacks.first'},
        {name: 'my_library.security_callbacks.second'},
      ],
      after_agent_callbacks: [{name: 'my_library.audit_callbacks.record'}],
    });

    expect(config.description).toBe('Writes, reviews and refactors code.');
    expect(config.subAgents?.[0].configPath).toBe('sub_agents/writer.yaml');
    expect(config.subAgents?.[1].code).toBe(
      'my_library.custom_agents.reviewer_agent',
    );
    expect(config.beforeAgentCallbacks?.map((cb) => cb.name)).toEqual([
      'my_library.security_callbacks.first',
      'my_library.security_callbacks.second',
    ]);
    expect(config.afterAgentCallbacks?.map((cb) => cb.name)).toEqual([
      'my_library.audit_callbacks.record',
    ]);
  });

  it('parses a YAML document written the adk-python way', () => {
    const config = parseBaseAgentYamlConfig(
      yaml.load(`
agent_class: my_library.agents.MyCustomAgent
name: code_pipeline_agent
sub_agents:
  - config_path: sub_agents/writer.yaml
before_agent_callbacks:
  - name: my_library.security_callbacks.before_agent_callback
other_field: other value
`),
    );

    expect(config.agentClass).toBe('my_library.agents.MyCustomAgent');
    expect(config.description).toBe('');
    expect(config.subAgents?.[0].configPath).toBe('sub_agents/writer.yaml');
    expect(config.beforeAgentCallbacks?.[0].name).toBe(
      'my_library.security_callbacks.before_agent_callback',
    );
    expect(config['otherField']).toBe('other value');
  });

  it('rejects a document with no name', () => {
    const error = caught(() => parseBaseAgentYamlConfig({description: 'x'}));

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error.message).toContain('name');
  });

  it('rejects an empty name', () => {
    const error = caught(() => parseBaseAgentYamlConfig({name: ''}));

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error.message).toContain('name');
  });

  it('rejects a document that is not an object', () => {
    for (const raw of ['a string', ['a list'], null, 5]) {
      const error = caught(() => parseBaseAgentYamlConfig(raw));

      expect(error).toBeInstanceOf(InputValidationError);
      expect(error.message).toContain('expected object');
    }
  });

  it('rejects a document whose sub-agent reference is invalid', () => {
    const error = caught(() =>
      parseBaseAgentYamlConfig({
        name: 'code_pipeline_agent',
        sub_agents: [{code: 'a.b.c', config_path: 'a.yaml'}],
      }),
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error.message).toContain(
      'Only one of `code` or `configPath` should be provided',
    );
  });

  it('attaches the schema error as the cause', () => {
    const error = caught(() => parseBaseAgentYamlConfig({}));

    expect(error.cause).toBeInstanceOf(z.ZodError);
  });

  it('refuses to parse when AGENT_CONFIG is disabled', async () => {
    await withTemporaryFeatureOverride(FeatureName.AGENT_CONFIG, false, () => {
      const error = caught(() =>
        parseBaseAgentYamlConfig({name: 'code_pipeline_agent'}),
      );

      expect(error.message).toBe('Feature AGENT_CONFIG is not enabled.');
    });
  });

  it('checks AGENT_CONFIG before it validates the document', async () => {
    await withTemporaryFeatureOverride(FeatureName.AGENT_CONFIG, false, () => {
      const error = caught(() => parseBaseAgentYamlConfig({}));

      expect(error).not.toBeInstanceOf(InputValidationError);
      expect(error.message).toBe('Feature AGENT_CONFIG is not enabled.');
    });
  });

  it('logs the deprecation notice once, not once per call', () => {
    parseBaseAgentYamlConfig({name: 'first_agent'});
    parseBaseAgentYamlConfig({name: 'second_agent'});

    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.filter(([message]) => message === DEPRECATION_REASON),
    ).toHaveLength(1);
  });
});
