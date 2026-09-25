/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';

import {guessMimeType} from '../utils/file_utils.js';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionResult, File} from './code_execution_utils.js';

const SUPPORTED_IMAGE_TYPES = ['png', 'jpg', 'jpeg'];
const SUPPORTED_DATA_FILE_TYPES = ['csv'];

const CODE_INTERPRETER_EXTENSION_NAME_ENV = 'CODE_INTERPRETER_EXTENSION_NAME';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

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
 * A file exchanged with the code interpreter extension. Field names match the
 * extension's wire format.
 */
export interface CodeInterpreterFile {
  name: string;
  contents: string;
}

/**
 * The response returned by the code interpreter extension's `execute`
 * operation. Field names match the extension's wire format.
 */
export interface CodeInterpreterResponse {
  execution_result?: string;
  execution_error?: string;
  output_files?: CodeInterpreterFile[];
}

/**
 * Parameters for a single code interpreter extension operation.
 */
export interface CodeInterpreterExecuteRequest {
  operationId: string;
  operationParams: Record<string, unknown>;
}

/**
 * A client able to execute operations on a Vertex AI code interpreter
 * extension.
 */
export interface CodeInterpreterExtension {
  execute(
    request: CodeInterpreterExecuteRequest,
  ): Promise<CodeInterpreterResponse>;
}

/**
 * Calls an existing Vertex AI extension through the `extensions:execute` REST
 * endpoint, authenticating with Application Default Credentials.
 */
export class VertexAiCodeInterpreterExtension implements CodeInterpreterExtension {
  private readonly auth = new GoogleAuth({scopes: CLOUD_PLATFORM_SCOPE});

  /**
   * @param resourceName The extension resource name, in the form
   *     `projects/123/locations/us-central1/extensions/456`.
   */
  constructor(readonly resourceName: string) {}

  async execute(
    request: CodeInterpreterExecuteRequest,
  ): Promise<CodeInterpreterResponse> {
    const location = getLocationFromResourceName(this.resourceName);
    const client = await this.auth.getClient();
    const response = await client.request<{content?: string}>({
      url: `https://${location}-aiplatform.googleapis.com/v1beta1/${this.resourceName}:execute`,
      method: 'POST',
      data: {
        operationId: request.operationId,
        operationParams: request.operationParams,
      },
    });
    const content = response.data.content;
    return content ? (JSON.parse(content) as CodeInterpreterResponse) : {};
  }
}

/**
 * Options for {@link VertexAiCodeExecutor}.
 */
export interface VertexAiCodeExecutorOptions {
  /**
   * The resource name of an existing code interpreter extension, in the form
   * `projects/123/locations/us-central1/extensions/456`. Defaults to the
   * `CODE_INTERPRETER_EXTENSION_NAME` environment variable.
   */
  resourceName?: string;

  /**
   * The extension client to execute code with. Defaults to a
   * {@link VertexAiCodeInterpreterExtension} for `resourceName`.
   */
  codeInterpreterExtension?: CodeInterpreterExtension;
}

/**
 * A code executor that uses the Vertex AI Code Interpreter Extension to execute
 * code.
 *
 * Each snippet runs with a preamble that imports `io`, `math`, `re`,
 * `matplotlib.pyplot`, `numpy`, `pandas` and `scipy`, and defines the `crop`
 * and `explore_df` helpers. Image and CSV files produced by the code are
 * returned as output files named `plot_<timestamp>_<n>.<ext>` and
 * `data_<timestamp>_<n>.<ext>`.
 */
export class VertexAiCodeExecutor extends BaseCodeExecutor {
  /**
   * The resource name of the code interpreter extension, when one was given
   * or read from the environment.
   */
  readonly resourceName?: string;

  private readonly codeInterpreterExtension: CodeInterpreterExtension;

  constructor(options: VertexAiCodeExecutorOptions = {}) {
    super();
    this.resourceName =
      options.resourceName || process.env[CODE_INTERPRETER_EXTENSION_NAME_ENV];
    this.codeInterpreterExtension =
      options.codeInterpreterExtension ??
      createCodeInterpreterExtension(this.resourceName);
  }

  override async executeCode({
    codeExecutionInput,
  }: ExecuteCodeParams): Promise<CodeExecutionResult> {
    const response = await this.codeInterpreterExtension.execute({
      operationId: 'execute',
      operationParams: buildOperationParams(
        getCodeWithImports(codeExecutionInput.code),
        codeExecutionInput.inputFiles,
        codeExecutionInput.executionId,
      ),
    });

    return {
      stdout: response.execution_result ?? '',
      stderr: response.execution_error ?? '',
      outputFiles: toOutputFiles(response.output_files ?? [], new Date()),
    };
  }
}

function createCodeInterpreterExtension(
  resourceName?: string,
): CodeInterpreterExtension {
  if (!resourceName) {
    throw new Error(
      'VertexAiCodeExecutor requires the resource name of an existing code ' +
        'interpreter extension. Pass `resourceName` or set the ' +
        `${CODE_INTERPRETER_EXTENSION_NAME_ENV} environment variable.`,
    );
  }
  return new VertexAiCodeInterpreterExtension(resourceName);
}

function getLocationFromResourceName(resourceName: string): string {
  const match = /(?:^|\/)locations\/([^/]+)/.exec(resourceName);
  if (!match) {
    throw new Error(
      'Invalid code interpreter extension resource name. Expected ' +
        '`projects/{project}/locations/{location}/extensions/{extension}`.',
    );
  }
  return match[1];
}

/**
 * Builds the code string with the built-in imports prepended.
 */
export function getCodeWithImports(code: string): string {
  return `
${IMPORTED_LIBRARIES}

${code}
`;
}

function buildOperationParams(
  code: string,
  inputFiles?: File[],
  sessionId?: string,
): Record<string, unknown> {
  const operationParams: Record<string, unknown> = {code};
  if (inputFiles?.length) {
    operationParams['files'] = inputFiles.map((f) => ({
      name: f.name,
      contents: f.content,
    }));
  }
  if (sessionId) {
    operationParams['session_id'] = sessionId;
  }
  return operationParams;
}

function toOutputFiles(outputFiles: CodeInterpreterFile[], now: Date): File[] {
  const fileNamePrefix = `${formatTimestamp(now)}_`;
  const savedFiles: File[] = [];
  let fileCount = 0;
  for (const outputFile of outputFiles) {
    const fileType = outputFile.name.split('.').pop() ?? '';
    const fileName = `${fileNamePrefix}${fileCount}.${fileType}`;
    if (SUPPORTED_IMAGE_TYPES.includes(fileType)) {
      fileCount++;
      savedFiles.push({
        name: `plot_${fileName}`,
        content: outputFile.contents,
        mimeType: `image/${fileType}`,
      });
    } else if (SUPPORTED_DATA_FILE_TYPES.includes(fileType)) {
      fileCount++;
      savedFiles.push({
        name: `data_${fileName}`,
        content: outputFile.contents,
        mimeType: `text/${fileType}`,
      });
    } else {
      savedFiles.push({
        name: fileName,
        content: outputFile.contents,
        mimeType: guessMimeType(fileName),
      });
    }
  }
  return savedFiles;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
