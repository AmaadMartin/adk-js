/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Part, Type} from '@google/genai';

import {Context} from '../agents/context.js';
import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {appendInstructions, LlmRequest} from '../models/llm_request.js';
import {formatError} from '../utils/error_utils.js';
import {getLogger} from '../utils/logger.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

const logger = getLogger();

/** Model-facing description of the tool's only parameter. */
const ARTIFACT_NAMES_DESCRIPTION = 'The names of the artifacts to load.';

const GEMINI_SUPPORTED_INLINE_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
const GEMINI_SUPPORTED_INLINE_MIME_TYPES = new Set(['application/pdf']);
const TEXT_LIKE_MIME_TYPES = new Set([
  'application/csv',
  'application/json',
  'application/xml',
]);

function normalizeMimeType(mimeType?: string): string | undefined {
  if (!mimeType) {
    return undefined;
  }
  return mimeType.split(';')[0].trim();
}

function isInlineMimeTypeSupported(mimeType?: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  if (!normalized) {
    return false;
  }
  return (
    GEMINI_SUPPORTED_INLINE_MIME_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    ) || GEMINI_SUPPORTED_INLINE_MIME_TYPES.has(normalized)
  );
}

/**
 * Converts an artifact into a `Part` that is safe to send to Gemini.
 *
 * A `processArtifact` callback can call this to fall back to the default
 * conversion for an artifact it does not want to handle itself.
 *
 * @param artifact The artifact to convert.
 * @param artifactName The name the artifact was loaded under.
 * @return A part that is safe to send to Gemini.
 */
export function asSafePartForLlm(artifact: Part, artifactName: string): Part {
  const inlineData = artifact.inlineData;
  if (!inlineData) {
    return artifact;
  }

  if (isInlineMimeTypeSupported(inlineData.mimeType)) {
    return artifact;
  }

  const mimeType =
    normalizeMimeType(inlineData.mimeType) || 'application/octet-stream';
  const data = inlineData.data;
  if (!data) {
    return {
      text: `[Artifact: ${artifactName}, type: ${mimeType}. No inline data was provided.]`,
    };
  }

  const isTextLike =
    mimeType.startsWith('text/') || TEXT_LIKE_MIME_TYPES.has(mimeType);

  const decodedBuffer = Buffer.from(data, 'base64');
  if (isTextLike) {
    try {
      const decoded = decodedBuffer.toString('utf8');
      return {text: decoded};
    } catch {
      // Fallback
    }
  }

  const sizeKb = decodedBuffer.length / 1024;
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
}

/**
 * A tool that loads the artifacts and adds them to the session.
 */
export class LoadArtifactsTool extends BaseTool {
  private readonly processArtifact?: ProcessArtifactCallback;

  constructor(params: LoadArtifactsToolParams = {}) {
    super({
      name: 'load_artifacts',
      description: `Loads artifacts into the session for this request.\n\nNOTE: Call when you need access to artifacts (for example, uploads saved by the web UI).`,
    });
    this.processArtifact = params.processArtifact;
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
    const artifactNames = (args['artifact_names'] as string[]) || [];
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

    appendInstructions(llmRequest, [
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
            const artifactNames =
              (response['artifact_names'] as string[]) || [];
            for (const name of artifactNames) {
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
        artifactPart = asSafePartForLlm(artifact, artifactName);
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
