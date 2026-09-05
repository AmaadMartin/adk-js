/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  ParsedArtifactUri,
  ensurePart,
  isArtifactRef,
  parseArtifactUri,
  validateArtifactReferenceScope,
  validatePathSegment,
} from '../../src/artifacts/artifact_util.js';

const SCOPE_FIELDS = ['appName', 'userId', 'sessionId'];

describe('parseArtifactUri', () => {
  it('parses a session-scoped URI', () => {
    expect(
      parseArtifactUri(
        'artifact://apps/app1/users/user1/sessions/session1/artifacts/file1/versions/123',
      ),
    ).toEqual({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'session1',
      filename: 'file1',
      version: 123,
    });
  });

  it('parses a session-scoped URI with a nested filename', () => {
    expect(
      parseArtifactUri(
        'artifact://apps/app1/users/user1/sessions/session1/artifacts/folder/file1/versions/123',
      ),
    ).toEqual({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'session1',
      filename: 'folder/file1',
      version: 123,
    });
  });

  it('parses a user-scoped URI', () => {
    expect(
      parseArtifactUri(
        'artifact://apps/app2/users/user2/artifacts/file2/versions/456',
      ),
    ).toEqual({
      appName: 'app2',
      userId: 'user2',
      filename: 'file2',
      version: 456,
    });
  });

  it('parses a user-scoped URI with a nested filename', () => {
    const parsed = parseArtifactUri(
      'artifact://apps/app2/users/user2/artifacts/folder/file2/versions/456',
    );

    expect(parsed?.filename).toBe('folder/file2');
    expect(parsed?.sessionId).toBeUndefined();
  });

  it.each([
    'http://example.com',
    'artifact://invalid',
    'artifact://app1/user1/sessions/session1/artifacts/file1',
    'artifact://apps/app1/users/user1/sessions/session1/artifacts/file1',
    'artifact://apps/app1/users/user1/artifacts/file1',
    'artifact://apps/app1/users/user1/artifacts/file1/versions/1/extra',
  ])('returns undefined for %s', (uri) => {
    expect(parseArtifactUri(uri)).toBeUndefined();
  });
});

describe('isArtifactRef', () => {
  it('accepts a part carrying an artifact URI', () => {
    expect(
      isArtifactRef({
        fileData: {
          fileUri:
            'artifact://apps/a/users/u/sessions/s/artifacts/f/versions/1',
          mimeType: 'text/plain',
        },
      }),
    ).toBe(true);
  });

  it.each<[string, Part]>([
    ['a text part', {text: 'hello'}],
    [
      'an inline data part',
      {inlineData: {data: 'MTIz', mimeType: 'text/plain'}},
    ],
    [
      'an external file part',
      {fileData: {fileUri: 'http://example.com', mimeType: 'text/plain'}},
    ],
    ['a file part without a URI', {fileData: {}}],
    ['an empty part', {}],
  ])('rejects %s', (_name, part) => {
    expect(isArtifactRef(part)).toBe(false);
  });
});

