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

/**
 * What {@link WriteFileTool} returns to the model.
 *
 * The tool never throws: it reports a rejected write, a missing path and a
 * non-string content as `status: 'error'`, so the model reads the reason and
 * can correct its next call.
 */
export type WriteFileResponse =
  | {status: 'ok'; message: string}
  | {status: 'error'; error: string};

/**
 * Creates or overwrites a file in a {@link BaseEnvironment}.
 *
 * All input and output goes through the injected environment, so the tool
 * inherits whatever containment that environment provides. `LocalEnvironment`,
 * for example, creates missing parent directories and rejects a path that
 * lexically escapes its working directory.
 *
 * The caller owns the environment's lifecycle. Call `initialize()` on it before
 * the first tool call; an uninitialised environment rejects the write and the
 * tool reports that rejection as `status: 'error'`.
 *
 * @example
 * ```ts
 * const environment = new LocalEnvironment({workingDir: '/tmp/workspace'});
 * await environment.initialize();
 * const agent = new LlmAgent({
 *   name: 'writer',
 *   model: 'gemini-2.0-flash',
 *   tools: [new WriteFileTool(environment)],
 * });
 * ```
 */
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

  override async runAsync({
    args,
  }: RunAsyncToolRequest): Promise<WriteFileResponse> {
    const filePath = typeof args['path'] === 'string' ? args['path'] : '';
    if (!filePath) {
      return {status: 'error', error: '`path` is required.'};
    }
    // Python defaults `content` to `''`, so writing an empty file is legal.
    const rawContent = args['content'];
    const content = rawContent === undefined ? '' : rawContent;
    if (typeof content !== 'string') {
      return {status: 'error', error: '`content` must be a string.'};
    }
    try {
      await this.environment.writeFile(filePath, content);
    } catch (e: unknown) {
      return {status: 'error', error: formatError(e)};
    }
    return {status: 'ok', message: `Wrote ${filePath}`};
  }
}
