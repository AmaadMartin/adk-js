/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isIdentifier,
  validateIdentifierName,
} from '../../src/utils/identifier_utils.js';

describe('validateIdentifierName', () => {
  it.each(['foo', '_foo', '$foo', 'F'])(
    'accepts %s, which starts with a letter, underscore or dollar',
    (name) => {
      expect(validateIdentifierName('Node', name)).toBe(name);
    },
  );

  it.each(['foo_bar', 'foo-bar', 'foo9', '__START__'])(
    'accepts %s, which continues with a digit, underscore or hyphen',
    (name) => {
      expect(validateIdentifierName('Node', name)).toBe(name);
    },
  );

  it.each(['agenté', '日本語'])('accepts the non-ASCII name %s', (name) => {
    expect(validateIdentifierName('Node', name)).toBe(name);
  });

  it('rejects an empty name', () => {
    expect(() => validateIdentifierName('Node', '')).toThrow(
      /must be a valid identifier/,
    );
  });

  it.each(['1abc', '-abc'])(
    'rejects %s, which starts with a digit or a hyphen',
    (name) => {
      expect(() => validateIdentifierName('Node', name)).toThrow(
        /must be a valid identifier/,
      );
    },
  );

  it.each(['my name', ' foo', 'foo ', 'a.b', 'a!', 'a/b', 'foo\nbar'])(
    'rejects %j, which holds whitespace or punctuation',
    (name) => {
      expect(() => validateIdentifierName('Node', name)).toThrow(
        /must be a valid identifier/,
      );
    },
  );

  it('names the offending value and the kind', () => {
    expect(() => validateIdentifierName('Node', 'my node')).toThrow(
      'Found invalid node name: "my node". Node name must be a valid identifier. It should start with a letter (a-z, A-Z) or an underscore (_), and can only contain letters, digits (0-9), underscores, and hyphens.',
    );
    expect(() => validateIdentifierName('Agent', 'my agent')).toThrow(
      'Found invalid agent name: "my agent". Agent name must be a valid identifier. It should start with a letter (a-z, A-Z) or an underscore (_), and can only contain letters, digits (0-9), underscores, and hyphens.',
    );
  });
});

describe('isIdentifier', () => {
  it('accepts a name starting with a letter, an underscore or a dollar', () => {
    expect(isIdentifier('agent')).toBe(true);
    expect(isIdentifier('Agent')).toBe(true);
    expect(isIdentifier('_private')).toBe(true);
    expect(isIdentifier('$root')).toBe(true);
    expect(isIdentifier('__START__')).toBe(true);
  });

  it('accepts digits, hyphens, underscores and dollars after the first', () => {
    expect(isIdentifier('n1')).toBe(true);
    expect(isIdentifier('snake_case')).toBe(true);
    expect(isIdentifier('camelCase')).toBe(true);
    expect(isIdentifier('with-hyphen')).toBe(true);
    expect(isIdentifier('a$b')).toBe(true);
  });

  it('accepts Unicode ID_Start and ID_Continue characters', () => {
    expect(isIdentifier('caf\u00e9')).toBe(true);
    expect(isIdentifier('\u0394elta')).toBe(true);
    expect(isIdentifier('\u65e5\u672c\u8a9e')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isIdentifier('')).toBe(false);
  });

  it('rejects a first character that is not ID_Start, $ or _', () => {
    expect(isIdentifier('1abc')).toBe(false);
    expect(isIdentifier('-abc')).toBe(false);
    expect(isIdentifier(' abc')).toBe(false);
  });

  it('rejects a later character that is not ID_Continue, $, _ or -', () => {
    expect(isIdentifier('my node')).toBe(false);
    expect(isIdentifier('a.b')).toBe(false);
    expect(isIdentifier('a/b')).toBe(false);
    expect(isIdentifier('a\u00a0b')).toBe(false);
  });

  it('rejects an emoji, which is neither ID_Start nor ID_Continue', () => {
    expect(isIdentifier('\u{1f600}start')).toBe(false);
    expect(isIdentifier('emoji\u{1f600}')).toBe(false);
  });
});
