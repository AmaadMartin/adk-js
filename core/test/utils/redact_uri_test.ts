/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {getArtifactServiceFromUri} from '../../src/artifacts/registry.js';
import {parseAuthorizationCode} from '../../src/auth/oauth2/oauth2_utils.js';
import {getConnectionOptionsFromUri} from '../../src/sessions/db/operations.js';
import {getSessionServiceFromUri} from '../../src/sessions/registry.js';
import {logger} from '../../src/utils/logger.js';
import {
  redactUriPassword,
  sanitizeExternalUri,
} from '../../src/utils/redact_uri.js';
import {MAX_INSPECT_CHARS} from '../../src/utils/sanitize_utils.js';

describe('redactUriPassword', () => {
  it('masks the password while keeping the rest of the URI', () => {
    expect(redactUriPassword('postgres://user:pass@db.host:5432/mydb')).toBe(
      'postgres://user:***@db.host:5432/mydb',
    );
  });

  it('masks the password for unsupported schemes too', () => {
    expect(redactUriPassword('oracle://admin:hunter2@ora.host/xe')).toBe(
      'oracle://admin:***@ora.host/xe',
    );
  });

  it('leaves a URI without a password unchanged', () => {
    expect(redactUriPassword('postgres://user@db.host/mydb')).toBe(
      'postgres://user@db.host/mydb',
    );
  });

  it('masks a password passed as a query parameter', () => {
    expect(
      redactUriPassword('postgres://user@db.host/mydb?password=hunter2'),
    ).toBe('postgres://user@db.host/mydb?password=***');
  });

  it('masks a query-parameter password with no userinfo at all', () => {
    expect(redactUriPassword('postgres://db.host/mydb?password=hunter2')).toBe(
      'postgres://db.host/mydb?password=***',
    );
  });

  it('matches secret query parameters case-insensitively', () => {
    const out = redactUriPassword('mysql://db.host/mydb?PWD=hunter2');
    expect(out).not.toContain('hunter2');
    expect(out).toBe('mysql://db.host/mydb?PWD=***');
  });

  it('masks the userinfo and query passwords together', () => {
    expect(
      redactUriPassword('postgres://user:pass@db.host/mydb?password=hunter2'),
    ).toBe('postgres://user:***@db.host/mydb?password=***');
  });

  it('keeps non-secret query parameters intact', () => {
    expect(
      redactUriPassword(
        'postgres://db.host/mydb?sslmode=require&password=hunter2&application_name=adk',
      ),
    ).toBe(
      'postgres://db.host/mydb?sslmode=require&password=***&application_name=adk',
    );
  });

  it('leaves a URI with no credential anywhere unchanged', () => {
    expect(redactUriPassword('postgres://db.host/mydb?sslmode=require')).toBe(
      'postgres://db.host/mydb?sslmode=require',
    );
  });

  it('does not leak anything after the scheme for unparseable input', () => {
    const out = redactUriPassword('not a url with :hunter2@ inside it');
    expect(out).not.toContain('hunter2');
  });

  it('says the value was redacted rather than looking empty', () => {
    expect(redactUriPassword('postgres//db.host/mydb')).toBe(
      '<unparseable URI, redacted>',
    );
    expect(redactUriPassword('postgres://user:pass@ db.host/mydb')).toBe(
      'postgres://<unparseable URI, redacted>',
    );
  });
});

