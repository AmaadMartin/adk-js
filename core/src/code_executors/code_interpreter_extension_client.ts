/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Public hub manifest that defines the code interpreter extension. */
const MANIFEST_GCS_URI = 'gs://vertex-extension-public/code_interpreter.yaml';
const MANIFEST_NAME = 'code_interpreter_tool';
const EXTENSION_DISPLAY_NAME = 'Code Interpreter';
const EXTENSION_DESCRIPTION =
  'This extension generates and executes code in the specified language';

const EXECUTE_OPERATION_ID = 'execute';

/** The `extensions:import` body that provisions the code interpreter. */
const IMPORT_REQUEST_BODY = {
  displayName: EXTENSION_DISPLAY_NAME,
  description: EXTENSION_DESCRIPTION,
  manifest: {
    name: MANIFEST_NAME,
    description: EXTENSION_DESCRIPTION,
    apiSpec: {openApiGcsUri: MANIFEST_GCS_URI},
    authConfig: {
      authType: 'GOOGLE_SERVICE_ACCOUNT_AUTH',
      googleServiceAccountConfig: {},
    },
  },
};

/** How many times the import operation is polled before giving up. */
const IMPORT_MAX_POLL_ATTEMPTS = 180;
/** How long to wait between two polls of the import operation. */
const IMPORT_POLL_INTERVAL_MS = 1000;

const EXTENSION_RESOURCE_NAME_PATTERN =
  /^projects\/[^/]+\/locations\/([^/]+)\/extensions\/[^/]+$/;

/**
 * A file exchanged with the extension. `contents` is base64-encoded in both
 * directions.
 */
export interface CodeInterpreterFile {
  /** File name, including its extension. */
  name: string;
  /** Base64-encoded file bytes. */
  contents: string;
}

/** The arguments of one `execute` call. */
export interface CodeInterpreterExecuteParams {
  /** The Python source to run. */
  code: string;
  /** Files to make available to the code. */
  files?: CodeInterpreterFile[];
  /** Session to run in, so state survives between calls. */
  sessionId?: string;
}

/**
 * The result of one `execute` call. The field names are the extension's own
 * wire names, so they stay snake_case.
 */
export interface CodeInterpreterExecuteResponse {
  execution_result?: string;
  execution_error?: string;
  output_files?: CodeInterpreterFile[];
}

/** Transport for the Vertex AI Code Interpreter extension. */
export interface CodeInterpreterExtensionClient {
  /**
   * Imports the code interpreter extension from the public hub.
   *
   * @param projectId The project to create the extension in.
   * @param location The region to create the extension in.
   * @return The resource name of the created extension.
   */
  importFromHub(projectId: string, location: string): Promise<string>;

  /**
   * Runs code on an extension.
   *
   * @param resourceName The extension to run the code on.
   * @param params The code, input files and session.
   * @return The extension's execution result.
   */
  execute(
    resourceName: string,
    params: CodeInterpreterExecuteParams,
  ): Promise<CodeInterpreterExecuteResponse>;
}

/** A long-running operation returned by `extensions:import`. */
interface ImportOperation {
  name?: string;
  done?: boolean;
  error?: {message?: string};
  response?: {name?: string};
}

/** The `:execute` response envelope, whose `content` holds JSON text. */
interface ExecuteEnvelope {
  content: string;
}

/**
 * Extracts the location from an extension resource name.
 *
 * @param resourceName A name shaped like
 *     `projects/123/locations/us-central1/extensions/456`.
 * @return The location, or undefined when the name is malformed.
 */
export function parseExtensionLocation(
  resourceName: string,
): string | undefined {
  return EXTENSION_RESOURCE_NAME_PATTERN.exec(resourceName)?.[1];
}

function apiBaseUrl(location: string): string {
  return `https://${location}-aiplatform.googleapis.com/v1beta1`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the extension name out of a finished import operation.
 *
 * A finished operation carries either `response` or `error`, never both.
 */
function readImportedExtensionName(operation: ImportOperation): string {
  if (operation.error) {
    throw new Error(
      `Extension import operation ${operation.name} failed: ${operation.error.message}`,
    );
  }
  if (!operation.response?.name) {
    throw new Error(
      `Extension import operation ${operation.name} returned no extension.`,
    );
  }
  return operation.response.name;
}

/**
 * Calls the Vertex AI Code Interpreter extension over its REST surface, using
 * Application Default Credentials.
 */
export class VertexAiCodeInterpreterExtensionClient implements CodeInterpreterExtensionClient {
  private readonly auth = new GoogleAuth({scopes: [CLOUD_PLATFORM_SCOPE]});

  async importFromHub(projectId: string, location: string): Promise<string> {
    const baseUrl = apiBaseUrl(location);
    let operation = await this.request<ImportOperation>(
      'POST',
      `${baseUrl}/projects/${projectId}/locations/${location}/extensions:import`,
      IMPORT_REQUEST_BODY,
    );
    const operationUrl = `${baseUrl}/${operation.name}`;

    for (
      let attempt = 0;
      !operation.done && attempt < IMPORT_MAX_POLL_ATTEMPTS;
      attempt++
    ) {
      await delay(IMPORT_POLL_INTERVAL_MS);
      operation = await this.request<ImportOperation>('GET', operationUrl);
    }

    if (!operation.done) {
      throw new Error(
        `Extension import operation ${operation.name} did not complete in time.`,
      );
    }
    return readImportedExtensionName(operation);
  }

  async execute(
    resourceName: string,
    params: CodeInterpreterExecuteParams,
  ): Promise<CodeInterpreterExecuteResponse> {
    const location = parseExtensionLocation(resourceName);
    if (!location) {
      throw new Error(
        `Invalid code interpreter extension resource name: ${resourceName}`,
      );
    }
    const envelope = await this.request<ExecuteEnvelope>(
      'POST',
      `${apiBaseUrl(location)}/${resourceName}:execute`,
      {
        operationId: EXECUTE_OPERATION_ID,
        operationParams: {
          code: params.code,
          files: params.files,
          session_id: params.sessionId,
        },
      },
    );
    return JSON.parse(envelope.content) as CodeInterpreterExecuteResponse;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
  ): Promise<T> {
    const client = await this.auth.getClient();
    const headers = await client.getRequestHeaders(url);
    headers.set('Content-Type', 'application/json');

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API request failed with status ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }
}
