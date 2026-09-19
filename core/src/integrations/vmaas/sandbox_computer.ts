/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A {@link BaseComputer} backed by a Vertex AI Agent Engine Computer Use
 * Sandbox, so an agent drives a hosted browser instead of a local one.
 */

import {Client} from '@google-cloud/vertexai';
import {
  CreateAgentEngineSandboxConfig,
  SandboxEnvironment,
  SandboxEnvironmentSpec,
} from '@google-cloud/vertexai/build/src/genai/types.js';

import {Context} from '../../agents/context.js';
import {State} from '../../sessions/state.js';
import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
  ScrollDirection,
} from '../../tools/computer_use/base_computer.js';
import {formatError} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {SandboxClient, SandboxCommandSender} from './sandbox_client.js';
import {SandboxError, SandboxErrorCode} from './sandbox_errors.js';

/**
 * Session state keys shared with adk-python.
 *
 * The strings stay byte-identical to adk-python's so that a session started by
 * either SDK resolves to the same agent engine, sandbox and token.
 */
const STATE_KEY_AGENT_ENGINE_NAME = '_vmaas_agent_engine_name';
const STATE_KEY_SANDBOX_NAME = '_vmaas_sandbox_name';
const STATE_KEY_ACCESS_TOKEN = '_vmaas_access_token';
const STATE_KEY_TOKEN_EXPIRY = '_vmaas_token_expiry';

/** How long a generated access token is asked to live, in seconds. */
const DEFAULT_TOKEN_TIMEOUT_SECONDS = 3600;

/** How long before expiry a cached token is replaced, in seconds. */
const TOKEN_REFRESH_BUFFER_SECONDS = 60;

/** Defaults for the constructor options adk-python also defaults. */
const DEFAULT_LOCATION = 'us-central1';
const DEFAULT_SANDBOX_TTL_SECONDS = 3600;
const DEFAULT_SEARCH_ENGINE_URL = 'https://www.google.com';

/** The display name given to a sandbox this class creates. */
const DEFAULT_SANDBOX_DISPLAY_NAME = 'adk_computer_use_sandbox';

/** The pixel magnitude `scrollDocument` scrolls by. */
const SCROLL_MAGNITUDE = 400;

/** The screen size the sandbox browser runs at, in pixels. */
const SCREEN_SIZE: [number, number] = [1280, 720];

/** How long to wait for an agent engine creation operation to finish. */
const ENGINE_POLL_MAX_ATTEMPTS = 180;
const ENGINE_POLL_INTERVAL_MS = 1000;

/**
 * The separator that splits an agent engine resource name from the sandbox
 * resource that lives under it.
 */
const SANDBOX_RESOURCE_SEPARATOR = '/sandboxEnvironment';

/** The segment every agent engine resource name contains. */
const REASONING_ENGINES_SEGMENT = '/reasoningEngines/';

/**
 * Issues an access token for a sandbox.
 *
 * `@google-cloud/vertexai@1.12.0` does not expose the sandbox
 * `generateAccessToken` method that adk-python calls, so the caller supplies
 * the provider.
 */
export type AccessTokenProvider = (params: {
  sandboxName: string;
  serviceAccountEmail?: string;
  timeoutSeconds: number;
}) => Promise<string>;

/**
 * The create-sandbox config fields adk-python sets that
 * `CreateAgentEngineSandboxConfig` does not declare in
 * `@google-cloud/vertexai@1.12.0`. The backend accepts both.
 */
interface ComputerUseSandboxConfig extends CreateAgentEngineSandboxConfig {
  sandboxEnvironmentTemplate?: string;
  sandboxEnvironmentSnapshot?: string;
}

