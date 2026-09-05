/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Maximum nesting depth accepted. A payload nested deeper is rejected, so a
 * pathological input cannot exhaust the stack.
 */
const MAX_DEPTH = 32;

/** Marks a parse that did not succeed. It never leaves this module. */
const FAILED = Symbol('python literal parse failure');

/** The three Python literal keywords, and the JavaScript value of each. */
const KEYWORDS = new Map<string, boolean | null>([
  ['True', true],
  ['False', false],
  ['None', null],
]);

/** The backslash escapes accepted inside a string. */
const STRING_ESCAPES = new Map<string, string>([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['b', '\b'],
  ['f', '\f'],
  ['v', '\v'],
  ['\\', '\\'],
  ["'", "'"],
  ['"', '"'],
  ['\n', ''],
]);

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

/**
 * Parses a Python literal expression.
 *
 * This accepts the subset of Python that `ast.literal_eval` accepts and that a
 * model realistically emits as a tool-call argument payload: dicts, lists,
 * tuples, quoted strings, numbers, `True`, `False` and `None`. Tuples become
 * arrays, `None` becomes `null`, and a non-string dict key becomes its
 * `String()` form.
 *
 * The source is never evaluated. It is read by a recursive-descent parser, so
 * a payload from a model cannot execute anything.
 *
 * @param source The expression to parse.
 * @returns The parsed value, or `undefined` when `source` is not a literal
 *     this parser accepts. A successful parse never returns `undefined`,
 *     because `None` maps to `null`.
 */
export function parsePythonLiteral(source: string): unknown {
  const value = new PythonLiteralParser(source).parse();
  return value === FAILED ? undefined : value;
}

/** A cursor over one source string, consumed by a single {@link parse} call. */
class PythonLiteralParser {
  private index = 0;

  constructor(private readonly source: string) {}

  /** Reads one value and requires it to span the whole source. */
  parse(): unknown {
    const value = this.readValue(0);
    if (value === FAILED) {
      return FAILED;
    }
    this.skipWhitespace();
    return this.index === this.source.length ? value : FAILED;
  }

  private readValue(depth: number): unknown {
    if (depth > MAX_DEPTH) {
      return FAILED;
    }
    this.skipWhitespace();
    switch (this.source[this.index]) {
      case '{':
        return this.readDict(depth);
      case '[':
        return this.readSequence(']', depth);
      case '(':
        return this.readSequence(')', depth);
      case "'":
        return this.readString("'");
      case '"':
        return this.readString('"');
      default:
        return this.readAtom();
    }
  }

  private readDict(depth: number): unknown {
    this.index++;
    const entries = new Map<string, unknown>();
    let expectSeparator = false;
    while (!this.consume('}')) {
      if (expectSeparator && !this.consume(',')) {
        return FAILED;
      }
      if (expectSeparator && this.consume('}')) {
        break;
      }
      const key = this.readValue(depth + 1);
      if (key === FAILED || !this.consume(':')) {
        return FAILED;
      }
      const value = this.readValue(depth + 1);
      if (value === FAILED) {
        return FAILED;
      }
      entries.set(dictKey(key), value);
      expectSeparator = true;
    }
    return Object.fromEntries(entries);
  }

  private readSequence(close: string, depth: number): unknown {
    this.index++;
    const items: unknown[] = [];
    let expectSeparator = false;
    while (!this.consume(close)) {
      if (expectSeparator && !this.consume(',')) {
        return FAILED;
      }
      if (expectSeparator && this.consume(close)) {
        break;
      }
      const item = this.readValue(depth + 1);
      if (item === FAILED) {
        return FAILED;
      }
      items.push(item);
      expectSeparator = true;
    }
    return items;
  }

  private readString(quote: string): unknown {
    let value = '';
    let i = this.index + 1;
    while (i < this.source.length) {
      const char = this.source[i];
      if (char === quote) {
        this.index = i + 1;
        return value;
      }
      if (char !== '\\') {
        value += char;
        i++;
        continue;
      }
      const escape = STRING_ESCAPES.get(this.source.slice(i + 1, i + 2));
      if (escape === undefined) {
        return FAILED;
      }
      value += escape;
      i += 2;
    }
    return FAILED;
  }

  private readAtom(): unknown {
    const rest = this.source.slice(this.index);
    const identifier = IDENTIFIER_PATTERN.exec(rest);
    if (identifier) {
      const keyword = KEYWORDS.get(identifier[0]);
      if (keyword === undefined) {
        return FAILED;
      }
      this.index += identifier[0].length;
      return keyword;
    }
    const number = NUMBER_PATTERN.exec(rest);
    if (!number) {
      return FAILED;
    }
    this.index += number[0].length;
    return Number(number[0]);
  }

  /** Skips whitespace and consumes `char` if it is next. */
  private consume(char: string): boolean {
    this.skipWhitespace();
    if (this.source[this.index] !== char) {
      return false;
    }
    this.index++;
    return true;
  }

  private skipWhitespace(): void {
    while (
      this.index < this.source.length &&
      /\s/.test(this.source[this.index])
    ) {
      this.index++;
    }
  }
}

/** Renders a parsed dict key as the property name it maps to. */
function dictKey(key: unknown): string {
  return typeof key === 'string' ? key : String(key);
}