describe('validatePathSegment', () => {
  describe.each(SCOPE_FIELDS)('%s', (fieldName) => {
    it.each([
      'user123',
      'myapp',
      'sess123',
      'group/user123',
      'has/slash',
      'back\\slash',
      'a/./b',
      'user:profile.txt',
      '1:x',
      '_:x',
      'é:x',
      ':x',
      'plain',
    ])('accepts %s', (value) => {
      expect(() => validatePathSegment(value, fieldName)).not.toThrow();
    });

    it.each([
      ['', 'must not be empty'],
      ['null\u0000byte', 'must not contain null bytes'],
      ['/etc/passwd', 'must not be an absolute path'],
      ['/leading/slash', 'must not be an absolute path'],
      ['\\leading\\backslash', 'must not be an absolute path'],
      ['C:', 'must not be drive-qualified'],
      ['C:\\absolute', 'must not be drive-qualified'],
      ['C:/absolute', 'must not be drive-qualified'],
      ['C:drive-relative', 'must not be drive-qualified'],
      ['c:/data', 'must not be drive-qualified'],
      ['Z:relative', 'must not be drive-qualified'],
      ['../escape', 'must not contain traversal segments'],
      ['../../etc', 'must not contain traversal segments'],
      ['foo/../../bar', 'must not contain traversal segments'],
      ['mixed/..\\separators', 'must not contain traversal segments'],
      ['./..\\', 'must not contain traversal segments'],
      ['.\\../', 'must not contain traversal segments'],
      ['..', 'must not contain traversal segments'],
      ['.', 'must not contain traversal segments'],
    ])('rejects %s', (value, fragment) => {
      expect(() => validatePathSegment(value, fieldName)).toThrow(
        InputValidationError,
      );
      expect(() => validatePathSegment(value, fieldName)).toThrow(fragment);
    });

    it('names the offending field and value', () => {
      expect(() => validatePathSegment('../escape', fieldName)).toThrow(
        `${fieldName} "../escape" must not contain traversal segments.`,
      );
    });
  });
});

describe('validateArtifactReferenceScope', () => {
  const reference = (
    overrides: Partial<ParsedArtifactUri>,
  ): ParsedArtifactUri => ({
    appName: 'app1',
    userId: 'user1',
    sessionId: 'session1',
    filename: 'file1',
    version: 1,
    ...overrides,
  });

  it.each<[string | undefined, string | undefined]>([
    ['session1', 'session1'],
    ['session1', undefined],
    [undefined, undefined],
  ])(
    'allows a caller session %s to read a reference scoped to %s',
    (callerSessionId, uriSessionId) => {
      expect(() =>
        validateArtifactReferenceScope(
          {appName: 'app1', userId: 'user1', sessionId: callerSessionId},
          reference({sessionId: uriSessionId}),
        ),
      ).not.toThrow();
    },
  );

  it.each([
    ['other_app', 'user1'],
    ['app1', 'other_user'],
    ['other_app', 'other_user'],
  ])('rejects a reference owned by %s/%s', (uriAppName, uriUserId) => {
    expect(() =>
      validateArtifactReferenceScope(
        {appName: 'app1', userId: 'user1', sessionId: 'session1'},
        reference({appName: uriAppName, userId: uriUserId}),
      ),
    ).toThrow('same app and user scope');
  });

  it('rejects a reference owned by another session', () => {
    expect(() =>
      validateArtifactReferenceScope(
        {appName: 'app1', userId: 'user1', sessionId: 'session1'},
        reference({sessionId: 'other_session'}),
      ),
    ).toThrow('same session scope');
  });

  it('rejects a session-scoped reference read outside any session', () => {
    expect(() =>
      validateArtifactReferenceScope(
        {appName: 'app1', userId: 'user1'},
        reference({}),
      ),
    ).toThrow(InputValidationError);
  });
});

describe('ensurePart', () => {
  it('preserves a Part that already uses camelCase field names', () => {
    const part: Part = {text: 'hello'};

    expect(ensurePart(part)).toEqual(part);
  });

  it('preserves a camelCase object', () => {
    const artifact = {inlineData: {mimeType: 'image/png', data: 'dGVzdA=='}};

    expect(ensurePart(artifact)).toEqual(artifact);
  });

  it('converts snake_case field names', () => {
    expect(
      ensurePart({inline_data: {mime_type: 'text/plain', data: 'aGVsbG8='}}),
    ).toEqual({inlineData: {mimeType: 'text/plain', data: 'aGVsbG8='}});
  });

  it('converts a snake_case field nested under a camelCase one', () => {
    expect(ensurePart({fileData: {file_uri: 'gs://bucket/object'}})).toEqual({
      fileData: {fileUri: 'gs://bucket/object'},
    });
  });

  it('copies the artifact, so a later write cannot reach stored state', () => {
    const artifact: Part = {text: 'plain'};

    const normalized = ensurePart(artifact);
    artifact.text = 'changed';

    expect(normalized.text).toBe('plain');
  });
});