/** Options for {@link AgentEngineSandboxComputer}. */
export interface AgentEngineSandboxComputerOptions {
  /** The Google Cloud project the sandbox lives in. */
  projectId?: string;
  /** The Vertex AI location. Defaults to `us-central1`. */
  location?: string;
  /**
   * The service account that mints the sandbox access token. It needs
   * `roles/iam.serviceAccountTokenCreator`.
   */
  serviceAccountEmail?: string;
  /**
   * An existing sandbox to drive, instead of creating one.
   *
   * Format:
   * `projects/{project}/locations/{location}/reasoningEngines/{engine}/sandboxEnvironments/{id}`
   */
  sandboxName?: string;
  /** A sandbox template to create the sandbox from. */
  sandboxTemplateName?: string;
  /** A sandbox snapshot to restore the sandbox from. */
  sandboxSnapshotName?: string;
  /** How long a created sandbox lives, in seconds. Defaults to one hour. */
  sandboxTtlSeconds?: number;
  /** The page {@link AgentEngineSandboxComputer.search} navigates to. */
  searchEngineUrl?: string;
  /** A Vertex AI client to reuse instead of creating one. */
  vertexaiClient?: Client;
  /** Issues the sandbox access token. */
  accessTokenProvider?: AccessTokenProvider;
  /** Carries a request to the sandbox. */
  sendCommand?: SandboxCommandSender;
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The current time in seconds, the unit adk-python writes into state. */
function nowSeconds(): number {
  return Date.now() / 1000;
}

/**
 * Derives the agent engine that owns a sandbox, template or snapshot.
 *
 * The backend requires a sandbox to be created under the same reasoning engine
 * that owns its template or snapshot, so the engine is read from whichever
 * resource name the caller supplied rather than created fresh. Every sandbox
 * resource name embeds its engine:
 * `projects/.../reasoningEngines/{engine}/sandboxEnvironment{s|Templates|Snapshots}/...`
 */
function deriveAgentEngineName(
  resourceNames: Array<string | undefined>,
): string | undefined {
  for (const resourceName of resourceNames) {
    if (!resourceName) {
      continue;
    }
    const engineName = resourceName.split(SANDBOX_RESOURCE_SEPARATOR)[0];
    if (
      engineName !== resourceName &&
      engineName.includes(REASONING_ENGINES_SEGMENT)
    ) {
      return engineName;
    }
  }
  return undefined;
}

/**
 * Drives a browser hosted in a Vertex AI Agent Engine Computer Use Sandbox.
 *
 * The computer provisions an agent engine and a sandbox on first use, or
 * drives one the caller already owns. It shares the engine name, the sandbox
 * name and the access token through session state, so a later invocation and a
 * second agent server instance reach the same browser.
 *
 * `@google-cloud/vertexai@1.12.0` exposes no sandbox access-token or
 * send-command method, so {@link AgentEngineSandboxComputerOptions.accessTokenProvider}
 * and {@link AgentEngineSandboxComputerOptions.sendCommand} carry those two
 * requests.
 *
 * @example
 * ```ts
 * const computer = new AgentEngineSandboxComputer({
 *   projectId: process.env.GOOGLE_CLOUD_PROJECT,
 *   serviceAccountEmail: process.env.VMAAS_SERVICE_ACCOUNT,
 *   accessTokenProvider: mintSandboxToken,
 *   sendCommand: callSandbox,
 * });
 * ```
 */
@experimental
export class AgentEngineSandboxComputer extends BaseComputer {
  /** The agent engine derived from the sandbox, template or snapshot name. */
  readonly agentEngineName?: string;
  /** The existing sandbox this computer drives, when the caller named one. */
  readonly sandboxName?: string;
  /** The template a created sandbox is built from. */
  readonly sandboxTemplateName?: string;
  /** The snapshot a created sandbox is restored from. */
  readonly sandboxSnapshotName?: string;

  private readonly projectId?: string;
  private readonly location: string;
  private readonly serviceAccountEmail?: string;
  private readonly sandboxTtlSeconds: number;
  private readonly searchEngineUrl: string;
  private readonly accessTokenProvider?: AccessTokenProvider;
  private readonly sendCommand?: SandboxCommandSender;
  private client?: Client;
  private state?: State;

