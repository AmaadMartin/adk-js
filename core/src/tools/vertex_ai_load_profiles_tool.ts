/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// The package root re-exports the legacy `build/src/types` module, which does
// not declare `MemoryProfile`. This deep path is the only route to it, and it
// is the one `memory/vertex_ai_memory_bank_service.ts` already uses.
import {MemoryProfile} from '@google-cloud/vertexai/build/src/genai/types.js';

import {Context} from '../agents/context.js';
import {FunctionTool} from './function_tool.js';

const LOAD_PROFILES_TOOL_NAME = 'load_profiles';

const LOAD_PROFILES_DESCRIPTION =
  'Loads structured user profiles for the current user.';

/**
 * The Vertex Memory Bank capability this tool needs: a scope-keyed lookup of
 * the structured profiles registered against an `(appName, userId)` pair.
 *
 * The tool depends on this shape rather than on `VertexAiMemoryBankService`
 * itself, because profile retrieval is not part of `BaseMemoryService` and the
 * tool never needs the rest of the service.
 */
export interface ProfileRetrievingMemoryService {
  retrieveProfiles(request: {
    appName: string;
    userId: string;
  }): Promise<MemoryProfile[]>;
}

/** Constructor options for {@link VertexAiLoadProfilesTool}. */
export interface VertexAiLoadProfilesToolOptions {
  /** The service the tool reads profiles from. */
  memoryService: ProfileRetrievingMemoryService;
}

/**
 * Reads the profiles for the caller's scope and returns their payloads.
 *
 * A profile with no payload carries nothing for the model to read, so it is
 * dropped rather than returned as an empty object.
 */
async function loadProfiles(
  memoryService: ProfileRetrievingMemoryService,
  toolContext?: Context,
): Promise<{profiles: Array<Record<string, unknown>>}> {
  if (!toolContext) {
    throw new Error(
      `Tool '${LOAD_PROFILES_TOOL_NAME}' requires a tool context.`,
    );
  }

  const profiles = await memoryService.retrieveProfiles({
    appName: toolContext.invocationContext.appName,
    userId: toolContext.userId,
  });

  return {
    profiles: profiles
      .map((entry) => entry.profile)
      .filter(
        (profile): profile is Record<string, unknown> =>
          !!profile && Object.keys(profile).length > 0,
      ),
  };
}

/**
 * A tool that loads the current user's structured profiles from Vertex Memory
 * Bank.
 *
 * Profiles are a Memory Bank capability distinct from memory search: a
 * scope-keyed lookup of schema-shaped records, not a semantic query. Give the
 * model this tool when it should fetch the user's profile record on demand,
 * instead of the developer placing that record in the system instruction on
 * every turn.
 *
 * The tool takes no arguments. It reads the app name and the user id from the
 * tool context, and returns one payload per non-empty profile.
 *
 * Pass any service that implements {@link ProfileRetrievingMemoryService}. See
 * `docs/guides/tools/vertex_ai_load_profiles/index.md` for one built on the
 * Vertex AI SDK.
 *
 * @example
 * ```ts
 * import {LlmAgent, ProfileRetrievingMemoryService, VertexAiLoadProfilesTool} from '@google/adk';
 *
 * function buildConcierge(memoryService: ProfileRetrievingMemoryService) {
 *   return new LlmAgent({
 *     name: 'concierge',
 *     model: 'gemini-2.5-flash',
 *     tools: [new VertexAiLoadProfilesTool({memoryService})],
 *   });
 * }
 * ```
 */
export class VertexAiLoadProfilesTool extends FunctionTool {
  constructor(options: VertexAiLoadProfilesToolOptions) {
    super({
      name: LOAD_PROFILES_TOOL_NAME,
      description: LOAD_PROFILES_DESCRIPTION,
      execute: (_args, toolContext) =>
        loadProfiles(options.memoryService, toolContext),
    });
  }
}
