/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  parseToolConnectionMap,
  toWireJson,
} from '../../../src/tools/environment_simulation/tool_connection_map.js';

describe('parseToolConnectionMap', () => {
  it('reads the snake_case wire keys into camelCase fields', () => {
    const result = parseToolConnectionMap({
      stateful_parameters: [
        {
          parameter_name: 'ticket_id',
          creating_tools: ['create_ticket'],
          consuming_tools: ['get_ticket'],
        },
      ],
    });

    expect(result).toEqual({
      statefulParameters: [
        {
          parameterName: 'ticket_id',
          creatingTools: ['create_ticket'],
          consumingTools: ['get_ticket'],
        },
      ],
    });
  });

  it('rejects a payload with no stateful_parameters', () => {
    expect(parseToolConnectionMap({parameters: []})).toBeUndefined();
  });

  it('rejects a payload whose entries are the wrong shape', () => {
    expect(
      parseToolConnectionMap({
        stateful_parameters: [{parameter_name: 'ticket_id'}],
      }),
    ).toBeUndefined();
  });

  it('rejects a payload that is not an object', () => {
    expect(parseToolConnectionMap([1, 2])).toBeUndefined();
    expect(parseToolConnectionMap(null)).toBeUndefined();
  });

  it('rejects camelCase keys, which the analysis prompt never asks for', () => {
    expect(
      parseToolConnectionMap({
        statefulParameters: [
          {
            parameterName: 'ticket_id',
            creatingTools: [],
            consumingTools: [],
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe('toWireJson', () => {
  it('renders the map with the keys the model was asked for', () => {
    const wireJson = toWireJson({
      statefulParameters: [
        {
          parameterName: 'ticket_id',
          creatingTools: ['create_ticket'],
          consumingTools: ['get_ticket'],
        },
      ],
    });

    expect(JSON.parse(wireJson)).toEqual({
      stateful_parameters: [
        {
          parameter_name: 'ticket_id',
          creating_tools: ['create_ticket'],
          consuming_tools: ['get_ticket'],
        },
      ],
    });
  });
});
