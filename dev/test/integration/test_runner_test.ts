/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredentialTypes,
  createEvent,
  createEventActions,
  Event,
  EventActions,
  Session,
  ToolConfirmation,
} from '@google/adk';
import camelcaseKeys from 'camelcase-keys';
import yaml from 'js-yaml';
import * as assert from 'node:assert';
import {describe, expect, it} from 'vitest';
import {normalizeEvent} from '../../src/integration/test_runner.js';

// The function call id ADK mints when the model does not supply one.
const LIVE_ID = 'adk-3f2b1c0d-4e5f-11ee-be56-0242ac120002';
const OTHER_LIVE_ID = 'adk-9c8d7e6f-1a2b-3c4d-5e6f-708192a3b4c5';

// The same ids after the YAML loader camelCases every key of the recorded
// session, dictionary keys included.
const RECORDED_ID = 'adk3F2B1C0D4E5F11EeBe560242Ac120002';
const OTHER_RECORDED_ID = 'adk9C8D7E6F1A2B3C4D5E6F708192A3B4C5';

const FIRST_TOKEN = '<function-call-id-0>';
const SECOND_TOKEN = '<function-call-id-1>';

function authConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    authScheme: {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/o/oauth2/auth',
          tokenUrl: 'https://example.com/o/oauth2/token',
          scopes: {'https://example.com/auth/calendar': 'Manage calendars'},
        },
      },
    },
    credentialKey: 'adk_oauth2_example_calendar',
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    },
    ...overrides,
  };
}

function exchangedCredential(state: string) {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      state,
      authUri: `https://example.com/o/oauth2/auth?state=${state}`,
    },
  };
}

function agentEvent(actions: Partial<EventActions> = {}): Event {
  return createEvent({author: 'agent', actions: createEventActions(actions)});
}

/** Loads a session the way `yaml_test_loader` does, camelCasing every key. */
function loadRecordedSession(text: string): Session {
  const parsed = yaml.load(text);
  if (typeof parsed !== 'object' || parsed === null) {
    expect.fail('the fixture must be a YAML mapping');
  }
  return camelcaseKeys(parsed, {deep: true}) as Session;
}