  constructor(options: AgentEngineSandboxComputerOptions = {}) {
    super();
    this.projectId = options.projectId;
    this.location = options.location ?? DEFAULT_LOCATION;
    this.serviceAccountEmail = options.serviceAccountEmail;
    this.sandboxName = options.sandboxName;
    this.sandboxTemplateName = options.sandboxTemplateName;
    this.sandboxSnapshotName = options.sandboxSnapshotName;
    this.sandboxTtlSeconds =
      options.sandboxTtlSeconds ?? DEFAULT_SANDBOX_TTL_SECONDS;
    this.searchEngineUrl = options.searchEngineUrl ?? DEFAULT_SEARCH_ENGINE_URL;
    this.client = options.vertexaiClient;
    this.accessTokenProvider = options.accessTokenProvider;
    this.sendCommand = options.sendCommand;
    this.agentEngineName = deriveAgentEngineName([
      options.sandboxName,
      options.sandboxTemplateName,
      options.sandboxSnapshotName,
    ]);
  }

  /** Binds the session state the sandbox resources are shared through. */
  override async prepare(context: Context): Promise<void> {
    this.state = context.state;
  }

  /**
   * Initializes the computer.
   *
   * Provisioning happens on the first action, so there is nothing to do here.
   */
  override async initialize(): Promise<void> {}

  /**
   * Releases the resources held by the computer.
   *
   * The sandbox is deliberately left running: the sandbox service deletes it
   * when its TTL expires, and keeping it alive lets an agent that restarts
   * within that window resume the same browser.
   */
  override async close(): Promise<void> {}

  async screenSize(): Promise<[number, number]> {
    return SCREEN_SIZE;
  }

  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }

  /**
   * Opens the web browser.
   *
   * The sandbox browser is always running, so this reports the current state.
   */
  async openWebBrowser(): Promise<ComputerState> {
    return this.currentState();
  }

  async clickAt(params: {x: number; y: number}): Promise<ComputerState> {
    const client = await this.getSandboxClient();
    await client.clickAt(params.x, params.y);
    return this.currentState();
  }

  async hoverAt(params: {x: number; y: number}): Promise<ComputerState> {
    const client = await this.getSandboxClient();
    await client.hoverAt(params.x, params.y);
    return this.currentState();
  }

  async typeTextAt(params: {
    x: number;
    y: number;
    text: string;
    pressEnter?: boolean;
    clearBeforeTyping?: boolean;
  }): Promise<ComputerState> {
    const client = await this.getSandboxClient();
    await client.typeTextAt({
      x: params.x,
      y: params.y,
      text: params.text,
      pressEnter: params.pressEnter ?? true,
      clearBeforeTyping: params.clearBeforeTyping ?? true,
    });
    return this.currentState();
  }

  async scrollDocument(params: {
    direction: ScrollDirection;
  }): Promise<ComputerState> {
    const [width, height] = SCREEN_SIZE;
    return this.scrollAt({
      x: Math.floor(width / 2),
      y: Math.floor(height / 2),
      direction: params.direction,
      magnitude: SCROLL_MAGNITUDE,
    });
  }

  async scrollAt(params: {
    x: number;
    y: number;
    direction: ScrollDirection;
    magnitude: number;
  }): Promise<ComputerState> {
    const client = await this.getSandboxClient();
    await client.scrollAt(params);
    return this.currentState();
  }

  async wait(params: {seconds: number}): Promise<ComputerState> {
    await sleep(params.seconds * 1000);
    return this.currentState();
  }

  async goBack(): Promise<ComputerState> {
    const client = await this.getSandboxClient();
    await client.goBack();
    return this.currentState();
  }

  async goForward(): Promise<ComputerState> {
    const client = await this.getSandboxClient();
    await client.goForward();
    return this.currentState();
  }

  /** Navigates to the configured search engine home page. */
  async search(): Promise<ComputerState> {
    return this.navigate({url: this.searchEngineUrl});
  }

