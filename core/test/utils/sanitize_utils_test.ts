/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  recursiveSmartTruncate,
  sanitizeErrorText,
  truncateText,
} from '../../src/utils/sanitize_utils.js';

/**
 * Budget for the linear-scan test. A linear pass over 500,000 characters takes
 * about 7 ms; a quadratic one takes minutes, so the test fails by timeout.
 */
const LINEAR_SCAN_BUDGET_MS = 5_000;

/** Builds an object nested `depth` levels deep under the key `next`. */
function nest(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = {leaf: 'bottom'};
  for (let i = 0; i < depth; i++) {
    node = {next: node};
  }
  return node;
}

describe('truncateText', () => {
  it('leaves a string that fits', () => {
    expect(truncateText('short', 10)).toEqual({
      text: 'short',
      truncated: false,
    });
  });

  it('cuts a string that does not fit and marks it', () => {
    expect(truncateText('abcdef', 3)).toEqual({
      text: 'abc...[TRUNCATED]',
      truncated: true,
    });
  });

  it('leaves a long string whole when the limit is -1', () => {
    const long = 'x'.repeat(5000);
    expect(truncateText(long, -1)).toEqual({text: long, truncated: false});
  });
});

describe('recursiveSmartTruncate', () => {
  it('truncates a long string and reports the loss', () => {
    const result = recursiveSmartTruncate('a'.repeat(20), 5);
    expect(result.value).toBe('aaaaa...[TRUNCATED]');
    expect(result.truncated).toBe(true);
  });

  it('walks nested objects and arrays element-wise', () => {
    const result = recursiveSmartTruncate(
      {outer: [{inner: 'abcdefgh'}, 'ijklmnop', 7, true, null]},
      4,
    );
    expect(result.value).toEqual({
      outer: [
        {inner: 'abcd...[TRUNCATED]'},
        'ijkl...[TRUNCATED]',
        7,
        true,
        null,
      ],
    });
    expect(result.truncated).toBe(true);
  });

  it('walks a class instance through its own enumerable properties', () => {
    class ToolArgs {
      constructor(
        readonly query: string,
        readonly apiKey: string,
      ) {}
    }
    const result = recursiveSmartTruncate(new ToolArgs('weather', 'sk-1'), -1);
    expect(result.value).toEqual({query: 'weather', apiKey: '[REDACTED]'});
  });

  it('leaves a long string whole when maxLength is -1', () => {
    const traceback = 'stack line\n'.repeat(500);
    const result = recursiveSmartTruncate({traceback}, -1);
    expect(result.value).toEqual({traceback});
    expect(result.truncated).toBe(false);
  });

  it.each([
    'client_secret',
    'access_token',
    'refresh_token',
    'id_token',
    'api_key',
    'password',
    'private_key',
    'proxy_authorization',
    'google_access_id',
    'sig',
    'signature',
    'token',
    'secret',
    'authorization',
    'x_api_key',
    'x_amz_credential',
    'x_amz_signature',
    'x_goog_credential',
    'x_goog_security_token',
    'x_goog_signature',
  ])('redacts the value of %s', (key) => {
    const result = recursiveSmartTruncate({[key]: 'super-secret'}, -1);
    expect(result.value).toEqual({[key]: '[REDACTED]'});
  });

  it.each(['AUTHORIZATION', 'X-Api-Key', 'Access-Token', 'temp:oauth_state'])(
    'redacts %s, matching case-insensitively with - and _ equivalent',
    (key) => {
      const result = recursiveSmartTruncate({[key]: 'super-secret'}, -1);
      expect(result.value).toEqual({[key]: '[REDACTED]'});
    },
  );

  it.each(['apiKey', 'accessToken', 'clientSecret', 'privateKey'])(
    'redacts the camelCase spelling %s that a JavaScript payload uses',
    (key) => {
      const result = recursiveSmartTruncate({[key]: 'super-secret'}, -1);
      expect(result.value).toEqual({[key]: '[REDACTED]'});
    },
  );

  it('does not report truncation for redaction alone', () => {
    const result = recursiveSmartTruncate({token: 'super-secret'}, -1);
    expect(result.truncated).toBe(false);
  });

  it('leaves a key that merely contains a sensitive word alone', () => {
    const result = recursiveSmartTruncate({tokenCount: 42}, -1);
    expect(result.value).toEqual({tokenCount: 42});
  });

  it('replaces a back-reference without reporting truncation', () => {
    const cyclic: Record<string, unknown> = {name: 'root'};
    cyclic['self'] = cyclic;
    const result = recursiveSmartTruncate(cyclic, -1);
    expect(result.value).toEqual({name: 'root', self: '[CIRCULAR_REFERENCE]'});
    expect(result.truncated).toBe(false);
  });

  it('keeps a repeated sibling that is not an ancestor', () => {
    const shared = {id: 1};
    const result = recursiveSmartTruncate({a: shared, b: shared}, -1);
    expect(result.value).toEqual({a: {id: 1}, b: {id: 1}});
  });

  it('replaces a value nested past the depth cap and reports the loss', () => {
    const result = recursiveSmartTruncate(nest(60), -1);
    expect(JSON.stringify(result.value)).toContain('[MAX_DEPTH_EXCEEDED]');
    expect(result.truncated).toBe(true);
  });

  it('keeps a value nested just inside the depth cap', () => {
    const result = recursiveSmartTruncate(nest(40), -1);
    expect(JSON.stringify(result.value)).toContain('bottom');
    expect(result.truncated).toBe(false);
  });

  it('stops an over-wide array at the node budget', () => {
    const wide = Array.from({length: 100_005}, (_, i) => i);
    const result = recursiveSmartTruncate(wide, -1);
    expect(result.value).toContain('[SANITIZE_BUDGET_EXCEEDED]');
    expect(result.truncated).toBe(true);
  });

  it('stops an over-wide object at the node budget', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100_005; i++) {
      wide[`k${i}`] = i;
    }
    const result = recursiveSmartTruncate(wide, -1);
    expect(result.value).toHaveProperty(
      '[SANITIZE_BUDGET_EXCEEDED]',
      '[SANITIZE_BUDGET_EXCEEDED]',
    );
    expect(result.truncated).toBe(true);
  });

  it('serializes a value JSON.stringify cannot represent', () => {
    const result = recursiveSmartTruncate({big: 9007199254740993n}, -1);
    expect(result.value).toEqual({big: '9007199254740993'});
    expect(() => JSON.stringify(result.value)).not.toThrow();
  });

  it('keeps a Date as the value it serializes to', () => {
    const result = recursiveSmartTruncate(
      {at: new Date('2026-01-02T03:04:05.000Z')},
      -1,
    );
    expect(result.value).toEqual({at: '2026-01-02T03:04:05.000Z'});
  });

  it('passes undefined through unchanged', () => {
    expect(recursiveSmartTruncate(undefined, -1)).toEqual({
      value: undefined,
      truncated: false,
    });
  });
});

