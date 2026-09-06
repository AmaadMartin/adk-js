/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/integrations/eventarc/test_config.py` from
 * google/adk-python (`main`), and adds the cases that cover the feature gate
 * and the default timeout.
 */

import {
  EVENTARC_DEFAULT_PUBLISH_TIMEOUT_SECONDS,
  EventarcToolConfig,
  EventarcToolConfigParams,
  FeatureName,
  FeatureStage,
  InputValidationError,
  createEventarcToolConfig,
  getFeatureConfig,
  overrideFeatureEnabled,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../../src/utils/logger.js';

const ENABLE_ENV_VAR = 'ADK_ENABLE_EVENTARC_TOOL_CONFIG';
const DISABLE_ENV_VAR = 'ADK_DISABLE_EVENTARC_TOOL_CONFIG';
const NOT_ENABLED_MESSAGE = 'Feature EVENTARC_TOOL_CONFIG is not enabled.';

function spyOnLoggerWarn() {
  return vi.spyOn(logger, 'warn').mockImplementation(() => {});
}

/**
 * Feeds the factory a JSON document, which is how unchecked input reaches it
 * in practice. TypeScript cannot check a parsed document, so this exercises
 * the runtime validation rather than the compiler's excess-property check.
 */
function createFromJson(json: string): EventarcToolConfig {
  return createEventarcToolConfig(JSON.parse(json));
}

describe('Eventarc tool config', () => {
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
    overrideFeatureEnabled(FeatureName.EVENTARC_TOOL_CONFIG, undefined);
    vi.restoreAllMocks();
  });

  // This case must stay first: the registry warns once per process and adk-js
  // exports no reset for its warned-feature set.
  it('warns once that EVENTARC_TOOL_CONFIG is enabled', () => {
    createEventarcToolConfig();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('EVENTARC_TOOL_CONFIG is enabled.'),
    );

    createEventarcToolConfig();

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('registers EVENTARC_TOOL_CONFIG as experimental and on by default', () => {
    const config = getFeatureConfig(FeatureName.EVENTARC_TOOL_CONFIG);

    expect(config?.stage).toBe(FeatureStage.EXPERIMENTAL);
    expect(config?.defaultOn).toBe(true);
  });

  // The two cases below carry the names of the reference tests.
  describe('ported from adk-python', () => {
    it('test_valid_config', () => {
      const config = createEventarcToolConfig({projectId: 'my-project'});

      expect(config.projectId).toBe('my-project');

      const config2 = createEventarcToolConfig();

      expect(config2.projectId).toBeUndefined();
    });

    it('test_invalid_config', () => {
      expect(() => createFromJson('{"projectId": 123}')).toThrow(
        InputValidationError,
      );
    });
  });

  describe('createEventarcToolConfig', () => {
    it('defaults publishTimeout to 15 seconds', () => {
      expect(EVENTARC_DEFAULT_PUBLISH_TIMEOUT_SECONDS).toBe(15);
      expect(createEventarcToolConfig().publishTimeout).toBe(15);
    });

    it('preserves an explicit publishTimeout', () => {
      expect(
        createEventarcToolConfig({publishTimeout: 30}).publishTimeout,
      ).toBe(30);
    });

    // adk-python applies no range check to `publish_timeout`, so neither does
    // this port.
    it('accepts a non-positive publishTimeout, as the reference does', () => {
      expect(
        createEventarcToolConfig({publishTimeout: -1}).publishTimeout,
      ).toBe(-1);
    });

    it('resolves an empty object to the defaults', () => {
      expect(createEventarcToolConfig({})).toEqual({
        projectId: undefined,
        publishTimeout: 15,
      });
    });

    it('returns a fresh object, not the caller object', () => {
      const params: EventarcToolConfigParams = {projectId: 'my-project'};

      const config = createEventarcToolConfig(params);
      config.projectId = 'another-project';

      expect(params.projectId).toBe('my-project');
    });

    // pydantic's default `extra='ignore'` drops unknown keys, so this config
    // accepts them where the neighbouring Pub/Sub config rejects them.
    it('accepts and drops an unknown key', () => {
      expect(createFromJson('{"region": "us-central1"}')).toEqual({
        projectId: undefined,
        publishTimeout: 15,
      });
    });

    it('drops the snake_case project_id spelling', () => {
      expect(
        createFromJson('{"project_id": "my-project"}').projectId,
      ).toBeUndefined();
    });

    // pydantic's lax mode coerces "15" to 15.0; zod rejects it, and no adk-js
    // config accepts a string for a numeric option.
    it('rejects a string publishTimeout', () => {
      expect(() => createFromJson('{"publishTimeout": "15"}')).toThrow(
        InputValidationError,
      );
    });

    it('names the config in the validation message', () => {
      expect(() => createFromJson('{"projectId": 123}')).toThrow(
        /Invalid EventarcToolConfig/,
      );
    });

    it('throws when the feature is disabled programmatically', () => {
      overrideFeatureEnabled(FeatureName.EVENTARC_TOOL_CONFIG, false);

      expect(() => createEventarcToolConfig()).toThrow(NOT_ENABLED_MESSAGE);
    });

    it('throws when ADK_DISABLE_EVENTARC_TOOL_CONFIG disables the feature', () => {
      process.env[DISABLE_ENV_VAR] = 'true';

      expect(() => createEventarcToolConfig()).toThrow(NOT_ENABLED_MESSAGE);
    });

    // The gate runs before validation, so a disabled feature reports itself
    // rather than reporting a value the factory never reads.
    it('reports the disabled feature before it validates the input', () => {
      overrideFeatureEnabled(FeatureName.EVENTARC_TOOL_CONFIG, false);

      expect(() => createFromJson('{"projectId": 123}')).toThrow(
        NOT_ENABLED_MESSAGE,
      );
    });

    it('stays enabled under ADK_ENABLE_EVENTARC_TOOL_CONFIG', () => {
      process.env[ENABLE_ENV_VAR] = 'true';

      expect(createEventarcToolConfig({projectId: 'my-project'})).toEqual({
        projectId: 'my-project',
        publishTimeout: 15,
      });
    });
  });
});