describe('connection-URI errors do not leak the password', () => {
  it('getConnectionOptionsFromUri redacts the password in its error', async () => {
    await expect(
      getConnectionOptionsFromUri('oracle://admin:hunter2@ora.host/xe'),
    ).rejects.toThrow(/oracle:\/\/admin:\*\*\*@ora\.host\/xe/);
    await expect(
      getConnectionOptionsFromUri('oracle://admin:hunter2@ora.host/xe'),
    ).rejects.not.toThrow(/hunter2/);
  });

  it('getSessionServiceFromUri redacts the password in its error', () => {
    expect(() =>
      getSessionServiceFromUri('oracle://admin:hunter2@ora.host/xe'),
    ).toThrow(/oracle:\/\/admin:\*\*\*@ora\.host\/xe/);
    expect(() =>
      getSessionServiceFromUri('oracle://admin:hunter2@ora.host/xe'),
    ).not.toThrow(/hunter2/);
  });

  it('getArtifactServiceFromUri redacts the password in its error', () => {
    expect(() =>
      getArtifactServiceFromUri('s3://admin:hunter2@bucket/prefix'),
    ).toThrow(/s3:\/\/admin:\*\*\*@bucket\/prefix/);
    expect(() =>
      getArtifactServiceFromUri('s3://admin:hunter2@bucket/prefix'),
    ).not.toThrow(/hunter2/);
  });

  it('parseAuthorizationCode does not leak the code on a malformed callback URI', () => {
    // A malformed authorization-response URI (missing scheme) still carries
    // a recognizable authorization code in its query string, and previously
    // this fell through to a log statement that included the raw URI.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const result = parseAuthorizationCode(
        'not-a-valid-scheme?code=SECRET_AUTH_CODE&state=xyz',
      );
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledOnce();
      const loggedText = warnSpy.mock.calls
        .map((call) => call.join(' '))
        .join(' ');
      expect(loggedText).not.toContain('SECRET_AUTH_CODE');
      expect(loggedText).toContain('<unparseable URI, redacted>');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    'code',
    'access_token',
    'id_token',
    'refresh_token',
    'client_secret',
  ])('redacts the %s query parameter', (param) => {
    expect(
      redactUriPassword(`https://app/callback?${param}=SECRET&state=xyz`),
    ).toBe(`https://app/callback?${param}=***&state=xyz`);
  });
});

const REDACTED_URI = '[REDACTED_SENSITIVE_URI]';

describe('sanitizeExternalUri whole-URI redaction', () => {
  it('redacts a value that is not a string', () => {
    expect(sanitizeExternalUri(undefined, -1)).toEqual({
      uri: REDACTED_URI,
      changed: true,
    });
    expect(sanitizeExternalUri(42, -1)).toEqual({
      uri: REDACTED_URI,
      changed: true,
    });
  });

  it('redacts a URI longer than the inspection limit', () => {
    const long = `https://example.test/${'a'.repeat(MAX_INSPECT_CHARS)}`;
    expect(sanitizeExternalUri(long, -1).uri).toBe(REDACTED_URI);
  });

  it('redacts a URI no parser accepts', () => {
    expect(sanitizeExternalUri('not a uri', -1).uri).toBe(REDACTED_URI);
  });

  it('redacts a URI carrying a username', () => {
    expect(sanitizeExternalUri('https://user@example.test/a', -1)).toEqual({
      uri: REDACTED_URI,
      changed: true,
    });
  });

  it('redacts a URI carrying a password without a username', () => {
    expect(sanitizeExternalUri('https://:pw@example.test/a', -1).uri).toBe(
      REDACTED_URI,
    );
  });
});