describe('sanitizeErrorText', () => {
  it('leaves ordinary prose byte for byte', () => {
    const prose = '[INFO] starting up: 3 agents, 2 tools (ratio = 1.5)';
    expect(sanitizeErrorText(prose, -1)).toEqual({
      text: prose,
      truncated: false,
    });
  });

  it('redacts a whole Authorization header line', () => {
    const text = 'POST /v1\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\nHost: x';
    expect(sanitizeErrorText(text, -1).text).toBe(
      'POST /v1\nAuthorization: [REDACTED]\nHost: x',
    );
  });

  it('redacts a bare Basic credential that has lost its header name', () => {
    expect(sanitizeErrorText('retry with Basic dXNlcjpwYXNz', -1).text).toBe(
      'retry with [REDACTED]',
    );
  });

  it.each(['Basic authentication is required', 'Basic auth failed'])(
    'keeps prose whose token does not decode to a pair: %s',
    (prose) => {
      expect(sanitizeErrorText(prose, -1).text).toBe(prose);
    },
  );

  it.each(['Proxy-Authorization', 'X-Api-Key', 'Api-Key'])(
    'redacts the %s header line',
    (header) => {
      expect(sanitizeErrorText(`${header}: abc123`, -1).text).toBe(
        `${header}: [REDACTED]`,
      );
    },
  );

  it('redacts a bearer token that carries no header name', () => {
    expect(
      sanitizeErrorText('sent Bearer oauth-token-1 then failed', -1).text,
    ).toBe('sent [REDACTED] then failed');
  });

  it('redacts an API key carried in a URL query', () => {
    const text = 'GET https://api/v1/models?alt=json&key=AIzaSyC7 failed';
    expect(sanitizeErrorText(text, -1).text).toBe(
      'GET https://api/v1/models?alt=json&key=[REDACTED] failed',
    );
  });

  it.each([
    ['access_token=oauth-token-1', 'access_token=[REDACTED]'],
    ['client_secret: shh', 'client_secret: [REDACTED]'],
    ['"apiKey": "AIzaSyC7"', '"apiKey": "[REDACTED]"'],
    ['x-api-key=abc', 'x-api-key=[REDACTED]'],
    ['temp:oauth_state=xyz', 'temp:oauth_state=[REDACTED]'],
  ])('redacts the credential in %s', (text, expected) => {
    expect(sanitizeErrorText(text, -1).text).toBe(expected);
  });

  it('leaves a name that is not a credential alone', () => {
    expect(
      sanitizeErrorText('model=gemini-2.0-flash, retries=3', -1).text,
    ).toBe('model=gemini-2.0-flash, retries=3');
  });

  it.each([
    [
      'connection failed: password=hunter2',
      'connection failed: password=[REDACTED]',
    ],
    ['refused: api_key=sk-live', 'refused: api_key=[REDACTED]'],
    ['a: b: c: token=abc', 'a: b: c: token=[REDACTED]'],
    [
      'connect failed: user=bob password=hunter2',
      'connect failed: user=bob password=[REDACTED]',
    ],
  ])('redacts a credential a harmless name would hide in %s', (text, want) => {
    expect(sanitizeErrorText(text, -1).text).toBe(want);
  });

  it(
    'stays linear when a harmless name precedes a long value',
    () => {
      const value = 'x'.repeat(500_000);
      expect(sanitizeErrorText(`note: ${value} token=abc`, -1).text).toBe(
        `note: ${value} token=[REDACTED]`,
      );
    },
    LINEAR_SCAN_BUDGET_MS,
  );

  // A value ends at a delimiter, and none of these joiners is one, so each
  // input is one long run of harmless names. Re-reading a name's value would
  // cost one scan of the tail per name.
  it.each([
    ['a pipe', 'k1=v1|'],
    ['a slash', 'k1=v1/'],
    ['base64 padding', 'QUJDRA=='],
    ['nothing at all', 'k='],
  ])(
    'stays linear over 500,000 characters of pairs joined by %s',
    (_name, unit) => {
      const text = unit.repeat(Math.ceil(500_000 / unit.length));
      expect(sanitizeErrorText(text, -1).text).toBe(text);
    },
    LINEAR_SCAN_BUDGET_MS,
  );

  it('does not expand a dollar pattern the payload supplied', () => {
    const text = 'token=abc and the literal $& $1 $` survive';
    expect(sanitizeErrorText(text, -1).text).toBe(
      'token=[REDACTED] and the literal $& $1 $` survive',
    );
  });

  it('is idempotent, so a second pass adds no second marker', () => {
    const once = sanitizeErrorText('Authorization: Bearer abc', -1).text;
    expect(sanitizeErrorText(once, -1).text).toBe(once);
  });

  it('redacts before it truncates, so a cut credential is still gone', () => {
    const result = sanitizeErrorText('password=supersecretvalue', 12);
    expect(result.text).not.toContain('supersecret');
    expect(result.text).toBe('password=[RE...[TRUNCATED]');
    expect(result.truncated).toBe(true);
  });

  it('reports the loss when the text passes the inspection ceiling', () => {
    const result = sanitizeErrorText('x'.repeat(4_000_050), -1);
    expect(result.text).toHaveLength(4_000_000);
    expect(result.truncated).toBe(true);
  });

  it(
    'scans a long unbroken word once, not once per character',
    () => {
      const word = 'x'.repeat(500_000);
      expect(sanitizeErrorText(`${word} token=abc`, -1).text).toBe(
        `${word} token=[REDACTED]`,
      );
    },
    LINEAR_SCAN_BUDGET_MS,
  );
});

