/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Part, Type} from '@google/genai';

import {Context} from '../agents/context.js';
import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {appendDynamicInstructions, LlmRequest} from '../models/llm_request.js';
import {maybeBase64ToBytes} from '../utils/base64_utils.js';
import {extractDocxText} from '../utils/document_text_utils.js';
import {formatError} from '../utils/error_utils.js';
import {getLogger} from '../utils/logger.js';
import {
  isGeminiInlineMimeTypeSupported,
  isSpreadsheetMimeType,
  isTextLikeMimeType,
  normalizeMimeType,
} from '../utils/mime_utils.js';
import {spreadsheetToMarkdown} from '../utils/spreadsheet_utils.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

const logger = getLogger();

/** MIME type of a DOCX document. */
const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** MIME type an upload carries when its real type is unknown. */
const OCTET_STREAM_MIME_TYPE = 'application/octet-stream';

/**
 * Narrows a model-supplied `artifact_names` value to a list of strings.
 *
 * Returns `undefined` when the value is anything other than an array of
 * strings, so callers can reject it. An absent value is an empty list.
 */
function parseArtifactNames(value: unknown): string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const names = value.filter(
    (name): name is string => typeof name === 'string',
  );
  return names.length === value.length ? names : undefined;
}

/** Filename suffixes whose content is text whatever the MIME type says. */
const TEXT_FILE_SUFFIXES = ['.csv', '.txt', '.json', '.xml'];

/** Filename suffixes of a spreadsheet workbook. */
const SPREADSHEET_FILE_SUFFIXES = ['.xlsx', '.xls'];

/** Model-facing description of the tool's only parameter. */
const ARTIFACT_NAMES_DESCRIPTION = 'The names of the artifacts to load.';

/**
 * Converts an artifact into a `Part` that is safe to send to Gemini.
 *
 * An artifact Gemini accepts inline is returned unchanged. Anything else is
 * converted to text: a DOCX document to its extracted text, a text-like
 * payload to its decoded text, and any remaining binary payload to a short
 * placeholder naming the artifact and its size. The conversion never throws;
 * every failure degrades to a text part.
 *
 * A `processArtifact` callback can call this to fall back to the default
 * conversion for an artifact it does not want to handle itself.
 *
 * @param artifact The artifact to convert.
 * @param artifactName The name the artifact was loaded under.
 * @param enableSpreadsheetParsing Whether to render a spreadsheet workbook as
 *     a markdown table instead of a placeholder.
 * @return A part that is safe to send to Gemini.
 */
export function asSafePartForLlm(
  artifact: Part,
  artifactName: string,
  enableSpreadsheetParsing = false,
): Part {
  const inlineData = artifact.inlineData;
  if (!inlineData) {
    return artifact;
  }

  if (isGeminiInlineMimeTypeSupported(inlineData.mimeType)) {
    return artifact;
  }

  const mimeType =
    normalizeMimeType(inlineData.mimeType) || OCTET_STREAM_MIME_TYPE;
  const data = inlineData.data;
  if (!data) {
    return {
      text: `[Artifact: ${artifactName}, type: ${mimeType}. No inline data was provided.]`,
    };
  }

  const bytes = maybeBase64ToBytes(data);
  if (!bytes) {
    return {text: data};
  }

  const loweredName = artifactName.toLowerCase();
  const isDocx =
    mimeType === DOCX_MIME_TYPE ||
    mimeType === OCTET_STREAM_MIME_TYPE ||
    loweredName.endsWith('.docx');
  if (isDocx) {
    const docxText = extractDocxText(bytes);
    if (docxText !== undefined) {
      return {text: docxText};
    }
  }

  if (
    isTextLikeMimeType(mimeType) ||
    TEXT_FILE_SUFFIXES.some((suffix) => loweredName.endsWith(suffix))
  ) {
    return {text: bytes.toString('utf8')};
  }

  if (
    enableSpreadsheetParsing &&
    (isSpreadsheetMimeType(mimeType) ||
      SPREADSHEET_FILE_SUFFIXES.some((suffix) => loweredName.endsWith(suffix)))
  ) {
    return {text: spreadsheetToMarkdown(bytes)};
  }

  const sizeKb = bytes.length / 1024;
  return {
    text: `[Binary artifact: ${artifactName}, type: ${mimeType}, size: ${sizeKb.toFixed(1)} KB. Content cannot be displayed inline.]`,
  };
}

/**
 * Customizes or filters an artifact before it is added to the LLM request.
 *
 * @param artifact The artifact as it was loaded, unconverted.
 * @param artifactName The name the artifact was loaded under, without the
 *     `user:` prefix even when the artifact was found under that prefix.
 * @return The part to add, or `undefined` to leave the artifact out.
 */
export type ProcessArtifactCallback = (
  artifact: Part,
  artifactName: string,
) => Part | undefined | Promise<Part | undefined>;

/** Parameters for {@link LoadArtifactsTool}. */
export interface LoadArtifactsToolParams {
  /**
   * Called for each artifact in place of the built-in safety conversion, so
   * supplying it bypasses {@link asSafePartForLlm} entirely. Returning
   * `undefined` leaves that artifact out of the request. If it throws, the
   * tool logs the error and leaves the artifact out.
   */
  processArtifact?: ProcessArtifactCallback;
  /**
   * Renders an XLSX artifact as a markdown table instead of a placeholder.
   * Defaults to `false`.
   *
   * Two limitations are worth knowing before you turn this on. The legacy
   * binary `.xls` format is not a zip, so it reports an invalid format. Cells
   * are rendered from their stored values, so a date held as a serial number
   * renders as that number.
   */
  enableSpreadsheetParsing?: boolean;
}

