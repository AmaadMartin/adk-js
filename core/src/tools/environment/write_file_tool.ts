/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {BaseEnvironment} from '../../environment/base_environment.js';
import {formatError} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

const TOOL_ERROR = 'TOOL_ERROR';

/** Create or overwrite a file in the environment. */
@experimental
export class WriteFileTool extends BaseTool {
  constructor(private readonly environment: BaseEnvironment) {
    super({
      name: 'WriteFile',
      description:
        'Create or overwrite a file in the environment. ' +
        'Use for new files or full rewrites. For small ' +
        'changes to existing files, prefer EditFile.',
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
            description: 'Path to the file within the environment.',
          },
          content: {
            type: Type.STRING,
            description: 'The full file content to write.',
          },
        },
        required: ['path', 'content'],
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const filePath = args['path'];
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return {status: 'error', error: '`path` is required.'};
    }
    // Python defaults `content` to `''`, so writing an empty file is legal.
    const content = typeof args['content'] === 'string' ? args['content'] : '';
    try {
      await this.environment.writeFile(filePath, content);
    } catch (e: unknown) {
      return {status: 'error', error: formatError(e)};
    }
    return {status: 'ok', message: `Wrote ${filePath}`};
  }

  /**
   * The error type to record on this call's telemetry span, or `undefined`
   * when the response is not a failure.
   *
   * The tool reports a failure by returning `{status: 'error'}` rather than by
   * throwing, which is otherwise indistinguishable from a success in a trace.
   * An `error` key on its own is not a failure: the environment tools carry the
   * outcome in `status`.
   */
  detectErrorInResponse(response: unknown): string | undefined {
    if (
      typeof response === 'object' &&
      response !== null &&
      'status' in response &&
      response.status === 'error'
    ) {
      return TOOL_ERROR;
    }
    return undefined;
  }
}
