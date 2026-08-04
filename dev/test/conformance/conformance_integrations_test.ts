/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {Type} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';
import {
  askForApproval,
  calculateTripCost,
  createBooking,
  getUserId,
  registerConformanceIntegrations,
  reimburse,
  searchFlights,
  validateEmail,
} from '../../src/conformance/conformance_integrations.js';
import {IntegrationRegistry} from '../../src/integration/integration_registry.js';

// These conformance tools ignore the tool context, but runAsync requires one.
const toolContext = new Context({
  invocationContext: new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'flight_agent'}),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager(),
  }),
});

describe('searchFlights', () => {
  it('searches a round trip with the requested preferences', async () => {
    const result = await searchFlights.runAsync({
      args: {
        trip: {
          origin: 'SFO',
          destination: 'JFK',
          departureDate: '2026-03-01',
          returnDate: '2026-03-08',
        },
        preferences: {
          cabinClass: 'business',
          maxStops: 2,
          preferredAirline: 'UA',
          flexibleDates: true,
        },
      },
      toolContext,
    });

    expect(result).toStrictEqual({
      trip_type: 'round-trip',
      route: 'SFO to JFK',
      departure_date: '2026-03-01',
      return_date: '2026-03-08',
      cabin_class: 'business',
      max_stops: 2,
      preferred_airline: 'UA',
      flexible_dates: true,
      search_status: 'completed',
      available_flights: [
        'UA - round-trip business flight with up to 2 stops',
        'Departure: 2026-03-01',
        'Return: 2026-03-08',
      ],
    });
  });

  it('applies the defaults for a one-way trip without preferences', async () => {
    const result = await searchFlights.runAsync({
      args: {
        trip: {
          origin: 'LHR',
          destination: 'CDG',
          departureDate: '2026-04-15',
        },
      },
      toolContext,
    });

    expect(result).toStrictEqual({
      trip_type: 'one-way',
      route: 'LHR to CDG',
      departure_date: '2026-04-15',
      return_date: undefined,
      cabin_class: 'economy',
      max_stops: 1,
      preferred_airline: null,
      flexible_dates: false,
      search_status: 'completed',
      available_flights: [
        'Various Airlines - one-way economy flight with up to 1 stops',
        'Departure: 2026-04-15',
      ],
    });
  });

  it('describes a zero-stop search as direct', async () => {
    const result = await searchFlights.runAsync({
      args: {
        trip: {
          origin: 'SEA',
          destination: 'PDX',
          departureDate: '2026-05-20',
        },
        preferences: {
          cabinClass: 'economy',
          maxStops: 0,
          flexibleDates: false,
        },
      },
      toolContext,
    });

    expect(result).toMatchObject({
      available_flights: [
        'Various Airlines - one-way economy flight with direct',
        'Departure: 2026-05-20',
      ],
    });
  });
});

const REGISTERED_TOOLS: ReadonlyArray<readonly [string, BaseTool]> = [
  ['tools_agent_009.tools.reimburse', reimburse],
  ['tools_agent_009.tools.ask_for_approval', askForApproval],
  ['tools_agent_004.tools.search_flights', searchFlights],
  ['tools_agent_004.tools.calculate_trip_cost', calculateTripCost],
  ['tools_agent_002.tools.validate_email', validateEmail],
  ['tools_agent_002.tools.get_user_id', getUserId],
  ['tools_agent_002.tools.create_booking', createBooking],
];

describe('registerConformanceIntegrations', () => {
  let registry: IntegrationRegistry;

  beforeEach(() => {
    registry = new IntegrationRegistry();
    registerConformanceIntegrations(registry);
  });

  it('registers every conformance tool under its qualified name', () => {
    for (const [qualifiedName, tool] of REGISTERED_TOOLS) {
      expect(registry.getTool(qualifiedName)).toBe(tool);
    }

    expect(
      registry.getTool('tools_agent_009.tools.ask_for_approval')?.name,
    ).toBe('ask_for_approval');
    expect(registry.getTool('tools_agent_002.tools.get_user_id')?.name).toBe(
      'get_user_id',
    );
    expect(registry.getTool('tools_agent_002.tools.nope')).toBeUndefined();
  });

  it('keeps the zod parameter schema in the registered tool declaration', () => {
    const tool = registry.getTool('tools_agent_002.tools.create_booking');
    expect(tool).toBeDefined();

    const declaration = tool!._getDeclaration();
    expect(declaration).toBeDefined();
    expect(declaration!.name).toBe('create_booking');
    expect(declaration!.description).toBe('Creates a booking for a user.');

    const parameters = declaration!.parameters;
    expect(parameters?.type).toBe(Type.OBJECT);
    expect(Object.keys(parameters?.properties ?? {}).sort()).toEqual([
      'details',
      'isConfirmed',
      'userId',
    ]);
    expect(parameters?.properties?.['userId']).toEqual({
      type: Type.NUMBER,
      description: 'The unique identifier for the user.',
    });
    expect(parameters?.properties?.['isConfirmed']).toEqual({
      type: Type.BOOLEAN,
      description: 'Whether the booking is confirmed.',
    });
    expect(parameters?.properties?.['details']).toEqual({
      type: Type.STRING,
      description: 'Any additional details for the booking.',
    });
    expect([...(parameters?.required ?? [])].sort()).toEqual([
      'details',
      'isConfirmed',
      'userId',
    ]);
  });

  it('runs the registered validate_email tool', async () => {
    const tool = registry.getTool('tools_agent_002.tools.validate_email');
    expect(tool).toBeDefined();

    const result = await tool!.runAsync({
      args: {email: 'ada.lovelace@example.com'},
      toolContext,
    });

    expect(result).toBe(true);
  });
});
