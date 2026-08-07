/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseSessionService,
  createEvent,
  createEventActions,
  State,
} from '@google/adk';
import {expect, it} from 'vitest';

const APP_NAME = 'my_app';
const OTHER_APP_NAME = 'other_app';
const USER_ID = 'u1';
const OTHER_USER_ID = 'u2';

/**
 * Runs the `getUserState` tests that every backend that supports the method
 * must satisfy.
 *
 * @param getService Returns the session service under test. It is called per
 *     test so the caller can rebuild the service between tests.
 */
export function runGetUserStateTests(getService: () => BaseSessionService) {
  /** Stores a state delta for an app and a user through a new session. */
  async function writeState(
    stateDelta: Record<string, unknown>,
    appName = APP_NAME,
    userId = USER_ID,
  ) {
    const service = getService();
    const session = await service.createSession({appName, userId});
    await service.appendEvent({
      session,
      event: createEvent({
        author: 'system',
        actions: createEventActions({stateDelta}),
      }),
    });
    return session;
  }

  it('returns an empty map when nothing is stored', async () => {
    const state = await getService().getUserState({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(state).toEqual({});
  });

  it('returns state written by appendEvent, without the user prefix and without a second session', async () => {
    await writeState({
      [`${State.USER_PREFIX}profile`]: {name: 'Alice'},
      sessionKey: 1,
    });

    const state = await getService().getUserState({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(state).toEqual({profile: {name: 'Alice'}});
  });

  it('does not return app-scoped state', async () => {
    await writeState({
      [`${State.APP_PREFIX}appKey`]: 'app-value',
      [`${State.USER_PREFIX}userKey`]: 'user-value',
    });

    const state = await getService().getUserState({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(state).toEqual({userKey: 'user-value'});
  });

  it('does not return the state of another user', async () => {
    await writeState({[`${State.USER_PREFIX}secret`]: 'only-for-u1'});

    const state = await getService().getUserState({
      appName: APP_NAME,
      userId: OTHER_USER_ID,
    });

    expect(state).toEqual({});
  });

  it('does not return the state of another app', async () => {
    await writeState({[`${State.USER_PREFIX}data`]: 'only-app-a'});

    const state = await getService().getUserState({
      appName: OTHER_APP_NAME,
      userId: USER_ID,
    });

    expect(state).toEqual({});
  });

  it('returns the latest write', async () => {
    const service = getService();
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    for (const counter of [1, 2]) {
      await service.appendEvent({
        session,
        event: createEvent({
          author: 'system',
          actions: createEventActions({
            stateDelta: {[`${State.USER_PREFIX}counter`]: counter},
          }),
        }),
      });
    }

    const state = await service.getUserState({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(state).toEqual({counter: 2});
  });

  it('returns a copy that the caller can mutate', async () => {
    await writeState({[`${State.USER_PREFIX}tier`]: 'gold'});
    const service = getService();

    const state = await service.getUserState({
      appName: APP_NAME,
      userId: USER_ID,
    });
    state['tier'] = 'bronze';
    delete state['tier'];

    expect(
      await service.getUserState({appName: APP_NAME, userId: USER_ID}),
    ).toEqual({tier: 'gold'});
  });

  it('keeps the user state after the session is deleted', async () => {
    const session = await writeState({
      [`${State.USER_PREFIX}tier`]: 'gold',
    });
    const service = getService();
    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });

    const state = await service.getUserState({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(state).toEqual({tier: 'gold'});
  });
}
