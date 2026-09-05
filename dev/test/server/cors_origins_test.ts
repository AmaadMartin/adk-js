/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  corsOriginOption,
  parseCorsOrigins,
} from '../../src/server/cors_origins.js';

describe('parseCorsOrigins', () => {
  it.each([
    {
      id: 'literal_only',
      input: ['https://example.com', 'https://test.com'],
      origins: ['https://example.com', 'https://test.com'],
      pattern: undefined,
    },
    {
      id: 'regex_only',
      input: [
        'regex:https://.*\\.example\\.com',
        'regex:https://.*\\.test\\.com',
      ],
      origins: [],
      pattern: 'https://.*\\.example\\.com|https://.*\\.test\\.com',
    },
    {
      id: 'mixed',
      input: [
        'https://example.com',
        'regex:https://.*\\.example\\.com',
        'https://test.com',
        'regex:https://.*\\.test\\.com',
      ],
      origins: ['https://example.com', 'https://test.com'],
      pattern: 'https://.*\\.example\\.com|https://.*\\.test\\.com',
    },
    {
      id: 'wildcard',
      input: ['*'],
      origins: ['*'],
      pattern: undefined,
    },
    {
      id: 'single_regex',
      input: ['regex:https://.*\\.example\\.com'],
      origins: [],
      pattern: 'https://.*\\.example\\.com',
    },
  ])('splits the $id origin list', ({input, origins, pattern}) => {
    const parsed = parseCorsOrigins(input);

    expect(parsed.origins).toEqual(origins);
    if (pattern === undefined) {
      expect(parsed.originRegex).toBeUndefined();
    } else {
      expect(parsed.originRegex).toEqual(new RegExp(`^(?:${pattern})$`));
    }
  });

  it('drops a regex entry with an empty pattern', () => {
    const parsed = parseCorsOrigins(['regex:', 'https://example.com']);

    expect(parsed.origins).toEqual(['https://example.com']);
    expect(parsed.originRegex).toBeUndefined();
  });

  it('keeps the other patterns when one regex entry is empty', () => {
    const parsed = parseCorsOrigins(['regex:', 'regex:https://a\\.example']);

    expect(parsed.originRegex).toEqual(/^(?:https:\/\/a\.example)$/);
  });

  it('treats an undefined origin list as empty', () => {
    expect(parseCorsOrigins(undefined)).toEqual({origins: []});
  });

  it('treats an empty origin list as empty', () => {
    expect(parseCorsOrigins([])).toEqual({origins: []});
  });

  it('treats a bare literal string as a one-entry list', () => {
    const parsed = parseCorsOrigins('https://example.com');

    expect(parsed.origins).toEqual(['https://example.com']);
    expect(parsed.originRegex).toBeUndefined();
  });

  it('treats a bare regex string as a one-entry list', () => {
    const parsed = parseCorsOrigins('regex:https://.*\\.example\\.com');

    expect(parsed.origins).toEqual([]);
    expect(parsed.originRegex).toEqual(/^(?:https:\/\/.*\.example\.com)$/);
  });

  it('anchors the pattern so a suffixed impostor origin is refused', () => {
    const {originRegex} = parseCorsOrigins([
      'regex:https://.*\\.example\\.com',
    ]);

    expect(originRegex?.test('https://a.example.com')).toBe(true);
    expect(originRegex?.test('https://a.example.com.evil.com')).toBe(false);
  });

  it('binds the alternation inside the anchors', () => {
    const {originRegex} = parseCorsOrigins([
      'regex:https://.*\\.example\\.com',
      'regex:https://.*\\.test\\.com',
    ]);

    expect(originRegex?.test('https://a.example.com')).toBe(true);
    expect(originRegex?.test('https://a.test.com')).toBe(true);
    expect(originRegex?.test('https://a.example.com.evil.com')).toBe(false);
    expect(originRegex?.test('https://a.test.com.evil.com')).toBe(false);
  });

  it('propagates the SyntaxError of an invalid pattern', () => {
    expect(() => parseCorsOrigins(['regex:https://(unclosed'])).toThrow(
      SyntaxError,
    );
  });
});

describe('corsOriginOption', () => {
  it('keeps a wildcard a string so cors accepts every origin', () => {
    expect(corsOriginOption(parseCorsOrigins(['*']))).toBe('*');
  });

  it('keeps a wildcard a string even beside a pattern', () => {
    expect(
      corsOriginOption(parseCorsOrigins(['*', 'regex:https://a\\.b'])),
    ).toBe('*');
  });

  it('passes literal origins as an array', () => {
    expect(corsOriginOption(parseCorsOrigins(['https://example.com']))).toEqual(
      ['https://example.com'],
    );
  });

  it('appends the pattern after the literal origins', () => {
    const option = corsOriginOption(
      parseCorsOrigins(['https://example.com', 'regex:https://a\\.b']),
    );

    expect(option).toEqual(['https://example.com', /^(?:https:\/\/a\.b)$/]);
  });
});
