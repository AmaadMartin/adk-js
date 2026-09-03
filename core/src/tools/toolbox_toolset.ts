/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ToolboxClient, ToolboxTool} from '@toolbox-sdk/core';
import {AsyncLocalStorage} from 'node:async_hooks';

import {Context} from '../agents/context.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {BaseTool} from './base_tool.js';
import {BaseToolset, ToolPredicate} from './base_toolset.js';
import {FunctionTool} from './function_tool.js';
import {
  credentialClientHeaders,
  ToolboxCredentialConfig,
  ToolboxCredentialType,
  ToolboxHeaderValue,
  userIdentityAuthConfig,
} from './toolbox_credentials.js';

export type {ToolboxHeaderValue};

/** The optional peer dependency that backs {@link ToolboxToolset}. */
const TOOLBOX_SDK = {
  packageName: '@toolbox-sdk/core',
  feature: 'ToolboxToolset',
};

/**
 * The end user's access token for the invocation in progress, read by the
 * `USER_IDENTITY` client header. The Toolbox client is long-lived and shared
 * by every invocation, so the token cannot be held on the toolset without one
 * user's token leaking into another user's concurrent invocation. Mirrors
 * adk-python's `USER_TOKEN_CONTEXT_VAR`.
 */
const userTokenStorage = new AsyncLocalStorage<string>();

/**
 * Returns the authentication token for one auth service. The toolset calls it
 * once per tool invocation, passing the live {@link Context}, so the token may
 * be derived from the session state, the user, or an ADK credential. A getter
 * that takes no arguments is equally valid.
 */
export type ToolboxAuthTokenGetter = (
  toolContext: Context,
) => string | Promise<string>;

/**
 * Extra arguments forwarded to the `@toolbox-sdk/core` `ToolboxClient`
 * constructor, the TypeScript analogue of adk-python's `**kwargs`.
 */
export interface ToolboxClientOptions {
  /** HTTP client the SDK sends every request through. */
  session?: ConstructorParameters<typeof ToolboxClient>[1];
  /** Toolbox protocol version to negotiate. Defaults to the SDK's own. */
  protocol?: ConstructorParameters<typeof ToolboxClient>[3];
  /** Client name reported to the server. */
  clientName?: string;
  /** Client version reported to the server. */
  clientVersion?: string;
}

/** Options for {@link ToolboxToolset}. */
export interface ToolboxToolsetOptions {
  /** Name of a toolset defined on the server; all of its tools are loaded. */
  toolsetName?: string;
  /** Names of individual tools to load, in addition to the toolset's. */
  toolNames?: string[];
  /**
   * Auth service name to token getter, applied to every loaded tool that
   * declares that service. See
   * https://github.com/googleapis/mcp-toolbox-sdk-js for the auth model.
   */
  authTokenGetters?: Record<string, ToolboxAuthTokenGetter>;
  /**
   * Parameter name to a value bound at load time, so the model neither sees
   * nor supplies it. Either a value, or a (possibly async) getter the SDK
   * calls per invocation.
   */
  boundParams?: Record<string, unknown>;
  /** Headers sent with every request to the server. */
  additionalHeaders?: Record<string, ToolboxHeaderValue>;
  /**
   * How the client authenticates itself to the server. Translated into one
   * header, which wins a name collision with `additionalHeaders`.
   */
  credentials?: ToolboxCredentialConfig;
  /** Forwarded to the `@toolbox-sdk/core` client constructor. */
  clientOptions?: ToolboxClientOptions;
  /** Selects which of the loaded tools the agent sees. */
  toolFilter?: ToolPredicate | string[];
  /** Prepended to every tool name as `${prefix}_${name}`. */
  prefix?: string;
}

/** The auth services a loaded tool still needs a token for. */
function neededAuthServices(tool: ToolboxTool): Set<string> {
  const services = new Set(tool.requiredAuthzTokens);
  for (const sources of Object.values(tool.requiredAuthnParams)) {
    for (const service of sources) {
      services.add(service);
    }
  }
  return services;
}

