/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DatabaseSessionService} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const APP_NAME = 'lifecycle-app';
const USER_ID = 'lifecycle-user';

/**
 * Collects the instances `MikroORM.close` runs against, and calls through.
 *
 * A test then asks MikroORM itself whether the connection went away. Removing
 * a file the sqlite driver still holds open succeeds on Linux and macOS, so
 * the deletion alone proves nothing outside Windows. Calling through also
 * unlocks the file, so that the Windows cleanup keeps working.
 *
 * @returns The array the spy appends each closed instance to.
 */
function collectClosedOrms(): MikroORM[] {
  const closed: MikroORM[] = [];
  const close = MikroORM.prototype.close;
  vi.spyOn(MikroORM.prototype, 'close').mockImplementation(function (
    this: MikroORM,
    force?: boolean,
  ) {
    closed.push(this);
    return close.call(this, force);
  });
  return closed;
}

describe('DatabaseSessionService connection lifecycle', () => {
  let directory: string;
  let uri: string;
  let service: DatabaseSessionService;
  let closed: MikroORM[];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'adk-session-lifecycle-'));
    uri = `sqlite://${path.join(directory, 'sessions.db')}`;
    service = new DatabaseSessionService(uri);
    closed = collectClosedOrms();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.close();
    rmSync(directory, {recursive: true, force: true});
  });

  function createTestSession(sessionId: string) {
    return service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId,
    });
  }

  it('releases the sqlite file it opened', async () => {
    await createTestSession('released');

    await service.close();

    expect(closed).toHaveLength(1);
    expect(await closed[0].isConnected()).toBe(false);
    expect(() => rmSync(directory, {recursive: true})).not.toThrow();
  });

  it('does nothing when it is closed before init', async () => {
    await expect(service.close()).resolves.toBeUndefined();

    expect(closed).toHaveLength(0);
  });

  it('does nothing when it is closed twice', async () => {
    await createTestSession('closed-twice');
    await service.close();

    await expect(service.close()).resolves.toBeUndefined();

    expect(closed).toHaveLength(1);
  });

  it('releases the sqlite file through Symbol.asyncDispose', async () => {
    await createTestSession('disposed');

    await service[Symbol.asyncDispose]();

    expect(closed).toHaveLength(1);
    expect(await closed[0].isConnected()).toBe(false);
  });

  it('reopens the database on the init after a close', async () => {
    await createTestSession('reopened');
    await service.close();

    await service.init();
    const reloaded = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: 'reopened',
    });

    expect(reloaded?.id).toBe('reopened');
    // The service reads through a second connection, so it gave the first one
    // up rather than keeping it.
    expect(closed).toHaveLength(1);
    expect(await closed[0].isConnected()).toBe(false);
  });
});
