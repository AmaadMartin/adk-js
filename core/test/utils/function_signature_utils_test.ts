/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {parseDestructuredParameters} from '../../src/utils/function_signature_utils.js';

/** A function that reports `text` as its source, the way a bundler would. */
function withSource(text: string): () => unknown {
  const fn = () => undefined;
  fn.toString = () => text;
  return fn;
}

class Recipes {
  static bake({flour, sugar = 1}: {flour: number; sugar?: number}) {
    return flour + sugar;
  }

  *steps({count}: {count: number}) {
    yield count;
  }
}

describe('parseDestructuredParameters', () => {
  describe('parameter names and defaults', () => {
    it('reports every key as required when none has a default', () => {
      expect(
        parseDestructuredParameters(({a, b}: {a: number; b: number}) => a + b),
      ).toEqual({names: ['a', 'b'], required: ['a', 'b'], hasRest: false});
    });

    it('drops a key with a default from the required set', () => {
      expect(
        parseDestructuredParameters(
          ({a, b = 2}: {a: number; b?: number}) => a + b,
        ),
      ).toEqual({names: ['a', 'b'], required: ['a'], hasRest: false});
    });

    it('reports a rest element without naming it', () => {
      expect(
        parseDestructuredParameters(({a, ...rest}: {a: number}) => [a, rest]),
      ).toEqual({names: ['a'], required: ['a'], hasRest: true});
    });

    it('reports the source key of a renamed binding', () => {
      expect(
        parseDestructuredParameters(({a: alpha}: {a: number}) => alpha),
      ).toEqual({names: ['a'], required: ['a'], hasRest: false});
    });

    it('reports a renamed binding with a default as optional', () => {
      expect(
        parseDestructuredParameters(
          ({a: alpha = 1, b}: {a?: number; b: number}) => alpha + b,
        ),
      ).toEqual({names: ['a', 'b'], required: ['b'], hasRest: false});
    });

    it('reports the outer key of a nested pattern only', () => {
      expect(
        parseDestructuredParameters(({a: {b}}: {a: {b: number}}) => b),
      ).toEqual({names: ['a'], required: ['a'], hasRest: false});
    });

    it('returns an empty result for an empty pattern', () => {
      expect(parseDestructuredParameters(withSource('({}) => 1'))).toEqual({
        names: [],
        required: [],
        hasRest: false,
      });
    });

    it('reads the keys of a pattern that has its own default', () => {
      expect(
        parseDestructuredParameters(
          ({a, b}: {a: number; b: number} = {a: 1, b: 2}) => a + b,
        ),
      ).toEqual({names: ['a', 'b'], required: ['a', 'b'], hasRest: false});
    });

    it('ignores the second parameter', () => {
      expect(
        parseDestructuredParameters(
          ({a}: {a: number}, toolContext?: unknown) => [a, toolContext],
        ),
      ).toEqual({names: ['a'], required: ['a'], hasRest: false});
    });
  });

  describe('callable forms', () => {
    it('parses an async arrow function', () => {
      expect(
        parseDestructuredParameters(async ({a}: {a: number}) => a),
      ).toEqual({names: ['a'], required: ['a'], hasRest: false});
    });

    it('parses a named function declaration', () => {
      expect(
        parseDestructuredParameters(function pick({a}: {a: number}) {
          return a;
        }),
      ).toEqual({names: ['a'], required: ['a'], hasRest: false});
    });

    it('parses an async function declaration', () => {
      expect(
        parseDestructuredParameters(async function pick({a}: {a: number}) {
          return a;
        }),
      ).toEqual({names: ['a'], required: ['a'], hasRest: false});
    });

    it('parses object method shorthand', () => {
      const holder = {
        pick({a}: {a: number}) {
          return a;
        },
      };
      expect(parseDestructuredParameters(holder.pick)).toEqual({
        names: ['a'],
        required: ['a'],
        hasRest: false,
      });
    });

    it('parses a class static method', () => {
      expect(parseDestructuredParameters(Recipes.bake)).toEqual({
        names: ['flour', 'sugar'],
        required: ['flour'],
        hasRest: false,
      });
    });

    it('parses a generator method', () => {
      expect(parseDestructuredParameters(Recipes.prototype.steps)).toEqual({
        names: ['count'],
        required: ['count'],
        hasRest: false,
      });
    });
  });

  describe('defaults containing delimiters', () => {
    it('keeps a default object literal out of the split', () => {
      expect(
        parseDestructuredParameters(
          ({a = {x: 1, y: 2}, b}: {a?: object; b: number}) => [a, b],
        ),
      ).toEqual({names: ['a', 'b'], required: ['b'], hasRest: false});
    });

    it('keeps a single-quoted default full of delimiters out of the split', () => {
      expect(
        parseDestructuredParameters(
          ({a = '},{', b}: {a?: string; b: number}) => [a, b],
        ),
      ).toEqual({names: ['a', 'b'], required: ['b'], hasRest: false});
    });

    it('keeps a double-quoted default full of delimiters out of the split', () => {
      expect(
        parseDestructuredParameters(
          ({a = "}'{", b}: {a?: string; b: number}) => [a, b],
        ),
      ).toEqual({names: ['a', 'b'], required: ['b'], hasRest: false});
    });

    it('keeps a template default full of delimiters out of the split', () => {
      expect(
        parseDestructuredParameters(
          ({a = `},{`, b}: {a?: string; b: number}) => [a, b],
        ),
      ).toEqual({names: ['a', 'b'], required: ['b'], hasRest: false});
    });

    it('keeps an escaped quote inside a default out of the split', () => {
      expect(
        parseDestructuredParameters(
          ({a = '\'"},{', b}: {a?: string; b: number}) => [a, b],
        ),
      ).toEqual({names: ['a', 'b'], required: ['b'], hasRest: false});
    });

    it('reads a default arrow function as a default', () => {
      expect(
        parseDestructuredParameters(
          ({a = () => 1, b}: {a?: () => number; b: number}) => [a, b],
        ),
      ).toEqual({names: ['a', 'b'], required: ['b'], hasRest: false});
    });

    it('does not mistake a division for a comment', () => {
      expect(
        parseDestructuredParameters(
          ({a = 1 / 2, b}: {a?: number; b: number}) => [a, b],
        ),
      ).toEqual({names: ['a', 'b'], required: ['b'], hasRest: false});
    });
  });

  describe('comments inside the pattern', () => {
    it('ignores a line comment', () => {
      expect(
        parseDestructuredParameters(
          ({
            a, // the first one
            b,
          }: {
            a: number;
            b: number;
          }) => a + b,
        ),
      ).toEqual({names: ['a', 'b'], required: ['a', 'b'], hasRest: false});
    });

    it('ignores a block comment', () => {
      expect(
        parseDestructuredParameters(
          ({a /* the first one */, b}: {a: number; b: number}) => a + b,
        ),
      ).toEqual({names: ['a', 'b'], required: ['a', 'b'], hasRest: false});
    });
  });

  describe('patterns the scanner refuses', () => {
    it('returns undefined for a plain identifier parameter', () => {
      expect(
        parseDestructuredParameters((input: number) => input),
      ).toBeUndefined();
    });

    it('returns undefined for no parameters at all', () => {
      expect(parseDestructuredParameters(() => 1)).toBeUndefined();
    });

    it('returns undefined for an unparenthesised arrow parameter', () => {
      expect(parseDestructuredParameters(withSource('x => x'))).toBeUndefined();
    });

    it('returns undefined for a computed key', () => {
      const key = 'z';
      expect(
        parseDestructuredParameters(
          ({[key]: value}: Record<string, number>) => value,
        ),
      ).toBeUndefined();
    });

    it('returns undefined for a bound function', () => {
      expect(
        parseDestructuredParameters((({a}: {a: number}) => a).bind(null)),
      ).toBeUndefined();
    });

    it('returns undefined for a source with no parameter list', () => {
      expect(
        parseDestructuredParameters(withSource('class A {}')),
      ).toBeUndefined();
    });

    it('returns undefined when the pattern never closes', () => {
      expect(parseDestructuredParameters(withSource('({a, b'))).toBeUndefined();
    });
  });

  it('reads the keys out of bundler-minified source', () => {
    // The published package is bundled by esbuild. Destructuring keeps the
    // source key and renames only the binding, so derivation survives the
    // bundle; this is the literal output of
    // `esbuild --minify --target=node10.4` for
    // `({city, days = 3, ...rest}, ctx) => ({})`.
    expect(
      parseDestructuredParameters(
        withSource('({city:o,days:t=3,...c},e)=>({})'),
      ),
    ).toEqual({names: ['city', 'days'], required: ['city'], hasRest: true});
  });
});
