/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ARTIFACT_URI_SCHEME,
  getArtifactUri,
  InputValidationError,
  isArtifactRef,
  parseArtifactUri,
} from '@google/adk';
import type {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  validateArtifactReferenceScope,
  validatePathSegment,
} from '../../src/artifacts/artifact_util.js';

const SESSION_SCOPED_URI =
  'artifact://apps/app1/users/user1/sessions/session1/artifacts/file1/versions/123';
const USER_SCOPED_URI =
  'artifact://apps/app2/users/user2/artifacts/file2/versions/456';

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

  it('parses a session-scoped URI with a nested filename', () => {
    const parsed = parseArtifactUri(
      'artifact://apps/app1/users/user1/sessions/session1/artifacts/folder/file1/versions/123',
    );
    expect(parsed?.filename).toBe('folder/file1');
    expect(parsed?.sessionId).toBe('session1');
  });

  it('parses a user-scoped URI without a session', () => {
    expect(parseArtifactUri(USER_SCOPED_URI)).toEqual({
      appName: 'app2',
      userId: 'user2',
      filename: 'file2',
      version: 456,
    });
    expect(parseArtifactUri(USER_SCOPED_URI)?.sessionId).toBeUndefined();
  });

  it('parses a user-scoped URI with a nested filename', () => {
    const parsed = parseArtifactUri(
      'artifact://apps/app2/users/user2/artifacts/folder/file2/versions/456',
    );
    expect(parsed?.filename).toBe('folder/file2');
    expect(parsed?.sessionId).toBeUndefined();
  });

  it.each([
    ['an empty string', ''],
    ['another scheme', 'http://example.com'],
    ['a gs URI', 'gs://bucket/file.txt'],
    ['a truncated URI', 'artifact://invalid'],
    ['a URI missing the apps segment', 'artifact://app1/user1/artifacts/f/1'],
    [
      'a URI without a version',
      'artifact://apps/app1/users/user1/sessions/session1/artifacts/file1',
    ],
    [
      'a user-scoped URI without a version',
      'artifact://apps/app1/users/user1/artifacts/file1',
    ],
    [
      'a non-numeric version',
      'artifact://apps/app1/users/user1/artifacts/file1/versions/latest',
    ],
    [
      'trailing content after the version',
      'artifact://apps/app1/users/user1/artifacts/file1/versions/1/extra',
    ],
  ])('returns undefined for %s', (_name, uri) => {
    expect(parseArtifactUri(uri)).toBeUndefined();
  });
});

describe('getArtifactUri', () => {
  it('builds the session form when a session is given', () => {
    expect(
      getArtifactUri({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
        filename: 'file1',
        version: 123,
      }),
    ).toBe(SESSION_SCOPED_URI);
  });

  it('builds the user form when no session is given', () => {
    expect(
      getArtifactUri({
        appName: 'app2',
        userId: 'user2',
        filename: 'file2',
        version: 456,
      }),
    ).toBe(USER_SCOPED_URI);
  });

  it('builds the user form for an empty session', () => {
    expect(
      getArtifactUri({
        appName: 'app2',
        userId: 'user2',
        sessionId: '',
        filename: 'file2',
        version: 456,
      }),
    ).toBe(USER_SCOPED_URI);
  });

  it.each([
    ['a filename with a slash', 'folder/report.pdf'],
    ['a user-namespaced filename', 'user:profile.txt'],
  ])('round-trips %s', (_name, filename) => {
    const uri = getArtifactUri({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'session1',
      filename,
      version: 7,
    });

    expect(parseArtifactUri(uri)).toEqual({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'session1',
      filename,
      version: 7,
    });
  });

  it('starts every URI with the artifact scheme', () => {
    expect(SESSION_SCOPED_URI.startsWith(ARTIFACT_URI_SCHEME)).toBe(true);
  });
});

describe('isArtifactRef', () => {
  it('is true for an artifact:// file URI', () => {
    const artifact: Part = {
      fileData: {fileUri: SESSION_SCOPED_URI, mimeType: 'text/plain'},
    };
    expect(isArtifactRef(artifact)).toBe(true);
  });

  it.each([
    ['a text part', {text: 'hello'}],
    ['an inline data part', {inlineData: {data: 'MTIz', mimeType: 'text/j'}}],
    ['a gs:// pointer', {fileData: {fileUri: 'gs://bucket/file.txt'}}],
    ['a file URI free part', {fileData: {mimeType: 'text/plain'}}],
    ['an empty part', {}],
  ])('is false for %s', (_name, artifact: Part) => {
    expect(isArtifactRef(artifact)).toBe(false);
  });
});