/**
 * Binds the getters a tool actually needs to one invocation's context,
 * producing the zero-argument getters the SDK calls. Getters for a service
 * the tool does not declare are dropped: the SDK rejects those.
 */
function bindAuthTokenGetters(
  getters: Record<string, ToolboxAuthTokenGetter>,
  needed: Set<string>,
  toolContext: Context,
): Record<string, () => string | Promise<string>> {
  const bound: Record<string, () => string | Promise<string>> = {};
  for (const [service, getter] of Object.entries(getters)) {
    if (needed.has(service)) {
      bound[service] = () => getter(toolContext);
    }
  }
  return bound;
}

/**
 * Rejects auth token getters that no loaded tool can use.
 *
 * `@toolbox-sdk/core` runs this check per load call and does not export it,
 * so the toolset runs its own across the union of the loaded tools: a getter
 * one load call needs must not be reported unused by the other. The message
 * follows the SDK's, so what a user sees does not change shape.
 *
 * @throws If a provided service name matches none of the loaded tools.
 */
function validateAuthTokenGetters(
  getters: Record<string, ToolboxAuthTokenGetter>,
  tools: ToolboxTool[],
  toolsetName?: string,
  toolNames: string[] = [],
): void {
  const used = new Set<string>();
  for (const tool of tools) {
    for (const service of neededAuthServices(tool)) {
      used.add(service);
    }
  }
  const unused = Object.keys(getters)
    .filter((service) => !used.has(service))
    .sort();
  if (unused.length === 0) {
    return;
  }
  const target = toolsetName ? 'toolset' : 'list of tools';
  const name = toolsetName ?? (toolNames.join(', ') || 'default');
  throw new Error(
    `Validation failed for ${target} '${name}': unused auth tokens could ` +
      `not be applied to any tool: ${unused.join(', ')}.`,
  );
}

/** The error a tool returns while it waits for the user to consent. */
function consentRequiredError(toolName: string): {error: string} {
  return {
    error:
      `OAuth2 Credentials required for ${toolName}. A consent link has been ` +
      `generated for the user. Do NOT attempt to run this tool again until ` +
      `the user confirms they have logged in.`,
  };
}

/** The tokens one consented user contributes to a single invocation. */
interface UserIdentityTokens {
  /** Sent in the client header the credential names. */
  accessToken: string;
  /** Registered as the token of every auth service the tool needs. */
  serviceToken: string;
}

/**
 * Runs the `USER_IDENTITY` consent flow for one invocation.
 *
 * Reads the credential from the credential service, then from the session's
 * auth response. A credential found only in the session is written back so
 * later invocations reuse it; a failing write is logged and ignored, because
 * the invocation can still proceed.
 *
 * @return The user's tokens, or the error to return to the model when the
 *   user has not consented yet. Requesting consent is a side effect.
 */
async function resolveUserIdentity(
  authConfig: AuthConfig,
  toolName: string,
  toolContext: Context,
): Promise<UserIdentityTokens | {error: string}> {
  const service = toolContext.invocationContext.credentialService;
  const stored = await service?.loadCredential(authConfig, toolContext);
  const credential = stored ?? toolContext.getAuthResponse(authConfig);
  const accessToken = credential?.oauth2?.accessToken;
  if (!accessToken) {
    toolContext.requestCredential(authConfig);
    return consentRequiredError(toolName);
  }
  if (!stored) {
    try {
      await service?.saveCredential(
        {...authConfig, exchangedAuthCredential: credential},
        toolContext,
      );
    } catch (err: unknown) {
      logger.debug(
        `Failed to save the Toolbox user credential: ${formatError(err)}`,
      );
    }
  }
  return {
    accessToken,
    serviceToken: credential?.oauth2?.idToken ?? accessToken,
  };
}

