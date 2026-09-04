/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/tools/pubsub/test_pubsub_config.py` from
 * google/adk-python (`main`), and adds the cases that cover the strict key
 * validation and the feature gate.
 */

import {
  FeatureName,
  FeatureStage,
  InputValidationError,
  PubSubToolConfig,
  createPubSubToolConfig,
  getFeatureConfig,
  overrideFeatureEnabled,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../../src/utils/logger.js';

const ENABLE_ENV_VAR = 'ADK_ENABLE_PUBSUB_TOOL_CONFIG';
const DISABLE_ENV_VAR = 'ADK_DISABLE_PUBSUB_TOOL_CONFIG';
const NOT_ENABLED_MESSAGE = 'Feature PUBSUB_TOOL_CONFIG is not enabled.';

function spyOnLoggerWarn() {
  return vi.spyOn(logger, 'warn').mockImplementation(() => {});
}

/**
 * Feeds the factory a JSON document, which is how unchecked input reaches it
 * in practice. TypeScript cannot check a parsed document, so this exercises
 * the runtime validation rather than the compiler's excess-property check.
 */
function createFromJson(json: string): PubSubToolConfig {
  return createPubSubToolConfig(JSON.parse(json));
}

describe('Pub/Sub tool config', () => {
  const originalEnv = process.env;
  let warnSpy: ReturnType<typeof spyOnLoggerWarn>;

  beforeEach(() => {
    process.env = {...originalEnv};
    delete process.env[ENABLE_ENV_VAR];
    delete process.env[DISABLE_ENV_VAR];
    warnSpy = spyOnLoggerWarn();
  });

  afterEach(() => {
    process.env = originalEnv;
    overrideFeatureEnabled(FeatureName.PUBSUB_TOOL_CONFIG, undefined);
    vi.restoreAllMocks();
  });

  // This case must stay first: the registry warns once per process and adk-js
  // exports no reset for its warned-feature set.
  it('warns once that PUBSUB_TOOL_CONFIG is enabled', () => {
    createPubSubToolConfig();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PUBSUB_TOOL_CONFIG is enabled.'),
    );

    createPubSubToolConfig();

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('registers PUBSUB_TOOL_CONFIG as experimental and on by default', () => {
    const config = getFeatureConfig(FeatureName.PUBSUB_TOOL_CONFIG);

    expect(config?.stage).toBe(FeatureStage.EXPERIMENTAL);
    expect(config?.defaultOn).toBe(true);
  });

  // The two cases below carry the names of the reference tests.
  describe('ported from adk-python', () => {
    it('test_pubsub_tool_config_init', () => {
      const config = createPubSubToolConfig({projectId: 'my-project'});

      expect(config.projectId).toBe('my-project');
    });

    it('test_pubsub_tool_config_default', () => {
      const config = createPubSubToolConfig();

      expect(config.projectId).toBeUndefined();
    });
  });

  describe('createPubSubToolConfig', () => {
    it('resolves an empty object to an unset project', () => {
      expect(createPubSubToolConfig({})).toEqual({projectId: undefined});
    });

    it('resolves an explicit undefined project', () => {
      expect(createPubSubToolConfig({projectId: undefined})).toEqual({
        projectId: undefined,
      });
    });

    it('returns a fresh object, not the caller object', () => {
      const params: PubSubToolConfig = {projectId: 'my-project'};

      const config = createPubSubToolConfig(params);
      config.projectId = 'another-project';

      expect(params.projectId).toBe('my-project');
    });

    it('rejects an unknown key', () => {
      expect(() => createFromJson('{"region": "us-central1"}')).toThrow(
        InputValidationError,
      );
    });

    // adk-python accepts `project_id` and rejects `projectId`; this port does
    // the reverse, so the snake_case spelling has its own case.
    it('rejects the snake_case project_id spelling', () => {
      expect(() => createFromJson('{"project_id": "my-project"}')).toThrow(
        /Invalid PubSubToolConfig/,
      );
    });

    it('rejects a non-string projectId', () => {
      expect(() => createFromJson('{"projectId": 123}')).toThrow(
        InputValidationError,
      );
    });

    it('throws when the feature is disabled programmatically', () => {
      overrideFeatureEnabled(FeatureName.PUBSUB_TOOL_CONFIG, false);

      expect(() => createPubSubToolConfig()).toThrow(NOT_ENABLED_MESSAGE);
    });

    it('throws when ADK_DISABLE_PUBSUB_TOOL_CONFIG disables the feature', () => {
      process.env[DISABLE_ENV_VAR] = 'true';

      expect(() => createPubSubToolConfig()).toThrow(NOT_ENABLED_MESSAGE);
    });

    // The gate runs before validation, so a disabled feature reports itself
    // rather than reporting a key the factory never reads.
    it('reports the disabled feature before it validates the input', () => {
      overrideFeatureEnabled(FeatureName.PUBSUB_TOOL_CONFIG, false);

      expect(() => createFromJson('{"region": "us-central1"}')).toThrow(
        NOT_ENABLED_MESSAGE,
      );
    });

    it('stays enabled under ADK_ENABLE_PUBSUB_TOOL_CONFIG', () => {
      process.env[ENABLE_ENV_VAR] = 'true';

      expect(createPubSubToolConfig({projectId: 'my-project'})).toEqual({
        projectId: 'my-project',
      });
    });
  });
});
