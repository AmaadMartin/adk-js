/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../utils/experimental.js';
import {guessMimeType} from '../utils/file_utils.js';
import {logger} from '../utils/logger.js';

import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionResult, File} from './code_execution_utils.js';

const SUPPORTED_IMAGE_TYPES = ['png', 'jpg', 'jpeg'];
const SUPPORTED_DATA_FILE_TYPES = ['csv'];

/**
 * Python source prepended to the user code before it is sent to the code
 * interpreter. Ported verbatim from the reference Python `_IMPORTED_LIBRARIES`
 * value; the extension runs Python, so this is Python (not TypeScript) source.
 */
const IMPORTED_LIBRARIES = `
import io
import math
import re

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import scipy

def crop(s: str, max_chars: int = 64) -> str:
  """Crops a string to max_chars characters."""
  return s[: max_chars - 3] + '...' if len(s) > max_chars else s


def explore_df(df: pd.DataFrame) -> None:
  """Prints some information about a pandas DataFrame."""

  with pd.option_context(
      'display.max_columns', None, 'display.expand_frame_repr', False
  ):
    # Print the column names to never encounter KeyError when selecting one.
    df_dtypes = df.dtypes

    # Obtain information about data types and missing values.
    df_nulls = (len(df) - df.isnull().sum()).apply(
        lambda x: f'{x} / {df.shape[0]} non-null'
    )

    # Explore unique total values in columns using \`.unique()\`.
    df_unique_count = df.apply(lambda x: len(x.unique()))

    # Explore unique values in columns using \`.unique()\`.
    df_unique = df.apply(lambda x: crop(str(list(x.unique()))))

    df_info = pd.concat(
        (
            df_dtypes.rename('Dtype'),
            df_nulls.rename('Non-Null Count'),
            df_unique_count.rename('Unique Values Count'),
            df_unique.rename('Unique Values'),
        ),
        axis=1,
    )
    df_info.index.name = 'Columns'
    print(f"""Total rows: {df.shape[0]}
Total columns: {df.shape[1]}

{df_info}""")
`;

/**
 * Options for VertexAiCodeExecutor.
 */
export interface VertexAiCodeExecutorOptions {
  /**
   * If set, load the existing resource name of the code interpreter extension
   * instead of creating a new one.
   * Format: projects/123/locations/us-central1/extensions/456
   */
  resourceName?: string;

  /**
   * Optional pre-constructed Code Interpreter extension handle. Primarily for
   * testing (mocked-client pattern). When omitted, `executeCode` throws, since
   * no SDK-backed loader exists yet in the installed dependencies.
   */
  codeInterpreterExtension?: CodeInterpreterExtension;
}

/**
 * The minimal structural contract of a Vertex AI Code Interpreter Extension
 * handle that this executor depends on. Mirrors the reference Python
 * `vertexai.preview.extensions.Extension.execute(...)` surface. Depending on
 * this interface rather than a concrete SDK class is what makes the executor
 * testable with a mocked handle and keeps CI free of a real backend.
 */
export interface CodeInterpreterExtension {
  execute(request: {
    operationId: string;
    operationParams: Record<string, unknown>;
  }): Promise<CodeInterpreterExecuteResponse>;
}

/**
 * Response shape returned by the code interpreter `execute` operation. Field
 * names mirror the reference Python response dict keys exactly so the port is
 * faithful and the mocked tests define the same contract.
 */
export interface CodeInterpreterExecuteResponse {
  execution_result?: string;
  execution_error?: string;
  output_files?: Array<{name: string; contents: string}>;
}

/**
 * Builds the code string sent to the interpreter by prepending the imports
 * preamble. Mirrors the reference Python `_get_code_with_imports` f-string.
 */
function buildCodeWithImports(code: string): string {
  return `\n${IMPORTED_LIBRARIES}\n\n${code}\n`;
}

/**
 * Invokes the code interpreter extension's `execute` operation, assembling the
 * operation params exactly as the reference Python `_execute_code_interpreter`.
 */
function executeCodeInterpreter(
  extension: CodeInterpreterExtension,
  code: string,
  inputFiles?: File[],
  sessionId?: string,
): Promise<CodeInterpreterExecuteResponse> {
  const operationParams: Record<string, unknown> = {code};
  if (inputFiles && inputFiles.length) {
    operationParams.files = inputFiles.map((file) => ({
      name: file.name,
      contents: file.content,
    }));
  }
  if (sessionId) {
    operationParams.session_id = sessionId;
  }
  return extension.execute({operationId: 'execute', operationParams});
}

/**
 * Maps a code interpreter output file to a `File`, assigning its MIME type.
 *
 * Parity note: images build `image/${fileType}` verbatim (so `.jpg` yields
 * `image/jpg`, not `image/jpeg`) to mirror the reference exactly. The reference
 * `else` branch uses `mimetypes.guess_type`, which returns `None` for unknown
 * extensions; because `File.mimeType` is a required string here, the port uses
 * `guessMimeType`, which returns `application/octet-stream` instead. This is an
 * intentional, type-driven deviation.
 */
function toOutputFile(outputFile: {name: string; contents: string}): File {
  // `split('.')` always yields a non-empty array, so `pop()` is always defined.
  const fileType = outputFile.name.split('.').pop()!;
  let mimeType: string;
  if (SUPPORTED_IMAGE_TYPES.includes(fileType)) {
    mimeType = `image/${fileType}`;
  } else if (SUPPORTED_DATA_FILE_TYPES.includes(fileType)) {
    mimeType = `text/${fileType}`;
  } else {
    mimeType = guessMimeType(outputFile.name);
  }
  return {name: outputFile.name, content: outputFile.contents, mimeType};
}

/**
 * A code executor that uses the Vertex AI Code Interpreter Extension to execute
 * model-generated Python code.
 */
@experimental
export class VertexAiCodeExecutor extends BaseCodeExecutor {
  /**
   * If set, the resource name of an existing code interpreter extension.
   * Format: projects/123/locations/us-central1/extensions/456
   */
  resourceName?: string;

  private extension?: CodeInterpreterExtension;

  constructor(options: VertexAiCodeExecutorOptions = {}) {
    super();
    this.resourceName = options.resourceName;
    this.extension = options.codeInterpreterExtension;
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const {codeExecutionInput} = params;
    // The reference Python loads/creates the extension via
    // `vertexai.preview.extensions.Extension`, but that surface has no
    // equivalent in the `@google/genai` / `@google-cloud/vertexai` SDKs this
    // package depends on, so a handle cannot be created automatically. Callers
    // must inject one via the `codeInterpreterExtension` option. This is the
    // seam where a future SDK-backed loader would go.
    if (!this.extension) {
      throw new Error(
        'VertexAiCodeExecutor could not load a Code Interpreter Extension' +
          (this.resourceName ? ` (resourceName: ${this.resourceName})` : '') +
          '. The Vertex AI Code Interpreter Extension API is not available in ' +
          'the installed SDK; provide a handle via the ' +
          '`codeInterpreterExtension` option.',
      );
    }

    const response = await executeCodeInterpreter(
      this.extension,
      buildCodeWithImports(codeExecutionInput.code),
      codeExecutionInput.inputFiles,
      codeExecutionInput.executionId,
    );
    logger.debug('Executed code:\n```\n' + codeExecutionInput.code + '\n```');

    const result: CodeExecutionResult = {
      stdout: response.execution_result ?? '',
      stderr: response.execution_error ?? '',
      outputFiles: (response.output_files ?? []).map(toOutputFile),
    };
    logger.debug('Code execution result: ' + JSON.stringify(result));
    return result;
  }
}
