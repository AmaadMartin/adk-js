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

/** Width of the space-padded line-number column that precedes each line. */
const LINE_NUMBER_WIDTH = 6;

/**
 * A BOM is content, not an encoding marker, once the encoding is already known.
 * `ignoreBOM: true` keeps it, matching Python's `bytes.decode('utf-8')`.
 */
const DECODER = new TextDecoder('utf-8', {ignoreBOM: true});

/** One line plus its terminator. The match at end of input is empty. */
const LINE_WITH_TERMINATOR = /[^\r\n]*(?:\r\n|\r|\n|$)/g;

/** A successful read. `total_lines` appears only for a partial read. */
interface ReadFileSuccess {
  status: 'ok';
  content: string;
  total_lines?: number;
}

/** A failed read. `total_lines` appears only for the two range errors. */
interface ReadFileFailure {
  status: 'error';
  error: string;
  total_lines?: number;
}

/**
 * Splits text into lines, keeping each line's terminator.
 *
 * Breaks on `\r\n`, `\r` and `\n` only, which is what Python's
 * `bytes.splitlines()` recognises. Python's `str.splitlines()` would also break
 * on `\v`, `\f`, `\x85` and `\u2028`; adk-python never sees those breaks
 * because it splits the raw bytes.
 */
function splitLinesKeepingTerminators(text: string): string[] {
  const lines = [...text.matchAll(LINE_WITH_TERMINATOR)].map(
    (match) => match[0],
  );
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Whether a model-supplied line number is absent or a whole number.
 *
 * `null` and `undefined` both count as absent, matching adk-python's
 * `value is not None` guard. A boolean is rejected without the explicit test
 * Python needs, because `bool` subclasses `int` there but `typeof true` is
 * `'boolean'` here.
 */
function isAbsentOrInteger(value: unknown): value is number | null | undefined {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value))
  );
}

/** Options for {@link ReadFileTool}. */
export interface ReadFileToolOptions {
  /**
   * Character cap applied to the returned content. Defaults to 30000. An
   * explicit `0` is honoured and caps the content to the truncation notice.
   */
  maxOutputChars?: number;
}

/**
 * Reads a file from a {@link BaseEnvironment} and returns it with line numbers.
 *
 * The model calls this instead of running `cat`, `head` or `sed` through
 * {@link BaseEnvironment.execute}, so a path it supplies never reaches a shell
 * command line. The tool never executes a command and never writes a file.
 *
 * It resolves with a plain object and never rejects: every failure comes back
 * as `{status: 'error', error}`. A missing file is recognised by Node's
 * `ENOENT` code, so an environment that reports a missing file some other way
 * falls through to the generic error message instead.
 *
 * The whole file is read into memory before it is sliced, which mirrors both
 * adk-python and the `Uint8Array` that {@link BaseEnvironment.readFile}
 * returns.
 *
 * @example
 * ```ts
 * const tool = new ReadFileTool(environment);
 * // {status: 'ok', content: '     2\tbeta\n', total_lines: 4}
 * ```
 */
@experimental
export class ReadFileTool extends BaseTool {
  private readonly environment: BaseEnvironment;
  private readonly maxOutputChars: number;

  constructor(environment: BaseEnvironment, options: ReadFileToolOptions = {}) {
    super({
      name: 'ReadFile',
      description:
        'Read the contents of a file in the environment. ' +
        'Returns the file content with line numbers.',
    });
    this.environment = environment;
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
    const path = args['path'];
    if (typeof path !== 'string' || path === '') {
      return {status: 'error', error: '`path` is required.'};
    }
    const rawStartLine = args['start_line'];
    if (!isAbsentOrInteger(rawStartLine)) {
      return {
        status: 'error',
        error: '`start_line` must be an integer if provided.',
      };
    }
    const rawEndLine = args['end_line'];
    if (!isAbsentOrInteger(rawEndLine)) {
      return {
        status: 'error',
        error: '`end_line` must be an integer if provided.',
      };
    }

    try {
      const lines = splitLinesKeepingTerminators(
        DECODER.decode(await this.environment.readFile(path)),
      );
      const total = lines.length;
      // `||` not `??`: adk-python writes `start_line or 1`, so an explicit 0
      // means "unset" rather than line zero.
      const start = Math.max(1, rawStartLine || 1);
      const end = Math.min(total, rawEndLine || total);
      if (start > total) {
        const failure: ReadFileFailure = {
          status: 'error',
          error: `\`start_line\` ${start} exceeds file length (${total} lines).`,
          total_lines: total,
        };
        return failure;
      }
      if (start > end) {
        const failure: ReadFileFailure = {
          status: 'error',
          error: `\`start_line\` (${start}) is after \`end_line\` (${end}).`,
          total_lines: total,
        };
        return failure;
      }
      const numbered = lines
        .slice(start - 1, end)
        .map(
          (line, index) =>
            `${String(start + index).padStart(LINE_NUMBER_WIDTH)}\t${line}`,
        )
        .join('');
      const success: ReadFileSuccess = {
        status: 'ok',
        content: truncate(numbered, this.maxOutputChars),
      };
      if (start > 1 || end < total) {
        success.total_lines = total;
      }
      return success;
    } catch (e: unknown) {
      if (isFileNotFoundError(e)) {
        return {status: 'error', error: `File not found: ${path}`};
      }
      return {status: 'error', error: formatError(e)};
    }
  }
}
