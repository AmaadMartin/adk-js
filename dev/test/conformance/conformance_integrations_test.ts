/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {searchFlights} from '../../src/conformance/conformance_integrations.js';

// searchFlights ignores the tool context, but runAsync requires one.
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
