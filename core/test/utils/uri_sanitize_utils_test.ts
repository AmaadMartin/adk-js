/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {MAX_INSPECT_CHARS} from '../../src/utils/sanitize_utils.js';
import {sanitizeExternalUri} from '../../src/utils/uri_sanitize_utils.js';

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