describe('sanitizeExternalUri path segments', () => {
  it('redacts a sensitive segment and the segment after it', () => {
    const result = sanitizeExternalUri(
      'https://example.test/a/token/abc123/b',
      -1,
    );
    expect(result.uri).toBe(
      'https://example.test/a/%5BREDACTED%5D/%5BREDACTED%5D/b',
    );
    expect(result.changed).toBe(true);
  });

  it('redacts a segment whose percent escapes decode to a sensitive name', () => {
    const result = sanitizeExternalUri(
      'https://example.test/%61pi%5Fkey/abc123',
      -1,
    );
    expect(result.uri).toBe(
      'https://example.test/%5BREDACTED%5D/%5BREDACTED%5D',
    );
  });

  it('redacts a credential written inside one segment', () => {
    const result = sanitizeExternalUri(
      'https://example.test/logs/password=hunter2/x',
      -1,
    );
    expect(result.uri).not.toContain('hunter2');
    expect(result.changed).toBe(true);
  });

  it('leaves an ordinary path byte-identical', () => {
    const uri = 'https://example.test/design/signal/public/progress%25/report';
    expect(sanitizeExternalUri(uri, -1)).toEqual({uri, changed: false});
  });

  it('keeps a non-http scheme intact', () => {
    const uri = 'gs://bucket/2026-01-01/trace/span_p0.png';
    expect(sanitizeExternalUri(uri, -1)).toEqual({uri, changed: false});
  });

  it('redacts a whole opaque URI whose path refuses the redaction', () => {
    // A `data:`, `mailto:` or `blob:` URL cannot be a base, and the WHATWG
    // `pathname` setter does nothing on one. Writing the URI back would return
    // the credential the path pass just found.
    for (const uri of [
      'data:text/plain,x/token/SECRET-IN-DATA',
      'mailto:a@b.test/token/SECRET-IN-MAILTO',
      'blob:https://example.test/token/SECRET-IN-BLOB',
    ]) {
      expect(sanitizeExternalUri(uri, -1)).toEqual({
        uri: REDACTED_URI,
        changed: true,
      });
    }
  });

  it('keeps an opaque URI that carries no credential', () => {
    for (const uri of ['mailto:a@b.test', 'data:text/plain,hello']) {
      expect(sanitizeExternalUri(uri, -1)).toEqual({uri, changed: false});
    }
  });

  it('still redacts the query of an opaque URI', () => {
    const result = sanitizeExternalUri('mailto:a@b.test?token=SECRET', -1);
    expect(result.uri).toBe('mailto:a@b.test?token=%5BREDACTED%5D');
    expect(result.changed).toBe(true);
  });
});

describe('sanitizeExternalUri query and fragment', () => {
  it('keeps a sensitive parameter name and replaces its value', () => {
    const result = sanitizeExternalUri(
      'https://example.test/a?safe=kept&api_key=SECRET',
      -1,
    );
    expect(result.uri).toContain('safe=kept');
    expect(result.uri).toContain('api_key=%5BREDACTED%5D');
    expect(result.uri).not.toContain('SECRET');
  });

  it('keeps a blank parameter value', () => {
    const result = sanitizeExternalUri('https://example.test/a?flag=', -1);
    expect(result).toEqual({
      uri: 'https://example.test/a?flag=',
      changed: false,
    });
  });

  it('redacts a parameter value carrying a credential of its own', () => {
    const result = sanitizeExternalUri(
      'https://example.test/a?note=token%3DSECRET',
      -1,
    );
    expect(result.uri).not.toContain('SECRET');
    expect(result.changed).toBe(true);
  });

  it('redacts a credential in the fragment', () => {
    const result = sanitizeExternalUri(
      'https://example.test/a#access_token=SECRET',
      -1,
    );
    expect(result.uri).not.toContain('SECRET');
    expect(result.changed).toBe(true);
  });

  it('leaves an ordinary fragment in place', () => {
    const uri = 'https://example.test/a#section-2';
    expect(sanitizeExternalUri(uri, -1)).toEqual({uri, changed: false});
  });

  it('stops decoding after a bounded number of rounds', () => {
    // Five nested escapes: the detection pass sees `%41`, not `A`, so the
    // segment is neither reclassified nor rewritten.
    const uri = 'https://example.test/%2525252541';
    expect(sanitizeExternalUri(uri, -1)).toEqual({uri, changed: false});
  });
});

describe('sanitizeExternalUri length bound', () => {
  it('truncates a URI past the caller limit and reports it', () => {
    const result = sanitizeExternalUri('https://example.test/abcdefgh', 20);
    expect(result.uri).toBe('https://example.test...[TRUNCATED]');
    expect(result.changed).toBe(true);
  });
});
