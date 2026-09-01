/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../utils/experimental.js';
import {guessMimeType} from '../utils/file_utils.js';
import {logger} from '../utils/logger.js';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {
  CodeExecutionLanguage,
  CodeExecutionResult,
  File,
} from './code_execution_utils.js';
import {
  CodeInterpreterExecuteParams,
  CodeInterpreterExtensionClient,
  CodeInterpreterFile,
  parseExtensionLocation,
  VertexAiCodeInterpreterExtensionClient,
} from './code_interpreter_extension_client.js';

const EXTENSION_NAME_ENV_VAR = 'CODE_INTERPRETER_EXTENSION_NAME';
const DEFAULT_LOCATION = 'us-central1';

/**
 * Prepended to every execution so the generated code can rely on a fixed set
 * of libraries and on `explore_df`. Kept byte-for-byte identical to
 * adk-python's `_IMPORTED_LIBRARIES`.
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

/** Options for {@link VertexAiCodeExecutor}. */
export interface VertexAiCodeExecutorOptions {
  /**
   * An existing code interpreter extension to run on, instead of creating one.
   * Format: projects/123/locations/us-central1/extensions/456
   */
  resourceName?: string;

  /**
   * Project to create the extension in. Defaults to GOOGLE_CLOUD_PROJECT.
   * Required unless a resource name resolves.
   */
  projectId?: string;

  /**
   * Region to create the extension in. Defaults to GOOGLE_CLOUD_LOCATION, then
   * to `us-central1`. Ignored when a resource name resolves, because the name
   * carries its own region.
   */
  location?: string;

  /** Whether the executor is stateful. Defaults to the base class value. */
  stateful?: boolean;

  /**
   * Whether to attach data files from the model request. Defaults to the base
   * class value.
   */
  optimizeDataFile?: boolean;

  /** Transport to use. A REST-backed client is created when omitted. */
  client?: CodeInterpreterExtensionClient;
}

/**
 * Builds the code string that is sent to the extension.
 *
 * @param code The model-generated code.
 * @return The code, prefixed with the import preamble.
 */
function getCodeWithImports(code: string): string {
  return `\n${IMPORTED_LIBRARIES}\n\n${code}\n`;
}

/**
 * Maps a file returned by the extension to an ADK file.
 *
 * adk-python builds `f'image/{file_type}'`, so a `.jpg` becomes `image/jpg`
 * rather than the registered `image/jpeg`. The MIME type reaches the model, so
 * both SDKs must report the same one. Every other extension the reference
 * special-cases already agrees with `guessMimeType`.
 *
 * @param outputFile The file as returned by the extension.
 * @return The ADK file, with its content still base64-encoded.
 */
function toOutputFile(outputFile: CodeInterpreterFile): File {
  const isJpg = outputFile.name.split('.').pop() === 'jpg';
  return {
    name: outputFile.name,
    content: outputFile.contents,
    mimeType: isJpg ? 'image/jpg' : guessMimeType(outputFile.name),
  };
}

function toInterpreterFile(file: File): CodeInterpreterFile {
  return {name: file.name, contents: file.content};
}

/**
 * Runs model-generated Python on a managed Vertex AI Code Interpreter
 * extension, and returns its stdout, stderr and generated files.
 *
 * The executor resolves the extension from `resourceName`, then from the
 * `CODE_INTERPRETER_EXTENSION_NAME` environment variable, and otherwise
 * creates one from the public hub on the first execution. It writes the name
 * of an extension it created back into `CODE_INTERPRETER_EXTENSION_NAME`.
 *
 * Note: Vertex AI Extensions is a Preview offering and is deprecated. See
 * https://cloud.google.com/vertex-ai/generative-ai/docs/extensions/code-interpreter
 *
 * @example
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'ds',
 *   model: 'gemini-2.5-flash',
 *   codeExecutor: new VertexAiCodeExecutor({stateful: true}),
 * });
 * ```
 */
@experimental
export class VertexAiCodeExecutor extends BaseCodeExecutor {
  /** The extension in use, once it is known. */
  resourceName?: string;

  private readonly projectId?: string;
  private readonly location: string;
  private readonly client: CodeInterpreterExtensionClient;
  private extensionImportPromise?: Promise<string>;

  constructor(options: VertexAiCodeExecutorOptions = {}) {
    super();
    this.resourceName =
      options.resourceName ?? process.env[EXTENSION_NAME_ENV_VAR];

    if (this.resourceName && !parseExtensionLocation(this.resourceName)) {
      throw new Error(
        `Invalid code interpreter extension resource name: ${this.resourceName}`,
      );
    }

    this.location =
      options.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? DEFAULT_LOCATION;
    this.projectId = options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT;
    if (!this.resourceName && !this.projectId) {
      throw new Error('Project ID is required.');
    }

    if (options.stateful !== undefined) {
      this.stateful = options.stateful;
    }
    if (options.optimizeDataFile !== undefined) {
      this.optimizeDataFile = options.optimizeDataFile;
    }

    this.client =
      options.client ?? new VertexAiCodeInterpreterExtensionClient();
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const {codeExecutionInput} = params;

    if (codeExecutionInput.language !== CodeExecutionLanguage.PYTHON) {
      return {
        stdout: '',
        stderr:
          `The Vertex AI code interpreter extension runs ` +
          `${CodeExecutionLanguage.PYTHON} only, but the code was ` +
          `${codeExecutionInput.language}.`,
        outputFiles: [],
      };
    }

    const executeParams: CodeInterpreterExecuteParams = {
      code: getCodeWithImports(codeExecutionInput.code),
    };
    if (codeExecutionInput.inputFiles.length > 0) {
      executeParams.files =
        codeExecutionInput.inputFiles.map(toInterpreterFile);
    }
    if (codeExecutionInput.executionId) {
      executeParams.sessionId = codeExecutionInput.executionId;
    }

    const resourceName = await this.resolveResourceName();
    const response = await this.client.execute(resourceName, executeParams);

    return {
      stdout: response.execution_result ?? '',
      stderr: response.execution_error ?? '',
      outputFiles: (response.output_files ?? []).map(toOutputFile),
    };
  }

  /**
   * Resolves the extension to run on, creating one at most once per executor.
   */
  private resolveResourceName(): Promise<string> {
    if (this.resourceName) {
      return Promise.resolve(this.resourceName);
    }
    this.extensionImportPromise ??= this.importExtension();
    return this.extensionImportPromise;
  }

  private async importExtension(): Promise<string> {
    if (!this.projectId) {
      throw new Error('Project ID is required.');
    }
    logger.debug(
      `No ${EXTENSION_NAME_ENV_VAR} found in the environment. Creating a new code interpreter extension.`,
    );
    const resourceName = await this.client.importFromHub(
      this.projectId,
      this.location,
    );
    this.resourceName = resourceName;
    process.env[EXTENSION_NAME_ENV_VAR] = resourceName;
    return resourceName;
  }
}