describe('normalizeEvent', () => {
  it('the loader rewrites a recorded function call id past recognition', () => {
    const recorded = camelcaseKeys({[LIVE_ID]: {}}, {deep: true});

    expect(Object.keys(recorded)).toEqual([RECORDED_ID]);
    expect(Object.keys(recorded)[0].startsWith('adk-')).toBe(false);
  });

  it('compares auth configs whose function call ids differ per run', () => {
    const live = agentEvent({requestedAuthConfigs: {[LIVE_ID]: authConfig()}});
    const recorded = agentEvent({
      requestedAuthConfigs: {[RECORDED_ID]: authConfig()},
    });

    const normalized = normalizeEvent(live);

    assert.deepStrictEqual(normalized, normalizeEvent(recorded));
    expect(Object.keys(normalized.actions.requestedAuthConfigs!)).toEqual([
      FIRST_TOKEN,
    ]);
  });

  it('fails on a wrong credential key, which deleting the field would hide', () => {
    const live = agentEvent({requestedAuthConfigs: {[LIVE_ID]: authConfig()}});
    const recorded = agentEvent({
      requestedAuthConfigs: {
        [RECORDED_ID]: authConfig({credentialKey: 'adk_oauth2_example_drive'}),
      },
    });

    assert.throws(() =>
      assert.deepStrictEqual(normalizeEvent(live), normalizeEvent(recorded)),
    );
  });

  it('fails on a missing auth request, which deleting the field would hide', () => {
    const live = agentEvent();
    const recorded = agentEvent({
      requestedAuthConfigs: {[RECORDED_ID]: authConfig()},
    });

    assert.throws(() =>
      assert.deepStrictEqual(normalizeEvent(live), normalizeEvent(recorded)),
    );
  });

  it('drops exchangedAuthCredential and keeps the requested auth under comparison', () => {
    const live = agentEvent({
      requestedAuthConfigs: {
        [LIVE_ID]: authConfig({
          exchangedAuthCredential: exchangedCredential('live-state'),
        }),
      },
    });
    const recorded = agentEvent({
      requestedAuthConfigs: {
        [RECORDED_ID]: authConfig({
          exchangedAuthCredential: exchangedCredential('recorded-state'),
        }),
      },
    });

    const normalized = normalizeEvent(live);

    assert.deepStrictEqual(normalized, normalizeEvent(recorded));
    const config = normalized.actions.requestedAuthConfigs![FIRST_TOKEN];
    expect(config).not.toHaveProperty('exchangedAuthCredential');
    expect(config.authScheme).toEqual(authConfig().authScheme);
    expect(config.credentialKey).toBe('adk_oauth2_example_calendar');
    expect(config.rawAuthCredential).toEqual(authConfig().rawAuthCredential);
  });

  it('compares a live ToolConfirmation against the recorded object literal', () => {
    const live = agentEvent({
      requestedToolConfirmations: {
        [LIVE_ID]: new ToolConfirmation({
          hint: 'Delete the file?',
          confirmed: false,
          payload: {path: 'notes.txt'},
        }),
      },
    });
    const recorded = agentEvent({
      requestedToolConfirmations: {
        [RECORDED_ID]: {
          hint: 'Delete the file?',
          confirmed: false,
          payload: {path: 'notes.txt'},
        },
      },
    });

    assert.deepStrictEqual(normalizeEvent(live), normalizeEvent(recorded));
  });

  it('fails on a wrong confirmation hint', () => {
    const live = agentEvent({
      requestedToolConfirmations: {
        [LIVE_ID]: new ToolConfirmation({
          hint: 'Delete the file?',
          confirmed: false,
        }),
      },
    });
    const recorded = agentEvent({
      requestedToolConfirmations: {
        [RECORDED_ID]: {hint: 'Delete the folder?', confirmed: false},
      },
    });

    assert.throws(() =>
      assert.deepStrictEqual(normalizeEvent(live), normalizeEvent(recorded)),
    );
  });

  it('gives one function call id the same token in both maps', () => {
    const event = agentEvent({
      requestedAuthConfigs: {[LIVE_ID]: authConfig()},
      requestedToolConfirmations: {
        [LIVE_ID]: new ToolConfirmation({hint: 'Sign in?', confirmed: false}),
      },
    });

    const normalized = normalizeEvent(event);

    expect(Object.keys(normalized.actions.requestedAuthConfigs!)).toEqual([
      FIRST_TOKEN,
    ]);
    expect(Object.keys(normalized.actions.requestedToolConfirmations!)).toEqual(
      [FIRST_TOKEN],
    );
  });

  it('gives two function call ids different tokens across the maps', () => {
    const event = agentEvent({
      requestedAuthConfigs: {[LIVE_ID]: authConfig()},
      requestedToolConfirmations: {
        [OTHER_LIVE_ID]: new ToolConfirmation({
          hint: 'Sign in?',
          confirmed: false,
        }),
      },
    });

    const normalized = normalizeEvent(event);

    expect(Object.keys(normalized.actions.requestedAuthConfigs!)).toEqual([
      FIRST_TOKEN,
    ]);
    expect(Object.keys(normalized.actions.requestedToolConfirmations!)).toEqual(
      [SECOND_TOKEN],
    );
  });

  it('assigns tokens in iteration order to several auth requests', () => {
    const drive = authConfig({credentialKey: 'adk_oauth2_example_drive'});
    const live = agentEvent({
      requestedAuthConfigs: {
        [LIVE_ID]: authConfig(),
        [OTHER_LIVE_ID]: drive,
      },
    });
    const recorded = agentEvent({
      requestedAuthConfigs: {
        [RECORDED_ID]: authConfig(),
        [OTHER_RECORDED_ID]: drive,
      },
    });

    const normalized = normalizeEvent(live);

    expect(Object.keys(normalized.actions.requestedAuthConfigs!)).toEqual([
      FIRST_TOKEN,
      SECOND_TOKEN,
    ]);
    assert.deepStrictEqual(normalized, normalizeEvent(recorded));
  });

  it('still prunes the empty request maps of an ordinary event', () => {
    expect(Object.keys(normalizeEvent(createEvent({author: 'agent'})))).toEqual(
      ['author'],
    );
  });

  it('accepts a recorded event that omits actions entirely', () => {
    const session = loadRecordedSession('events:\n  - author: agent\n');

    expect(() => normalizeEvent(session.events[0])).not.toThrow();
  });

  it('accepts recorded actions that omit both request maps', () => {
    const session = loadRecordedSession(
      'events:\n  - author: agent\n    actions:\n      state_delta:\n        city: paris\n',
    );

    const normalized = normalizeEvent(session.events[0]);

    expect(normalized.actions).toEqual({stateDelta: {city: 'paris'}});
  });
});
