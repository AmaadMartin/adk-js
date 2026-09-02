/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reads the object-destructuring pattern of a function's first parameter.
 *
 * TypeScript erases parameter types, so the only signature information left at
 * runtime is the source text `Function.prototype.toString()` returns. That text
 * still carries the property keys of a destructuring pattern, because
 * destructuring keeps the source key and renames only the local binding:
 * `({city, days = 3}, ctx)` minifies to `({city:o,days:t=3},c)`.
 *
 * The scanner is deliberately conservative. It returns `undefined` for anything
 * it cannot classify — a plain identifier parameter, a computed key, a nested
 * template literal — because a wrong parameter list is worse than none.
 */

/** The delimiter that closes each delimiter the scanner tracks. */
const CLOSERS = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);

const CLOSING = new Set(CLOSERS.values());

/**
 * A string literal, a template literal, or a comment: runs of text the scanner
 * steps over whole so that a delimiter inside one is not counted.
 */
const NON_CODE =
  /'(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*"|`(?:[^`\\]|\\[\s\S])*`|\/\/[^\n]*\n?|\/\*[\s\S]*?\*\//y;

/** The opening brace of a destructuring pattern, just after the `(`. */
const PATTERN_START = /\s*\{/y;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The parameters a function destructures out of its first argument. */
export interface DestructuredParameters {
  /** Property keys in declaration order. */
  names: string[];
  /** The subset of `names` declared without a default value. */
  required: string[];
  /** Whether the pattern ends in a rest element (`...rest`). */
  hasRest: boolean;
}

/**
 * Returns the property keys of `fn`'s object-destructuring first parameter, or
 * `undefined` when the first parameter is not a destructuring pattern or the
 * source cannot be read.
 */
export function parseDestructuredParameters(
  fn: (...args: never[]) => unknown,
): DestructuredParameters | undefined {
  const source = fn.toString();
  const open = source.indexOf('(');
  const arrow = source.indexOf('=>');
  if (open === -1 || (arrow !== -1 && arrow < open)) {
    return undefined;
  }

  PATTERN_START.lastIndex = open + 1;
  if (PATTERN_START.exec(source) === null) {
    return undefined;
  }
  const patternStart = PATTERN_START.lastIndex - 1;

  const patternEnd = findMatching(source, patternStart);
  if (patternEnd === undefined) {
    return undefined;
  }
  return parsePattern(
    stripComments(source.slice(patternStart + 1, patternEnd)),
  );
}

/** Replaces every comment in `text` with a space, leaving literals intact. */
function stripComments(text: string): string {
  let stripped = '';
  let index = 0;
  while (index < text.length) {
    const skipped = skipNonCode(text, index);
    if (skipped === index) {
      stripped += text[index];
      index++;
      continue;
    }
    const run = text.slice(index, skipped);
    stripped += run.startsWith('/') ? ' ' : run;
    index = skipped;
  }
  return stripped;
}

/** Reads the entries between the braces of a destructuring pattern. */
function parsePattern(inner: string): DestructuredParameters | undefined {
  const names: string[] = [];
  const required: string[] = [];
  let hasRest = false;

  for (const rawEntry of splitTopLevel(inner)) {
    const entry = rawEntry.trim();
    if (entry === '') {
      continue;
    }
    if (entry.startsWith('...')) {
      hasRest = true;
      continue;
    }
    const separators = findTopLevel(entry, ':=');
    const keyEnd = separators.length === 0 ? entry.length : separators[0];
    const name = entry.slice(0, keyEnd).trim();
    if (!IDENTIFIER.test(name)) {
      return undefined;
    }
    names.push(name);
    if (!separators.some((index) => entry[index] === '=')) {
      required.push(name);
    }
  }

  return {names, required, hasRest};
}

/**
 * Returns the index of the delimiter closing the one at `open`, or `undefined`
 * when the source ends first.
 */
function findMatching(source: string, open: number): number | undefined {
  const stack: string[] = [];
  for (let index = open; index < source.length; index++) {
    const skipped = skipNonCode(source, index);
    if (skipped > index) {
      index = skipped - 1;
      continue;
    }
    const closer = CLOSERS.get(source[index]);
    if (closer !== undefined) {
      stack.push(closer);
    } else if (source[index] === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) {
        return index;
      }
    }
  }
  return undefined;
}

/** Splits `text` on the commas that are not nested inside a delimiter. */
function splitTopLevel(text: string): string[] {
  const entries: string[] = [];
  let start = 0;
  for (const comma of findTopLevel(text, ',')) {
    entries.push(text.slice(start, comma));
    start = comma + 1;
  }
  entries.push(text.slice(start));
  return entries;
}

/**
 * Returns the indices at which one of the `targets` characters appears in
 * `text` outside every nested delimiter, string literal and comment.
 */
function findTopLevel(text: string, targets: string): number[] {
  const found: number[] = [];
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const skipped = skipNonCode(text, index);
    if (skipped > index) {
      index = skipped - 1;
      continue;
    }
    const char = text[index];
    if (CLOSERS.has(char)) {
      depth++;
    } else if (CLOSING.has(char)) {
      depth--;
    } else if (depth === 0 && targets.includes(char)) {
      found.push(index);
    }
  }
  return found;
}

/**
 * Returns the index just past the string literal, template literal or comment
 * starting at `index`, or `index` itself when none starts there.
 */
function skipNonCode(source: string, index: number): number {
  NON_CODE.lastIndex = index;
  const match = NON_CODE.exec(source);
  return match === null ? index : index + match[0].length;
}