describe('validateArtifactReferenceScope', () => {
  it.each([
    [
      'a session-scoped reference read from its own session',
      'session1',
      'session1',
    ],
    ['a user-scoped reference read from a session', 'session1', undefined],
    ['a user-scoped reference read outside a session', undefined, undefined],
  ])('allows %s', (_name, callerSessionId, uriSessionId) => {
    expect(() =>
      validateArtifactReferenceScope({
        appName: 'app1',
        userId: 'user1',
        sessionId: callerSessionId,
        parsedUri: {
          appName: 'app1',
          userId: 'user1',
          sessionId: uriSessionId,
          filename: 'file1',
          version: 1,
        },
      }),
    ).not.toThrow();
  });

  it.each([
    ['another app', 'other_app', 'user1'],
    ['another user', 'app1', 'other_user'],
    ['another app and user', 'other_app', 'other_user'],
  ])('rejects a reference owned by %s', (_name, uriAppName, uriUserId) => {
    expect(() =>
      validateArtifactReferenceScope({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
        parsedUri: {
          appName: uriAppName,
          userId: uriUserId,
          sessionId: 'session1',
          filename: 'file1',
          version: 1,
        },
      }),
    ).toThrow(/same app and user scope/);
  });

  it.each([
    ['from another session', 'session1'],
    ['from outside any session', undefined],
  ])('rejects a session-scoped reference read %s', (_name, callerSessionId) => {
    expect(() =>
      validateArtifactReferenceScope({
        appName: 'app1',
        userId: 'user1',
        sessionId: callerSessionId,
        parsedUri: {
          appName: 'app1',
          userId: 'user1',
          sessionId: 'other_session',
          filename: 'file1',
          version: 1,
        },
      }),
    ).toThrow(/same session scope/);
  });

  it('throws InputValidationError, not a plain Error', () => {
    expect(() =>
      validateArtifactReferenceScope({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
        parsedUri: {
          appName: 'other_app',
          userId: 'user1',
          filename: 'file1',
          version: 1,
        },
      }),
    ).toThrow(InputValidationError);
  });
});

describe('validatePathSegment', () => {
  it.each([
    ['a plain identifier', 'user123'],
    ['a namespaced identifier', 'group/user123'],
    ['an interior slash', 'has/slash'],
    ['an interior backslash', 'back\\slash'],
    ['a colon after more than one letter', 'user:profile.txt'],
    ['a digit before the colon', '1:x'],
    ['a leading colon', ':x'],
    ['a single dot inside a segment', 'a/./b'],
  ])('accepts %s', (_name, value) => {
    expect(() => validatePathSegment(value, 'user_id')).not.toThrow();
  });

  it.each([
    ['../escape', 'must not contain traversal segments'],
    ['../../etc', 'must not contain traversal segments'],
    ['foo/../../bar', 'must not contain traversal segments'],
    ['mixed/..\\separators', 'must not contain traversal segments'],
    ['./..\\', 'must not contain traversal segments'],
    ['.\\../', 'must not contain traversal segments'],
    ['..', 'must not contain traversal segments'],
    ['.', 'must not contain traversal segments'],
    ['null\u0000byte', 'must not contain null bytes'],
    ['', 'must not be empty'],
    ['/etc/passwd', 'must not be an absolute path or start with a slash'],
    ['/leading/slash', 'must not be an absolute path or start with a slash'],
    [
      '\\leading\\backslash',
      'must not be an absolute path or start with a slash',
    ],
    ['C:\\absolute', 'must not be drive-qualified'],
    ['C:/absolute', 'must not be drive-qualified'],
    ['C:drive-relative', 'must not be drive-qualified'],
    ['C:', 'must not be drive-qualified'],
    ['c:/data', 'must not be drive-qualified'],
    ['Z:relative', 'must not be drive-qualified'],
  ])('rejects %j', (value, reason) => {
    expect(() => validatePathSegment(value, 'user_id')).toThrow(
      InputValidationError,
    );
    expect(() => validatePathSegment(value, 'user_id')).toThrow(reason);
  });

  it('names the field and quotes the value in the message', () => {
    expect(() => validatePathSegment('../escape', 'session_id')).toThrow(
      "session_id '../escape' must not contain traversal segments.",
    );
  });

  it('reports a drive-qualified value before a traversal segment', () => {
    expect(() => validatePathSegment('C:\\..\\etc', 'app_name')).toThrow(
      /must not be drive-qualified/,
    );
  });
});
