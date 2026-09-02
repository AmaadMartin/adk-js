/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponse,
  Part,
  Tool,
  ToolUnion,
} from '@google/genai';

import {LlmRequest} from './llm_request.js';

const SEPARATOR = '-'.repeat(59);

const CONFIG_LOG_ERROR = '<error building config log>';

type ToolWithDeclarations = Tool & {
  functionDeclarations: FunctionDeclaration[];
};

/**
 * Drops `null` values so the dump matches adk-python's `exclude_none=True`.
 *
 * `JSON.stringify` already omits `undefined`.
 */
function dropNull(_key: string, value: unknown): unknown {
  return value === null ? undefined : value;
}

function hasFunctionDeclarations(
  tool: ToolUnion,
): tool is ToolWithDeclarations {
  return (
    'functionDeclarations' in tool &&
    Array.isArray(tool.functionDeclarations) &&
    tool.functionDeclarations.length > 0
  );
}

function withoutFunctionDeclarations(tool: ToolWithDeclarations): Tool {
  const copy: Tool = {...tool};
  delete copy.functionDeclarations;
  return copy;
}

/** Drops the raw bytes of an inline blob while keeping its other fields. */
function withoutInlineDataBytes(part: Part): Part {
  if (!part.inlineData) {
    return part;
  }
  const inlineData = {...part.inlineData};
  delete inlineData.data;
  return {...part, inlineData};
}

/**
 * Serializes the request config without the sections that are logged
 * separately, and without the transport options.
 *
 * `httpOptions` is excluded whole rather than field by field. `headers`
 * commonly holds an Authorization bearer token, and `baseUrl` carries the
 * credential itself when the caller points at a signed endpoint or an
 * authenticating proxy. Naming the sensitive fields instead would also start
 * logging every field the genai SDK adds later.
 */
function buildConfigLog(
  config: GenerateContentConfig,
  declarationTool: ToolWithDeclarations | undefined,
): string {
  const dump: GenerateContentConfig = {...config};
  delete dump.systemInstruction;
  delete dump.httpOptions;
  if (dump.tools) {
    if (declarationTool) {
      dump.tools = dump.tools.map((tool) =>
        tool === declarationTool
          ? withoutFunctionDeclarations(declarationTool)
          : tool,
      );
    } else {
      delete dump.tools;
    }
  }
  try {
    return JSON.stringify(dump, dropNull);
  } catch {
    // Never fall back to a raw dump: it would reintroduce the credential leak
    // the exclusions above exist to prevent.
    return CONFIG_LOG_ERROR;
  }
}

function buildContentLog(content: Content): string {
  const parts = content.parts?.map(withoutInlineDataBytes);
  return JSON.stringify({...content, parts}, dropNull);
}

/** Renders one function declaration as `name: params -> response`. */
export function buildFunctionDeclarationLog(
  declaration: FunctionDeclaration,
): string {
  let params = '{}';
  if (declaration.parameters?.properties) {
    params = JSON.stringify(declaration.parameters.properties, dropNull);
  } else if (declaration.parametersJsonSchema) {
    params = JSON.stringify(declaration.parametersJsonSchema, dropNull);
  }

  let response = '';
  if (declaration.response) {
    response = `-> ${JSON.stringify(declaration.response, dropNull)}`;
  } else if (declaration.responseJsonSchema) {
    response = `-> ${JSON.stringify(declaration.responseJsonSchema, dropNull)}`;
  }

  const declared = `${declaration.name}: ${params}`;
  return response ? `${declared} ${response}` : declared;
}

/** Renders a request for the debug log, omitting credentials and raw bytes. */
export function buildRequestLog(request: LlmRequest): string {
  const config = request.config ?? {};
  const declarationTool = config.tools?.find(hasFunctionDeclarations);
  const functionLogs = (declarationTool?.functionDeclarations ?? []).map(
    buildFunctionDeclarationLog,
  );
  const contentLogs = request.contents.map(buildContentLog);

  return `
LLM Request:
${SEPARATOR}
System Instruction:
${config.systemInstruction ?? ''}
${SEPARATOR}
Config:
${buildConfigLog(config, declarationTool)}
${SEPARATOR}
Contents:
${contentLogs.join('\n')}
${SEPARATOR}
Functions:
${functionLogs.join('\n')}
${SEPARATOR}
`;
}

/** Renders a model response for the debug log. */
export function buildResponseLog(response: GenerateContentResponse): string {
  const functionCallLogs = (response.functionCalls ?? []).map(
    (call) =>
      `name: ${call.name}, args: ${JSON.stringify(call.args, dropNull)}`,
  );

  // Only the first candidate contributes text, and reasoning parts are left
  // out, so the logged text matches what the caller sees.
  const text = (response.candidates?.[0]?.content?.parts ?? [])
    .flatMap((part) =>
      typeof part.text === 'string' && !part.thought ? [part.text] : [],
    )
    .join('');

  return `
LLM Response:
${SEPARATOR}
Text:
${text}
${SEPARATOR}
Function calls:
${functionCallLogs.join('\n')}
${SEPARATOR}
Raw response:
${JSON.stringify(response, dropNull)}
${SEPARATOR}
`;
}
