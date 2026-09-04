/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports the `DataAgentToolConfig` assertions from
 * `tests/unittests/tools/data_agent/test_data_agent_toolset.py` and
 * `tests/unittests/tools/data_agent/test_data_agent_tool.py` in
 * google/adk-python (`main`), and adds the cases that cover default
 * resolution, the numeric constraints and the strict key validation.
 */

import {
  DEFAULT_DATA_AGENT_MODIFICATION_POLL_INTERVAL_SECONDS,
  DEFAULT_DATA_AGENT_MODIFICATION_TIMEOUT_SECONDS,
  DEFAULT_MAX_QUERY_RESULT_ROWS,
  DataAgentToolConfig,
  InputValidationError,
  createDataAgentToolConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const DEFAULTS: DataAgentToolConfig = {
  maxQueryResultRows: 50,
  location: undefined,
  apiEndpoint: undefined,
  dataAgentModificationTimeoutSeconds: 60,
  dataAgentModificationPollIntervalSeconds: 2,
  enableDataAgentModification: false,
};

/**
 * Feeds the factory a JSON document, which is how unchecked input reaches it
 * in practice. TypeScript cannot check a parsed document, so this exercises
 * the runtime validation rather than the compiler's excess-property check.
 */
function createFromJson(json: string): DataAgentToolConfig {
  return createDataAgentToolConfig(JSON.parse(json));
}

describe('data agent tool config', () => {
  // The three cases below carry the names of the reference tests. Each
  // reference test also asserts on `DataAgentToolset` or `DataAgentTool`,
  // neither of which adk-js has yet, so only the config half is ported.
  describe('ported from adk-python', () => {
    // The toolset half asserts `toolset._tool_settings` is a default
    // `DataAgentToolConfig`; it is not portable without the toolset.
    it('test_data_agent_toolset_tools_default', () => {
      expect(createDataAgentToolConfig()).toEqual(DEFAULTS);
    });

    // The reference also asserts the toolset then exposes six tools, which
    // needs the toolset.
    it('test_data_agent_toolset_tools_with_mutation_enabled', () => {
      const config = createDataAgentToolConfig({
        enableDataAgentModification: true,
      });

      expect(config.enableDataAgentModification).toBe(true);
    });

    // The reference also asserts the tool calls the regional endpoint, which
    // needs the tool.
    it('test_list_accessible_data_agents_regional', () => {
      const config = createDataAgentToolConfig({location: 'eu'});

      expect(config.location).toBe('eu');
    });
  });

  describe('createDataAgentToolConfig', () => {
    it('resolves an empty object to the defaults', () => {
      expect(createDataAgentToolConfig({})).toEqual(DEFAULTS);
    });

    it('exports the defaults it applies', () => {
      expect(DEFAULT_MAX_QUERY_RESULT_ROWS).toBe(50);
      expect(DEFAULT_DATA_AGENT_MODIFICATION_TIMEOUT_SECONDS).toBe(60);
      expect(DEFAULT_DATA_AGENT_MODIFICATION_POLL_INTERVAL_SECONDS).toBe(2);
    });

    it('round-trips every field unchanged', () => {
      const params: DataAgentToolConfig = {
        maxQueryResultRows: 100,
        location: 'eu',
        apiEndpoint: 'https://eu-geminidataanalytics.googleapis.com',
        dataAgentModificationTimeoutSeconds: 120,
        dataAgentModificationPollIntervalSeconds: 5,
        enableDataAgentModification: true,
      };

      expect(createDataAgentToolConfig(params)).toEqual(params);
    });

    // The equivalent of the reference's `DataAgentToolConfig(location=None)`.
    it('resolves an explicit undefined location', () => {
      expect(createDataAgentToolConfig({location: undefined})).toEqual(
        DEFAULTS,
      );
    });

    it('returns a fresh object, not the caller object', () => {
      const params: Partial<DataAgentToolConfig> = {location: 'eu'};

      const config = createDataAgentToolConfig(params);
      config.location = 'us';

      expect(params.location).toBe('eu');
    });

    it('accepts a zero row cap', () => {
      expect(createDataAgentToolConfig({maxQueryResultRows: 0})).toEqual({
        ...DEFAULTS,
        maxQueryResultRows: 0,
      });
    });

    it('accepts a negative row cap', () => {
      expect(createDataAgentToolConfig({maxQueryResultRows: -1})).toEqual({
        ...DEFAULTS,
        maxQueryResultRows: -1,
      });
    });

    it('rejects a fractional row cap', () => {
      expect(() =>
        createDataAgentToolConfig({maxQueryResultRows: 1.5}),
      ).toThrow(InputValidationError);
    });

    it('rejects a zero modification timeout', () => {
      expect(() =>
        createDataAgentToolConfig({dataAgentModificationTimeoutSeconds: 0}),
      ).toThrow(InputValidationError);
    });

    it('rejects a negative modification timeout', () => {
      expect(() =>
        createDataAgentToolConfig({dataAgentModificationTimeoutSeconds: -1}),
      ).toThrow(InputValidationError);
    });

    it('rejects a zero poll interval', () => {
      expect(() =>
        createDataAgentToolConfig({
          dataAgentModificationPollIntervalSeconds: 0,
        }),
      ).toThrow(InputValidationError);
    });

    it('rejects a fractional poll interval', () => {
      expect(() =>
        createDataAgentToolConfig({
          dataAgentModificationPollIntervalSeconds: 1.5,
        }),
      ).toThrow(InputValidationError);
    });

    it('rejects an unknown key', () => {
      expect(() => createFromJson('{"region": "us-central1"}')).toThrow(
        InputValidationError,
      );
    });

    // adk-python accepts `max_query_result_rows` and rejects
    // `maxQueryResultRows`; this port does the reverse, so the snake_case
    // spelling has its own case.
    it('rejects the snake_case max_query_result_rows spelling', () => {
      expect(() => createFromJson('{"max_query_result_rows": 100}')).toThrow(
        /Invalid DataAgentToolConfig/,
      );
    });

    it('rejects a non-string location', () => {
      expect(() => createFromJson('{"location": 123}')).toThrow(
        InputValidationError,
      );
    });

    // pydantic in lax mode coerces "true" to True; the zod schema does not.
    it('rejects a stringly-typed enableDataAgentModification', () => {
      expect(() =>
        createFromJson('{"enableDataAgentModification": "true"}'),
      ).toThrow(InputValidationError);
    });

    // Python's `location=None` is valid; adk-js takes omission or `undefined`
    // and rejects the `null` a serialized Python model carries.
    it('rejects a null location', () => {
      expect(() => createFromJson('{"location": null}')).toThrow(
        InputValidationError,
      );
    });
  });
});