/** Registers one token as the token of every auth service `tool` needs. */
function withServiceToken(
  tool: ToolboxTool,
  needed: Set<string>,
  token: string,
): ToolboxTool {
  return tool.addAuthTokenGetters(
    Object.fromEntries([...needed].map((service) => [service, () => token])),
  );
}

/**
 * A toolset backed by an MCP Toolbox for Databases server.
 *
 * Each tool published by the server becomes a {@link FunctionTool}, so an
 * agent calls it like any other ADK tool. Nothing is fetched until the first
 * `getTools()` call, and nothing is cached between calls: the tool list is
 * re-read from the server every time.
 *
 * ```ts
 * import {LlmAgent, ToolboxToolset} from '@google/adk';
 *
 * const toolbox = new ToolboxToolset('http://127.0.0.1:5000', {
 *   toolsetName: 'hotel-tools',
 * });
 * const agent = new LlmAgent({
 *   name: 'hotel_agent',
 *   model: 'gemini-flash-latest',
 *   tools: [toolbox],
 * });
 * ```
 *
 * `toolsetName` and `toolNames` are both optional. When `toolsetName` is
 * given, the toolset's tools come first; the tools named by `toolNames`
 * follow, in the order given. A tool reachable both ways appears twice. When
 * neither is given, every tool the server publishes is loaded.
 *
 * `credentials` authenticates the client to the server. Build one with
 * {@link ToolboxCredentialStrategy}:
 *
 * ```ts
 * import {ToolboxCredentialStrategy} from '@google/adk';
 *
 * const toolbox = new ToolboxToolset('https://toolbox.example.com', {
 *   credentials: ToolboxCredentialStrategy.workloadIdentity(
 *     'https://toolbox.example.com',
 *   ),
 * });
 * ```
 *
 * Requires the optional peer dependency `@toolbox-sdk/core`.
 */
export class ToolboxToolset extends BaseToolset {
  private readonly options: ToolboxToolsetOptions;
  private clientPromise?: Promise<ToolboxClient>;

  /**
   * @param serverUrl The URL of the Toolbox server, e.g.
   *   `http://127.0.0.1:5000`.
   * @param options Which tools to load and how to reach them.
   */
  constructor(
    private readonly serverUrl: string,
    options: ToolboxToolsetOptions = {},
  ) {
    super(options.toolFilter ?? [], options.prefix);
    this.options = options;
  }

  /**
   * Resolves the Toolbox client, loading the `@toolbox-sdk/core` optional peer
   * on first use. The promise is cached, so concurrent first calls share one
   * client.
   *
   * @throws If `credentials` is missing a field its type requires. The
   *   constructor performs no work, so a malformed credential surfaces here.
   */
  private getClient(): Promise<ToolboxClient> {
    this.clientPromise ??= loadOptionalPeer(TOOLBOX_SDK, async () => {
      const {ToolboxClient} = await import('@toolbox-sdk/core');
      const {additionalHeaders, credentials, clientOptions} = this.options;
      const headers = {
        ...additionalHeaders,
        ...(credentials
          ? credentialClientHeaders(credentials, () =>
              userTokenStorage.getStore(),
            )
          : {}),
      };
      return new ToolboxClient(
        this.serverUrl,
        clientOptions?.session ?? null,
        headers,
        clientOptions?.protocol,
        clientOptions?.clientName,
        clientOptions?.clientVersion,
      );
    });
    return this.clientPromise;
  }

  /** Wraps one loaded Toolbox tool as an ADK {@link FunctionTool}. */
  private toFunctionTool(tool: ToolboxTool): BaseTool {
    const name = tool.getName();
    return new FunctionTool({
      name: this.prefix ? `${this.prefix}_${name}` : name,
      description: tool.getDescription(),
      parameters: tool.getParamSchema(),
      // FunctionTool always forwards the toolContext of its RunAsyncToolRequest,
      // where the field is required.
      execute: (args, toolContext) => this.invoke(tool, args, toolContext!),
    });
  }