  async navigate(params: {url: string}): Promise<ComputerState> {
    const client = await this.getSandboxClient();
    await client.navigate(params.url);
    return this.currentState();
  }

  async keyCombination(params: {keys: string[]}): Promise<ComputerState> {
    const client = await this.getSandboxClient();
    await client.keyCombination(params.keys);
    return this.currentState();
  }

  async dragAndDrop(params: {
    x: number;
    y: number;
    destinationX: number;
    destinationY: number;
  }): Promise<ComputerState> {
    const client = await this.getSandboxClient();
    await client.dragAndDrop(params);
    return this.currentState();
  }

  async currentState(): Promise<ComputerState> {
    const client = await this.getSandboxClient();
    const screenshot = await client.getScreenshot();
    const url = await client.getCurrentUrl();
    return {screenshot, url};
  }

  /** The session state bound by {@link prepare}. */
  private requireState(): State {
    if (!this.state) {
      throw new SandboxError(
        SandboxErrorCode.SESSION_STATE_NOT_BOUND,
        'The sandbox computer has no session state. Call prepare() with a ' +
          'tool context before driving the browser.',
      );
    }
    return this.state;
  }

  /** The Vertex AI client, created on first use. */
  private getClient(): Client {
    this.client ??= new Client({
      project: this.projectId,
      location: this.location,
    });
    return this.client;
  }

  /**
   * The agent engine to create sandboxes under, creating one if there is none.
   *
   * An engine that came from the constructor or from session state is returned
   * unchanged, so only a newly created engine is written back to state.
   */
  private async ensureAgentEngine(): Promise<string> {
    if (this.agentEngineName) {
      return this.agentEngineName;
    }
    const state = this.requireState();
    const cachedName = state.get<string>(STATE_KEY_AGENT_ENGINE_NAME);
    if (cachedName) {
      return cachedName;
    }
    const createdName = await this.createAgentEngine();
    state.set(STATE_KEY_AGENT_ENGINE_NAME, createdName);
    return createdName;
  }

  /** Creates an agent engine and waits for the operation to finish. */
  private async createAgentEngine(): Promise<string> {
    logger.debug('Creating a new agent engine.');
    const client = this.getClient();
    const operation = await client.agentEnginesInternal.createInternal({});
    let current = operation;
    for (
      let attempt = 0;
      !current.done && attempt < ENGINE_POLL_MAX_ATTEMPTS;
      attempt++
    ) {
      await sleep(ENGINE_POLL_INTERVAL_MS);
      current = await client.agentEnginesInternal.getAgentOperationInternal({
        operationName: operation.name!,
      });
    }
    if (!current.done) {
      throw new SandboxError(
        SandboxErrorCode.AGENT_ENGINE_CREATE_TIMED_OUT,
        `Agent engine creation operation ${operation.name} did not finish ` +
          `after ${ENGINE_POLL_MAX_ATTEMPTS} attempts.`,
      );
    }
    const createdName = current.response?.name;
    if (!createdName) {
      throw new SandboxError(
        SandboxErrorCode.AGENT_ENGINE_NAME_MISSING,
        'The agent engine creation operation finished without a resource name.',
      );
    }
    logger.debug(`Created agent engine: ${createdName}`);
    return createdName;
  }