/**
 * A tool that loads the artifacts and adds them to the session.
 */
export class LoadArtifactsTool extends BaseTool {
  private readonly processArtifact?: ProcessArtifactCallback;
  private readonly enableSpreadsheetParsing: boolean;

  constructor(params: LoadArtifactsToolParams = {}) {
    super({
      name: 'load_artifacts',
      description: `Loads artifacts into the session for this request.\n\nNOTE: Call when you need access to artifacts (for example, uploads saved by the web UI).`,
    });
    this.processArtifact = params.processArtifact;
    this.enableSpreadsheetParsing = params.enableSpreadsheetParsing ?? false;
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    if (isFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL)) {
      return {
        name: this.name,
        description: this.description,
        parametersJsonSchema: {
          type: 'object',
          properties: {
            artifact_names: {
              type: 'array',
              items: {type: 'string'},
              description: ARTIFACT_NAMES_DESCRIPTION,
            },
          },
        },
      };
    }
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          artifact_names: {
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
            },
            description: ARTIFACT_NAMES_DESCRIPTION,
          },
        },
      },
    };
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const artifactNames = parseArtifactNames(args['artifact_names']);
    if (!artifactNames) {
      return {
        error: "'artifact_names' must be a list of strings.",
        error_code: 'INVALID_ARGUMENTS',
      };
    }
    return {
      artifact_names: artifactNames,
      status:
        'artifact contents temporarily inserted and removed. to access these artifacts, call load_artifacts tool again.',
    };
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(request);
    await this.appendArtifactsToLlmRequest(
      request.toolContext,
      request.llmRequest,
    );
  }

  /**
   * Appends every artifact the current turn asked for to the request.
   *
   * This scans all `load_artifacts` function responses in the current turn.
   * adk-python reads only the first part of the last content, so it misses a
   * response that shares a turn with another tool. Keep the scan: it is what
   * fixes google/adk-js#632 for parallel and sequential tool calls. Each
   * artifact name loads once, however often the turn names it.
   */
  private async appendArtifactsToLlmRequest(
    toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    if (!toolContext.invocationContext.artifactService) {
      return;
    }

    const artifactNames = await toolContext.listArtifacts();
    if (!artifactNames || artifactNames.length === 0) {
      return;
    }

    appendDynamicInstructions(llmRequest, [
      `You have a list of artifacts:\n  ${JSON.stringify(
        artifactNames,
      )}\n\n  When the user asks questions about any of the artifacts, you should call the\n  \`load_artifacts\` function to load the artifact. Always call load_artifacts\n  before answering questions related to the artifacts, regardless of whether the\n  artifacts have been loaded before. Do not depend on prior answers about the\n  artifacts.`,
    ]);

    const contents = llmRequest.contents;
    if (!contents || contents.length === 0) {
      return;
    }

    // Find the start index of the current turn.
    // A turn begins after the last completed model response (model message with text)
    // or at the latest user message that is not a tool response (user prompt).
    let startIndex = 0;
    for (let i = contents.length - 1; i >= 0; i--) {
      const content = contents[i];
      const hasFunctionResponse = content.parts?.some(
        (part) => part.functionResponse !== undefined,
      );
      const hasFunctionCall = content.parts?.some(
        (part) => part.functionCall !== undefined,
      );

      if (
        (content.role === 'model' && !hasFunctionCall) ||
        (content.role === 'user' && !hasFunctionResponse)
      ) {
        startIndex = i;
        break;
      }
    }

    const namesToLoad: string[] = [];
    for (let i = startIndex; i < contents.length; i++) {
      const content = contents[i];
      if (content.role === 'user' && content.parts) {
        for (const part of content.parts) {
          const functionResponse = part.functionResponse;
          if (functionResponse && functionResponse.name === this.name) {
            const response =
              (functionResponse.response as Record<string, unknown>) || {};
            const responseArtifactNames = parseArtifactNames(
              response['artifact_names'],
            );
            if (!responseArtifactNames) {
              logger.warn(
                'Ignoring invalid artifact_names in load_artifacts response.',
              );
              continue;
            }
            for (const name of responseArtifactNames) {
              if (name && !namesToLoad.includes(name)) {
                namesToLoad.push(name);
              }
            }
          }
        }
      }
    }

    for (const artifactName of namesToLoad) {
      let artifact = await toolContext.loadArtifact(artifactName);

      if (!artifact && !artifactName.startsWith('user:')) {
        const prefixedName = `user:${artifactName}`;
        artifact = await toolContext.loadArtifact(prefixedName);
      }

      if (!artifact) {
        logger.warn(`Artifact "${artifactName}" not found, skipping`);
        continue;
      }

      let artifactPart: Part | undefined;
      if (this.processArtifact) {
        try {
          artifactPart = await this.processArtifact(artifact, artifactName);
        } catch (err: unknown) {
          logger.error(
            `Failed to process artifact "${artifactName}", skipping: ${formatError(err)}`,
          );
          continue;
        }
      } else {
        artifactPart = asSafePartForLlm(
          artifact,
          artifactName,
          this.enableSpreadsheetParsing,
        );
      }

      if (!artifactPart) {
        continue;
      }
      if (artifactPart !== artifact) {
        logger.debug(
          `Transformed artifact "${artifactName}" (mimeType=${artifact.inlineData?.mimeType}) to Part`,
        );
      }

      llmRequest.contents.push({
        role: 'user',
        parts: [{text: `Artifact ${artifactName} is:`}, artifactPart],
      });
    }
  }
}

/**
 * A global instance of {@link LoadArtifactsTool}.
 */
export const LOAD_ARTIFACTS = new LoadArtifactsTool();