describe('recursiveSmartTruncate on strings', () => {
  it('redacts a credential inside a nested string', () => {
    const result = recursiveSmartTruncate(
      {note: 'call failed, Authorization: Bearer oauth-token-1'},
      -1,
    );
    expect(result.value).toEqual({
      note: 'call failed, Authorization: [REDACTED]',
    });
    expect(result.truncated).toBe(false);
  });

  it('redacts a credential inside an opaque JSON string', () => {
    const result = recursiveSmartTruncate(
      {result: '{"user":"ada","access_token":"oauth-token-1"}'},
      -1,
    );
    expect(result.value).toEqual({
      result: '{"user":"ada","access_token":"[REDACTED]"}',
    });
  });

  it('re-serializes a blob so a duplicate key cannot smuggle a secret', () => {
    const result = recursiveSmartTruncate(
      {body: '{"token":"secret-one","token":"secret-two"}'},
      -1,
    );
    expect(result.value).toEqual({body: '{"token":"[REDACTED]"}'});
    expect(JSON.stringify(result.value)).not.toContain('secret-one');
  });

  it('redacts a string that looks like JSON but does not parse', () => {
    const result = recursiveSmartTruncate({body: '{"token": "abc"'}, -1);
    expect(result.value).toEqual({body: '{"token": "[REDACTED]"'});
    expect(result.truncated).toBe(false);
  });

  it.each([
    '[INFO] request finished',
    '[urgent] find flights to SFO',
    "{'status': 'ok', 'rows': 3}",
    '[link](https://example.com) see the docs',
  ])('keeps bracketed prose byte-identical: %s', (prose) => {
    const result = recursiveSmartTruncate({q: prose}, -1);
    expect(result.value).toEqual({q: prose});
    expect(result.truncated).toBe(false);
  });

  it('redacts a container-shaped string past the inspection ceiling', () => {
    const huge = `["password=hunter2",${'"x",'.repeat(1_000_001)}"x"]`;
    expect(huge.length).toBeGreaterThan(4_000_000);
    const result = recursiveSmartTruncate({body: huge}, -1);
    expect(result.truncated).toBe(true);
    const body = result.value;
    if (typeof body !== 'object' || body === null || !('body' in body)) {
      expect.fail('expected a record carrying body');
    }
    const text = String(body.body);
    expect(text).toContain('["password=[REDACTED]",');
    expect(text).not.toContain('hunter2');
    expect(text.length).toBeLessThan(huge.length);
  });

  it('redacts a credential nested inside a blob inside a blob', () => {
    const inner = JSON.stringify({api_key: 'AIzaSyC7'});
    const result = recursiveSmartTruncate({body: JSON.stringify({inner})}, -1);
    expect(JSON.stringify(result.value)).not.toContain('AIzaSyC7');
  });
});
