/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {validateIdentifierName} from '../../src/utils/identifier_utils.js';

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
