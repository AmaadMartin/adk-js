/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {escapeRegExp} from 'lodash-es';
import {BaseEnvironment} from '../../environment/base_environment.js';
import {isFileNotFoundError} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

/**
 * Builds the search pattern for `oldString`.
 *
 * Line breaks are normalised to `\n` and then matched as `\r?\n`, so a search
 * string with either line ending finds a file with either. `escapeRegExp`
 * leaves a literal newline character as-is, so the substitution runs on the
 * escaped pattern, as Python's
 * `re.escape(...).replace('\n', '\r?\n')` does.
 */
function buildSearchPattern(oldString: string): string {
  return escapeRegExp(oldString.replaceAll('\r\n', '\n')).replaceAll(
    '\n',
    '\\r?\\n',
  );
}

/** Perform a surgical text replacement in an existing file. */
@experimental
export class EditFileTool extends BaseTool {
  constructor(private readonly environment: BaseEnvironment) {
    super({
      name: 'EditFile',
      description:
        'Replace an exact substring in an existing file ' +
        'with new text. The old_string must appear exactly ' +
        'once in the file. To create new files, use the WriteFile tool.',
    });
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
            description: 'Path of the file to edit within the environment.',
          },
          old_string: {
            type: Type.STRING,
            description:
              'The exact text to find and replace. Must not be empty.',
          },
          new_string: {
            type: Type.STRING,
            description: 'The replacement text.',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const filePath = args['path'];
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return {status: 'error', error: '`path` is required.'};
    }
    const oldString = args['old_string'];
    if (typeof oldString !== 'string' || oldString.length === 0) {
      return {
        status: 'error',
        error:
          '`old_string` cannot be empty. To create a new ' +
          'file, use the WriteFile tool.',
      };
    }
    const newString =
      typeof args['new_string'] === 'string' ? args['new_string'] : '';

    let data: Uint8Array;
    try {
      data = await this.environment.readFile(filePath);
    } catch (e: unknown) {
      if (isFileNotFoundError(e)) {
        return {status: 'error', error: `File not found: ${filePath}`};
      }
      throw e;
    }
    const content = new TextDecoder('utf-8', {ignoreBOM: true}).decode(data);

    const matcher = new RegExp(buildSearchPattern(oldString), 'g');
    const count = (content.match(matcher) ?? []).length;
    if (count === 0) {
      return {
        status: 'error',
        error:
          '`old_string` not found in file. Read the file first ' +
          'to verify contents.',
      };
    }
    if (count > 1) {
      return {
        status: 'error',
        error:
          `\`old_string\` appears ${count} times. Provide more ` +
          'surrounding context to make it unique.',
      };
    }

    // A replacement function, not a string: a string replacement expands `$&`,
    // `` $` ``, `$'` and `$1` inside model-supplied `new_string`.
    const newContent = content.replace(matcher, () => newString);
    await this.environment.writeFile(filePath, newContent);
    return {status: 'ok', message: `Edited ${filePath}`};
  }
}
