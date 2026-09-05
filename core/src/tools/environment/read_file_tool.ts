/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {BaseEnvironment} from '../../environment/base_environment.js';
import {formatError, isFileNotFoundError} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {MAX_OUTPUT_CHARS} from './constants.js';
import {truncate} from './truncate.js';

/** Width of the line-number column, matching Python's `f'{n:6d}'`. */
const LINE_NUMBER_WIDTH = 6;

/**
 * Matches one line and its terminator. The `$` alternative also matches once
 * past the last line, producing a trailing empty entry that callers drop.
 */
const LINE_PATTERN = /[^\r\n]*(?:\r\n|\r|\n|$)/g;

/**
 * Splits `text` into lines, keeping each line's terminator.
 *
 * Breaks on `\r\n`, `\n` and a bare `\r`, reproducing Python's
 * `bytes.splitlines(keepends=True)`. A file with no trailing newline still
 * yields its last line.
 */
function splitLinesKeepingTerminators(text: string): string[] {
  const lines = Array.from(text.matchAll(LINE_PATTERN), (match) => match[0]);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Whether `value` is an integer line number, or absent.
 *
 * A boolean is rejected by the `typeof` test, where Python needs an explicit
 * `not isinstance(value, bool)`.
 */
function isOptionalLineNumber(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value))
  );
}

/** Options for {@link ReadFileTool}. */
export interface ReadFileToolOptions {
  /** Character cap applied to the returned file content. */
  maxOutputChars?: number;
}

/** Read a file from the environment. */
@experimental
export class ReadFileTool extends BaseTool {
  private readonly maxOutputChars: number;

  constructor(
    private readonly environment: BaseEnvironment,
    options: ReadFileToolOptions = {},
  ) {
    super({
      name: 'ReadFile',
      description:
        'Read the contents of a file in the environment. ' +
        'Returns the file content with line numbers.',
    });
    this.maxOutputChars = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: 'Path of the file to read within the environment.',
          },
          start_line: {
            type: Type.INTEGER,
            description:
              'First line to return (1-based, inclusive). Defaults to 1.',
          },
          end_line: {
            type: Type.INTEGER,
            description:
              'Last line to return (1-based, inclusive). Defaults to end of file.',
          },
        },
        required: ['path'],
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const filePath = args['path'];
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return {status: 'error', error: '`path` is required.'};
    }
    // `null` and an absent key both mean "not provided", as Python's `None`
    // does.
    const startLine = args['start_line'] ?? undefined;
    if (!isOptionalLineNumber(startLine)) {
      return {
        status: 'error',
        error: '`start_line` must be an integer if provided.',
      };
    }
    const endLine = args['end_line'] ?? undefined;
    if (!isOptionalLineNumber(endLine)) {
      return {
        status: 'error',
        error: '`end_line` must be an integer if provided.',
      };
    }

    let data: Uint8Array;
    try {
      // The whole file is loaded into memory, as adk-python does. Reading a
      // very large file can exhaust the heap.
      data = await this.environment.readFile(filePath);
    } catch (e: unknown) {
      if (isFileNotFoundError(e)) {
        return {status: 'error', error: `File not found: ${filePath}`};
      }
      return {status: 'error', error: formatError(e)};
    }

    // `ignoreBOM` keeps a leading byte-order mark, which Python's
    // `errors='replace'` decode also keeps. Invalid bytes become U+FFFD.
    const text = new TextDecoder('utf-8', {ignoreBOM: true}).decode(data);
    const lines = splitLinesKeepingTerminators(text);
    const total = lines.length;
    // `||` rather than `??`: Python reads `start_line or 1`, so an explicit 0
    // means "unset" on both sides.
    const start = Math.max(1, startLine || 1);
    const end = Math.min(total, endLine || total);
    if (start > total) {
      return {
        status: 'error',
        error: `\`start_line\` ${start} exceeds file length (${total} lines).`,
        total_lines: total,
      };
    }
    if (start > end) {
      return {
        status: 'error',
        error: `\`start_line\` (${start}) is after \`end_line\` (${end}).`,
        total_lines: total,
      };
    }

    const numbered = lines
      .slice(start - 1, end)
      .map(
        (line, i) =>
          `${String(start + i).padStart(LINE_NUMBER_WIDTH, ' ')}\t${line}`,
      )
      .join('');
    const result: Record<string, unknown> = {
      status: 'ok',
      content: truncate(numbered, this.maxOutputChars),
    };
    if (start > 1 || end < total) {
      result['total_lines'] = total;
    }
    return result;
  }
}
