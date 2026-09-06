/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {appNameMismatchDetails} from '../../src/agents/agent_origin.js';

describe('appNameMismatchDetails', () => {
  it('reports nothing when the agent has no recorded origin', () => {
    expect(appNameMismatchDetails('weather_bot')).toBeUndefined();
    expect(appNameMismatchDetails('weather_bot', {})).toBeUndefined();
    expect(
      appNameMismatchDetails('weather_bot', {path: '/workspace/agents/x'}),
    ).toBeUndefined();
  });

  it('reports nothing when the origin implies the same app name', () => {
    expect(
      appNameMismatchDetails('weather_bot', {
        appName: 'weather_bot',
        path: '/workspace/agents/weather_bot',
      }),
    ).toBeUndefined();
  });

  it('reports nothing for a built-in agent name', () => {
    expect(
      appNameMismatchDetails('weather_bot', {appName: '__default__'}),
    ).toBeUndefined();
  });

  it('names both app names and the directory on a mismatch', () => {
    expect(
      appNameMismatchDetails('weather_bot', {
        appName: 'weather_agent',
        path: '/workspace/agents/weather_agent',
      }),
    ).toBe(
      'The runner is configured with app name "weather_bot", but the root ' +
        'agent was loaded from "/workspace/agents/weather_agent", which ' +
        'implies app name "weather_agent".',
    );
  });

  it('falls back to the origin app name when no path was recorded', () => {
    expect(
      appNameMismatchDetails('weather_bot', {appName: 'weather_agent'}),
    ).toBe(
      'The runner is configured with app name "weather_bot", but the root ' +
        'agent was loaded from "weather_agent", which implies app name ' +
        '"weather_agent".',
    );
  });
});