  /** The sandbox to drive, creating one if there is none. */
  private async getSandbox(): Promise<[string, SandboxEnvironment]> {
    const client = this.getClient();
    if (this.sandboxName) {
      const sandbox = await client.agentEnginesInternal.sandboxes.getInternal({
        name: this.sandboxName,
      });
      return [this.sandboxName, sandbox];
    }
    const state = this.requireState();
    const cachedName = state.get<string>(STATE_KEY_SANDBOX_NAME);
    if (cachedName) {
      const sandbox = await client.agentEnginesInternal.sandboxes.getInternal({
        name: cachedName,
      });
      return [cachedName, sandbox];
    }

    const agentEngineName = await this.ensureAgentEngine();
    logger.debug(`Creating a new sandbox under ${agentEngineName}.`);
    const config: ComputerUseSandboxConfig = {
      displayName: DEFAULT_SANDBOX_DISPLAY_NAME,
      ttl: `${this.sandboxTtlSeconds}s`,
      waitForCompletion: true,
    };
    let spec: SandboxEnvironmentSpec | undefined;
    if (this.sandboxTemplateName) {
      config.sandboxEnvironmentTemplate = this.sandboxTemplateName;
    } else if (this.sandboxSnapshotName) {
      config.sandboxEnvironmentSnapshot = this.sandboxSnapshotName;
    } else {
      spec = {computerUseEnvironment: {}};
    }

    const operation =
      await client.agentEnginesInternal.sandboxes.createInternal({
        name: agentEngineName,
        spec,
        config,
      });
    const sandbox = operation.response;
    if (!sandbox?.name) {
      throw new SandboxError(
        SandboxErrorCode.SANDBOX_NAME_MISSING,
        'The sandbox creation operation finished without a resource name.',
      );
    }
    state.set(STATE_KEY_SANDBOX_NAME, sandbox.name);
    logger.debug(`Created sandbox: ${sandbox.name}`);
    return [sandbox.name, sandbox];
  }

  /** The cached access token, or a freshly generated one. */
  private async getAccessToken(sandboxName: string): Promise<string> {
    const state = this.requireState();
    const cachedToken = state.get<string>(STATE_KEY_ACCESS_TOKEN);
    const expiry = state.get<number>(STATE_KEY_TOKEN_EXPIRY, 0) ?? 0;
    if (cachedToken && nowSeconds() < expiry - TOKEN_REFRESH_BUFFER_SECONDS) {
      return cachedToken;
    }
    if (!this.accessTokenProvider) {
      throw new SandboxError(
        SandboxErrorCode.SDK_TRANSPORT_UNAVAILABLE,
        '@google-cloud/vertexai exposes no sandbox generateAccessToken ' +
          'method. Pass an accessTokenProvider to AgentEngineSandboxComputer.',
      );
    }
    logger.debug(`Generating a new access token for sandbox ${sandboxName}.`);
    const token = await this.accessTokenProvider({
      sandboxName,
      serviceAccountEmail: this.serviceAccountEmail,
      timeoutSeconds: DEFAULT_TOKEN_TIMEOUT_SECONDS,
    });
    state.set(STATE_KEY_ACCESS_TOKEN, token);
    state.set(
      STATE_KEY_TOKEN_EXPIRY,
      nowSeconds() + DEFAULT_TOKEN_TIMEOUT_SECONDS,
    );
    return token;
  }

  /**
   * A sandbox client for the current sandbox and a valid token.
   *
   * A token failure clears the cached token and is retried once, because a
   * cached token the backend has already revoked fails until it is dropped. A
   * second failure propagates.
   */
  private async getSandboxClient(): Promise<SandboxClient> {
    const [sandboxName, sandbox] = await this.getSandbox();
    let accessToken: string;
    try {
      accessToken = await this.getAccessToken(sandboxName);
    } catch (e: unknown) {
      logger.warn(
        `Access token generation failed, clearing the cached token: ${formatError(e)}`,
      );
      const state = this.requireState();
      state.set(STATE_KEY_ACCESS_TOKEN, undefined);
      state.set(STATE_KEY_TOKEN_EXPIRY, 0);
      accessToken = await this.getAccessToken(sandboxName);
    }
    if (!this.sendCommand) {
      throw new SandboxError(
        SandboxErrorCode.SDK_TRANSPORT_UNAVAILABLE,
        '@google-cloud/vertexai exposes no sandbox sendCommand method. Pass ' +
          'a sendCommand to AgentEngineSandboxComputer.',
      );
    }
    return new SandboxClient({
      sandbox,
      accessToken,
      sendCommand: this.sendCommand,
    });
  }
}