  /**
   * Runs one loaded Toolbox tool, binding the auth tokens it needs to this
   * invocation. Binding returns a new SDK tool, so nothing is shared between
   * concurrent invocations.
   */
  private invoke(
    tool: ToolboxTool,
    args: Record<string, unknown>,
    toolContext: Context,
  ): Promise<unknown> {
    const {credentials} = this.options;
    if (
      credentials?.type === ToolboxCredentialType.USER_IDENTITY &&
      neededAuthServices(tool).size > 0
    ) {
      return this.invokeAsUser(tool, credentials, args, toolContext);
    }
    return this.runWithGetters(tool, args, toolContext);
  }

  /**
   * Runs a tool that needs the end user's own credential, asking for consent
   * when there is none yet.
   */
  private async invokeAsUser(
    tool: ToolboxTool,
    credentials: ToolboxCredentialConfig,
    args: Record<string, unknown>,
    toolContext: Context,
  ): Promise<unknown> {
    const authConfig = userIdentityAuthConfig(
      credentials,
      `toolbox_user_identity_${this.serverUrl}`,
    );
    const resolved = await resolveUserIdentity(
      authConfig,
      tool.getName(),
      toolContext,
    );
    if ('error' in resolved) {
      return resolved;
    }
    const bound = withServiceToken(
      tool,
      neededAuthServices(tool),
      resolved.serviceToken,
    );
    return userTokenStorage.run(resolved.accessToken, () =>
      this.runWithGetters(bound, args, toolContext),
    );
  }

  /**
   * Applies the configured auth token getters, then runs the tool. Services
   * the tool no longer needs are skipped, so a service the user credential
   * already satisfied is not bound twice.
   */
  private runWithGetters(
    tool: ToolboxTool,
    args: Record<string, unknown>,
    toolContext: Context,
  ): Promise<string> {
    const getters = this.options.authTokenGetters;
    if (!getters) {
      return tool(args);
    }
    const bound = bindAuthTokenGetters(
      getters,
      neededAuthServices(tool),
      toolContext,
    );
    return Object.keys(bound).length > 0
      ? tool.addAuthTokenGetters(bound)(args)
      : tool(args);
  }

  /**
   * Loads the server's tools and returns the ones the filter selects.
   *
   * @param context Context a predicate `toolFilter` is evaluated against.
   * @return The loaded tools, prefixed and filtered.
   * @throws If `@toolbox-sdk/core` is not installed, if the server rejects a
   *   load — an unknown tool or toolset name, or a bound parameter that no
   *   loaded tool uses — or if an auth token getter matches no loaded tool.
   */
  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const client = await this.getClient();
    const {toolsetName, authTokenGetters, boundParams} = this.options;
    const toolNames = this.options.toolNames ?? [];

    // No named tools and no toolset name means "load everything", which the
    // server answers as its default toolset.
    const loadsToolset = toolsetName !== undefined || toolNames.length === 0;
    const [toolsetTools, namedTools] = await Promise.all([
      loadsToolset
        ? client.loadToolset(toolsetName, undefined, boundParams)
        : [],
      Promise.all(
        toolNames.map((name) => client.loadTool(name, undefined, boundParams)),
      ),
    ]);

    const loaded = [...toolsetTools, ...namedTools];
    if (authTokenGetters) {
      validateAuthTokenGetters(
        authTokenGetters,
        loaded,
        toolsetName,
        toolNames,
      );
    }

    const tools = loaded.map((tool) => this.toFunctionTool(tool));
    if (!context && typeof this.toolFilter === 'function') {
      logger.warn(
        'ToolboxToolset: a ToolPredicate toolFilter was provided but ' +
          'getTools() was called without a ReadonlyContext. The filter will ' +
          'not be applied.',
      );
    }
    return tools.filter((tool) => this.isToolSelected(tool, context));
  }

  /**
   * Releases the cached client. The Toolbox client holds no connection of its
   * own, so this only drops the reference: a later `getTools()` builds a new
   * client, and calling `close()` twice is safe.
   */
  async close(): Promise<void> {
    this.clientPromise = undefined;
  }
}
