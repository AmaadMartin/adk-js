/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases adk-python does not test, because pydantic covers them: the required
 * fields, the strict key check, the freshness of the returned object, the
 * snake_case wire boundary and the feature gate. The ported reference test
 * lives in `tool_connection_map_test.ts`.
 */

import {
  FeatureName,
  FeatureStage,
  InputValidationError,
  StatefulParameter,
  ToolConnectionMap,
  createStatefulParameter,
  createToolConnectionMap,
  getFeatureConfig,
  overrideFeatureEnabled,
  parseToolConnectionMap,
} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

const NOT_ENABLED_MESSAGE = 'Feature ENVIRONMENT_SIMULATION is not enabled.';

function ticketParameter(): StatefulParameter {
  return {
    parameterName: 'ticket_id',
    creatingTools: ['create_ticket'],
    consumingTools: ['get_ticket'],
  };
}

/**
 * Feeds a factory a JSON document, which is how unchecked input reaches it in
 * practice. TypeScript cannot check a parsed document, so these exercise the
 * runtime validation rather than the compiler's excess-property check.
 */
function statefulParameterFromJson(json: string): StatefulParameter {
  return createStatefulParameter(JSON.parse(json));
}

function toolConnectionMapFromJson(json: string): ToolConnectionMap {
  return createToolConnectionMap(JSON.parse(json));
}

describe('tool connection map', () => {
  afterEach(() => {
    overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, undefined);
  });

  it('registers ENVIRONMENT_SIMULATION as experimental and on by default', () => {
    const config = getFeatureConfig(FeatureName.ENVIRONMENT_SIMULATION);

    expect(config?.stage).toBe(FeatureStage.EXPERIMENTAL);
    expect(config?.defaultOn).toBe(true);
  });

  describe('createStatefulParameter', () => {
    it('keeps every field and returns a new object', () => {
      const params = ticketParameter();

      const parameter = createStatefulParameter(params);

      expect(parameter).toEqual(params);
      expect(parameter).not.toBe(params);
    });

    it('rejects a missing parameterName', () => {
      const json = '{"creatingTools": [], "consumingTools": []}';

      expect(() => statefulParameterFromJson(json)).toThrow(
        InputValidationError,
      );
      expect(() => statefulParameterFromJson(json)).toThrow(/parameterName/);
    });

    it('rejects a non-string entry in creatingTools', () => {
      const json =
        '{"parameterName": "ticket_id", "creatingTools": [7],' +
        ' "consumingTools": []}';

      expect(() => statefulParameterFromJson(json)).toThrow(
        InputValidationError,
      );
      expect(() => statefulParameterFromJson(json)).toThrow(/creatingTools/);
    });

    // pydantic ignores an extra field, so adk-js drops it too. A misspelled
    // required field still fails, because it leaves that field missing.
    it('drops an unknown key', () => {
      const json =
        '{"parameterName": "ticket_id", "creatingTools": [],' +
        ' "consumingTools": [], "confidence": 0.9}';

      const parameter = statefulParameterFromJson(json);

      expect(parameter).toEqual({
        parameterName: 'ticket_id',
        creatingTools: [],
        consumingTools: [],
      });
    });
  });

  describe('createToolConnectionMap', () => {
    it('accepts an empty parameter list and returns a new object', () => {
      const params = {statefulParameters: []};

      const map = createToolConnectionMap(params);

      expect(map.statefulParameters).toEqual([]);
      expect(map).not.toBe(params);
    });

    it('rejects an invalid nested parameter', () => {
      const json =
        '{"statefulParameters": [{"parameterName": "ticket_id",' +
        ' "creatingTools": []}]}';

      expect(() => toolConnectionMapFromJson(json)).toThrow(
        InputValidationError,
      );
      expect(() => toolConnectionMapFromJson(json)).toThrow(/consumingTools/);
    });

    it('drops an unknown key', () => {
      const json = '{"statefulParameters": [], "notes": "extra"}';

      expect(toolConnectionMapFromJson(json)).toEqual({
        statefulParameters: [],
      });
    });

    // The wire spelling is an unknown key to the factory, so it leaves the
    // camelCase field missing rather than being read as it.
    it('rejects the snake_case wire spelling, which the parse accepts', () => {
      const json = '{"stateful_parameters": []}';

      expect(() => toolConnectionMapFromJson(json)).toThrow(
        InputValidationError,
      );
      expect(() => toolConnectionMapFromJson(json)).toThrow(
        /statefulParameters/,
      );
    });
  });

  describe('the feature gate', () => {
    it('stops both factories when the feature is disabled', () => {
      overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

      expect(() => createStatefulParameter(ticketParameter())).toThrow(
        NOT_ENABLED_MESSAGE,
      );
      expect(() => createToolConnectionMap({statefulParameters: []})).toThrow(
        NOT_ENABLED_MESSAGE,
      );
    });

    // adk-python gates `__init__` only, and `model_validate` builds through
    // pydantic's core validator, so the reference parses with the feature off.
    it('leaves parseToolConnectionMap working when the feature is disabled', () => {
      overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

      const map = parseToolConnectionMap({stateful_parameters: []});

      expect(map.statefulParameters).toEqual([]);
    });
  });

  describe('parseToolConnectionMap', () => {
    it('reads the snake_case wire keys into camelCase fields', () => {
      const map = parseToolConnectionMap({
        stateful_parameters: [
          {
            parameter_name: 'ticket_id',
            creating_tools: ['create_ticket'],
            consuming_tools: ['get_ticket'],
          },
        ],
      });

      expect(map).toEqual({statefulParameters: [ticketParameter()]});
    });

    // The factories reject an unknown key; the parse drops it, because its
    // input comes from a model that may volunteer a field.
    it('drops an unknown wire key instead of rejecting the map', () => {
      const map = parseToolConnectionMap({
        stateful_parameters: [
          {
            parameter_name: 'ticket_id',
            creating_tools: ['create_ticket'],
            consuming_tools: ['get_ticket'],
            confidence: 0.9,
          },
        ],
        notes: 'extra',
      });

      expect(map).toEqual({statefulParameters: [ticketParameter()]});
    });

    it('rejects a missing required wire key', () => {
      const value = {
        stateful_parameters: [
          {parameter_name: 'ticket_id', creating_tools: ['create_ticket']},
        ],
      };

      expect(() => parseToolConnectionMap(value)).toThrow(InputValidationError);
      expect(() => parseToolConnectionMap(value)).toThrow(/consumingTools/);
    });

    it('rejects creating_tools carrying a string rather than an array', () => {
      const value = {
        stateful_parameters: [
          {
            parameter_name: 'ticket_id',
            creating_tools: 'create_ticket',
            consuming_tools: ['get_ticket'],
          },
        ],
      };

      expect(() => parseToolConnectionMap(value)).toThrow(InputValidationError);
      expect(() => parseToolConnectionMap(value)).toThrow(/creatingTools/);
    });
  });
});
