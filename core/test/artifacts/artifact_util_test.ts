/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  assertArtifactReferenceDepth,
  getArtifactUri,
  isArtifactRef,
  isArtifactUri,
  parseArtifactReference,
  parseArtifactUri,
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

  it('keeps slashes in a nested session-scoped filename', () => {
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

describe('getArtifactUri', () => {
  it('builds a session-scoped URI', () => {
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

  it('builds a user-scoped URI when no session is given', () => {
    expect(
      getArtifactUri({
        appName: 'app2',
        userId: 'user2',
        filename: 'file2',
        version: 456,
      }),
    ).toBe(USER_SCOPED_URI);
  });

  it('builds a user-scoped URI for an empty session', () => {
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
    {
      appName: 'app1',
      userId: 'user1',
      sessionId: 'session1',
      filename: 'folder/file1',
      version: 1,
    },
    {
      appName: 'app2',
      userId: 'user2',
      sessionId: undefined,
      filename: 'user:profile.txt',
      version: 0,
    },
  ])('round-trips $filename through parseArtifactUri', (scope) => {
    expect(parseArtifactUri(getArtifactUri(scope))).toEqual(scope);
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

describe('isArtifactRef', () => {
  it('accepts a fileData part holding an artifact URI', () => {
    expect(
      isArtifactRef({
        fileData: {fileUri: SESSION_SCOPED_URI, mimeType: 'text/plain'},
      }),
    ).toBe(true);
  });

  it.each<Part>([
    {text: 'hello'},
    {inlineData: {data: 'MTIz', mimeType: 'text/plain'}},
    {fileData: {fileUri: 'http://example.com', mimeType: 'text/plain'}},
    {},
  ])('rejects %o', (part) => {
    expect(isArtifactRef(part)).toBe(false);
  });
});

describe('parseArtifactReference', () => {
  it('returns the parsed URI for an in-scope reference', () => {
    expect(
      parseArtifactReference({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
        fileUri: SESSION_SCOPED_URI,
      }),
    ).toEqual({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'session1',
      filename: 'file1',
      version: 123,
    });
  });

  it('rejects a URI that does not parse', () => {
    expect(() =>
      parseArtifactReference({
        appName: 'app1',
        userId: 'user1',
        sessionId: 'session1',
        fileUri: 'artifact://apps/app1/invalid',
      }),
    ).toThrow('Invalid artifact reference URI: artifact://apps/app1/invalid');
  });

  it('rejects a URI owned by another user', () => {
    expect(() =>
      parseArtifactReference({
        appName: 'app1',
        userId: 'other-user',
        sessionId: 'session1',
        fileUri: SESSION_SCOPED_URI,
      }),
    ).toThrow('same app and user scope');
  });
});

describe('validateArtifactReferenceScope', () => {
  const inScope = {appName: 'app1', userId: 'user1'};

  it.each([
    {callerSessionId: 'session1', uriSessionId: 'session1'},
    {callerSessionId: 'session1', uriSessionId: undefined},
    {callerSessionId: undefined, uriSessionId: undefined},
  ])(
    'allows caller session $callerSessionId for URI session $uriSessionId',
    ({callerSessionId, uriSessionId}) => {
      expect(() =>
        validateArtifactReferenceScope({
          ...inScope,
          sessionId: callerSessionId,
          parsedUri: {
            ...inScope,
            sessionId: uriSessionId,
            filename: 'file1',
            version: 1,
          },
        }),
      ).not.toThrow();
    },
  );

  it.each([
    {appName: 'other-app', userId: 'user1'},
    {appName: 'app1', userId: 'other-user'},
    {appName: 'other-app', userId: 'other-user'},
  ])('rejects a URI owned by $appName / $userId', (uriScope) => {
    expect(() =>
      validateArtifactReferenceScope({
        ...inScope,
        sessionId: 'session1',
        parsedUri: {
          ...uriScope,
          sessionId: 'session1',
          filename: 'f',
          version: 1,
        },
      }),
    ).toThrow(
      'Artifact references must stay within the same app and user scope.',
    );
  });

  it.each([{callerSessionId: 'session1'}, {callerSessionId: undefined}])(
    'rejects a session-scoped URI for caller session $callerSessionId',
    ({callerSessionId}) => {
      expect(() =>
        validateArtifactReferenceScope({
          ...inScope,
          sessionId: callerSessionId,
          parsedUri: {
            ...inScope,
            sessionId: 'other-session',
            filename: 'f',
            version: 1,
          },
        }),
      ).toThrow(
        'Session-scoped artifact references must stay within the same session scope.',
      );
    },
  );
});

describe('assertArtifactReferenceDepth', () => {
  it('allows a chain shorter than the supported depth', () => {
    expect(() =>
      assertArtifactReferenceDepth(9, SESSION_SCOPED_URI),
    ).not.toThrow();
  });

  it('rejects a chain at the supported depth', () => {
    expect(() => assertArtifactReferenceDepth(10, SESSION_SCOPED_URI)).toThrow(
      `Artifact reference chain exceeded the maximum depth of 10: ${SESSION_SCOPED_URI}`,
    );
  });
});

describe('validatePathSegment', () => {
  const fieldNames = ['appName', 'userId', 'sessionId'];

  describe.each(fieldNames)('%s', (fieldName) => {
    it.each([
      'user123',
      'myapp',
      'sess123',
      'group/user123',
      'has/slash',
      'back\\slash',
      'user:profile.txt',
      'a/./b',
      '1:x',
      '_:x',
      'é:x',
      ':x',
      'plain',
    ])('accepts %s', (value) => {
      expect(() => validatePathSegment(value, fieldName)).not.toThrow();
    });

    it.each([
      '../escape',
      '../../etc',
      'foo/../../bar',
      'mixed/..\\separators',
      './..\\',
      '.\\../',
      '..',
      '.',
      'null\x00byte',
      '',
      '/etc/passwd',
      '/leading/slash',
      '\\leading\\backslash',
      'C:\\absolute',
      'C:/absolute',
      'C:drive-relative',
      'C:',
      'c:/data',
      'Z:relative',
    ])('rejects %s', (value) => {
      expect(() => validatePathSegment(value, fieldName)).toThrow();
    });
  });

  it('reports an empty value', () => {
    expect(() => validatePathSegment('', 'userId')).toThrow(
      'userId must not be empty.',
    );
  });

  it('reports a null byte before a traversal segment', () => {
    expect(() => validatePathSegment('..\x00', 'userId')).toThrow(
      'userId must not contain null bytes.',
    );
  });

  it('reports a leading slash before a traversal segment', () => {
    expect(() => validatePathSegment('/../etc', 'appName')).toThrow(
      "appName '/../etc' must not be an absolute path or start with a slash.",
    );
  });

  it('reports a drive letter before a traversal segment', () => {
    expect(() => validatePathSegment('C:/../etc', 'sessionId')).toThrow(
      "sessionId 'C:/../etc' must not be drive-qualified.",
    );
  });

  it('reports a traversal segment', () => {
    expect(() => validatePathSegment('foo/../bar', 'sessionId')).toThrow(
      "sessionId 'foo/../bar' must not contain traversal segments.",
    );
  });
});
