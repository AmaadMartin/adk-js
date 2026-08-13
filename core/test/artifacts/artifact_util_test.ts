/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isArtifactUri,
  nextArtifactRequest,
  parseArtifactUri,
  validateArtifactReference,
} from '../../src/artifacts/artifact_util.js';

const SESSION_SCOPED_URI =
  'artifact://apps/app1/users/user1/sessions/session1/artifacts/file1/versions/123';
const USER_SCOPED_URI =
  'artifact://apps/app1/users/user1/artifacts/file2/versions/456';
const CALLER = {
  appName: 'app1',
  userId: 'user1',
  sessionId: 'session1',
  filename: 'ref.txt',
};

describe('parseArtifactUri', () => {
  it('parses a session-scoped URI', () => {
    expect(parseArtifactUri(SESSION_SCOPED_URI)).toEqual({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'session1',
      filename: 'file1',
      version: 123,
    });
  });

  it('keeps slashes in a nested session-scoped filename', () => {
    const parsed = parseArtifactUri(
      'artifact://apps/app1/users/user1/sessions/session1/artifacts/folder/file1/versions/123',
    );

    expect(parsed?.filename).toBe('folder/file1');
    expect(parsed?.sessionId).toBe('session1');
  });

  it('parses a user-scoped URI without a session', () => {
    expect(parseArtifactUri(USER_SCOPED_URI)).toEqual({
      appName: 'app1',
      userId: 'user1',
      sessionId: undefined,
      filename: 'file2',
      version: 456,
    });
  });

  it('keeps slashes in a nested user-scoped filename', () => {
    const parsed = parseArtifactUri(
      'artifact://apps/app2/users/user2/artifacts/folder/file2/versions/456',
    );

    expect(parsed?.filename).toBe('folder/file2');
    expect(parsed?.sessionId).toBeUndefined();
  });

  it('keeps the user namespace prefix of a filename', () => {
    const parsed = parseArtifactUri(
      'artifact://apps/app2/users/user2/artifacts/user:profile.txt/versions/0',
    );

    expect(parsed?.filename).toBe('user:profile.txt');
  });

  it.each([
    'http://example.com',
    'artifact://invalid',
    'artifact://app1/user1/sessions/session1/artifacts/file1',
    'artifact://apps/app1/users/user1/sessions/session1/artifacts/file1',
    'artifact://apps/app1/users/user1/artifacts/file1',
    'artifact://apps/app1/users/user1/artifacts/file1/versions/1/extra',
    'artifact://apps/app1/users/user1/artifacts/file1/versions/abc',
    '',
  ])('returns undefined for %s', (uri) => {
    expect(parseArtifactUri(uri)).toBeUndefined();
  });
});

describe('isArtifactUri', () => {
  it('accepts an artifact URI', () => {
    expect(isArtifactUri(SESSION_SCOPED_URI)).toBe(true);
  });

  it.each(['gs://bucket/file', 'http://example.com', '', undefined])(
    'rejects %s',
    (uri) => {
      expect(isArtifactUri(uri)).toBe(false);
    },
  );
});

describe('validateArtifactReference', () => {
  it('allows a session-scoped URI from the session that owns it', () => {
    expect(() =>
      validateArtifactReference({...CALLER, fileUri: SESSION_SCOPED_URI}),
    ).not.toThrow();
  });

  it.each(['session1', 'other-session', undefined])(
    'allows a user-scoped URI from caller session %s',
    (sessionId) => {
      expect(() =>
        validateArtifactReference({
          ...CALLER,
          sessionId,
          fileUri: USER_SCOPED_URI,
        }),
      ).not.toThrow();
    },
  );

  it.each([
    {appName: 'other-app', userId: 'user1'},
    {appName: 'app1', userId: 'other-user'},
    {appName: 'other-app', userId: 'other-user'},
  ])('rejects a URI owned by $appName / $userId', ({appName, userId}) => {
    expect(() =>
      validateArtifactReference({
        ...CALLER,
        fileUri: `artifact://apps/${appName}/users/${userId}/sessions/session1/artifacts/file1/versions/1`,
      }),
    ).toThrow(
      'Artifact references must stay within the same app and user scope.',
    );
  });

  it.each(['other-session', undefined])(
    'rejects a session-scoped URI from caller session %s',
    (sessionId) => {
      expect(() =>
        validateArtifactReference({
          ...CALLER,
          sessionId,
          fileUri: SESSION_SCOPED_URI,
        }),
      ).toThrow(
        'Session-scoped artifact references must stay within the same session scope.',
      );
    },
  );

  it('rejects a URI that does not parse', () => {
    expect(() =>
      validateArtifactReference({
        ...CALLER,
        fileUri: 'artifact://apps/app1/invalid',
      }),
    ).toThrow('Invalid artifact reference URI: artifact://apps/app1/invalid');
  });
});

describe('nextArtifactRequest', () => {
  it('requests the artifact a session-scoped URI names', () => {
    expect(nextArtifactRequest(CALLER, SESSION_SCOPED_URI, 0)).toEqual({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'session1',
      filename: 'file1',
      version: 123,
    });
  });

  it("keeps the caller's session for a user-scoped URI", () => {
    expect(
      nextArtifactRequest(
        {...CALLER, sessionId: 'other-session'},
        USER_SCOPED_URI,
        0,
      ),
    ).toEqual({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'other-session',
      filename: 'file2',
      version: 456,
    });
  });

  it('rejects a URI that names another session', () => {
    expect(() =>
      nextArtifactRequest(
        {...CALLER, sessionId: 'other-session'},
        SESSION_SCOPED_URI,
        0,
      ),
    ).toThrow('same session scope');
  });

  it('follows a chain shorter than the supported depth', () => {
    expect(() =>
      nextArtifactRequest(CALLER, SESSION_SCOPED_URI, 9),
    ).not.toThrow();
  });

  it('rejects a chain at the supported depth', () => {
    expect(() => nextArtifactRequest(CALLER, SESSION_SCOPED_URI, 10)).toThrow(
      `Artifact reference chain exceeded the maximum depth of 10: ${SESSION_SCOPED_URI}`,
    );
  });
});
