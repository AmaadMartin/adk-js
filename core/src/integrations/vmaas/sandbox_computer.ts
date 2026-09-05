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
  AgentEngineOperation,
  AgentEngineSandboxOperation,
  CreateAgentEngineRequestParameters,
  CreateAgentEngineSandboxConfig,
  CreateAgentEngineSandboxRequestParameters,
  GetAgentEngineOperationParameters,
  GetAgentEngineSandboxOperationParameters,
  GetAgentEngineSandboxRequestParameters,
  ReasoningEngine,
  SandboxEnvironment,
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
import {
  SandboxClient,
  SandboxCommandSender,
  SandboxJson,
} from './sandbox_client.js';
import {SandboxError, SandboxErrorCode} from './sandbox_errors.js';

/**
 * The session state keys the resources are shared through.
 *
 * The strings stay byte-identical to adk-python's, so a session written by
 * either SDK resolves to the same agent engine, sandbox and token.
 */
const STATE_KEY_AGENT_ENGINE_NAME = '_vmaas_agent_engine_name';
const STATE_KEY_SANDBOX_NAME = '_vmaas_sandbox_name';
const STATE_KEY_ACCESS_TOKEN = '_vmaas_access_token';
const STATE_KEY_TOKEN_EXPIRY = '_vmaas_token_expiry';

/** How long a minted access token is asked to live, in seconds. */
const TOKEN_TIMEOUT_SECONDS = 3600;

/** How long before its expiry a cached token is replaced, in seconds. */
const TOKEN_REFRESH_BUFFER_SECONDS = 60;

/** The defaults adk-python gives the same options. */
const DEFAULT_LOCATION = 'us-central1';
const DEFAULT_SANDBOX_TTL_SECONDS = 3600;
const DEFAULT_SEARCH_ENGINE_URL = 'https://www.google.com';

/** The display name of a sandbox this computer creates. */
const SANDBOX_DISPLAY_NAME = 'adk_computer_use_sandbox';

/** The size of the sandbox browser window, in pixels. */
const SCREEN_SIZE: [number, number] = [1280, 720];

/** How far {@link AgentEngineSandboxComputer.scrollDocument} scrolls. */
const SCROLL_DOCUMENT_MAGNITUDE = 400;

/** How long to wait for a create operation, matching the code executor. */
const OPERATION_MAX_POLLS = 180;
const OPERATION_POLL_INTERVAL_MS = 1000;

/** The text that separates an engine name from the sandbox resource under it. */
const SANDBOX_RESOURCE_SEPARATOR = '/sandboxEnvironment';

/** The segment every agent engine resource name contains. */
const REASONING_ENGINES_SEGMENT = '/reasoningEngines/';

/**
 * Mints an access token for a sandbox.
 *
 * `@google-cloud/vertexai` exposes no sandbox `generateAccessToken` method, so
 * the caller supplies the provider.
 */
export type AccessTokenProvider = (params: {
  sandboxName: string;
  serviceAccountEmail?: string;
  timeoutSeconds: number;
}) => Promise<string>;

/**
 * The part of the Vertex AI client this computer calls.
 *
 * A `Client` from `@google-cloud/vertexai` satisfies it. Declaring the calls
 * the computer makes, rather than the whole client, lets a caller — a test, or
 * an application that wraps the client — supply its own implementation without
 * building the parts that go unused.
 */
export interface AgentEngineSandboxApi {
  agentEnginesInternal: {
    createInternal(
      params: CreateAgentEngineRequestParameters,
    ): Promise<AgentEngineOperation>;
    getAgentOperationInternal(
      params: GetAgentEngineOperationParameters,
    ): Promise<AgentEngineOperation>;
    sandboxes: {
      getInternal(
        params: GetAgentEngineSandboxRequestParameters,
      ): Promise<SandboxEnvironment>;
      createInternal(
        params: CreateAgentEngineSandboxRequestParameters,
      ): Promise<AgentEngineSandboxOperation>;
      getSandboxOperationInternal(
        params: GetAgentEngineSandboxOperationParameters,
      ): Promise<AgentEngineSandboxOperation>;
    };
  };
}

/** Options for {@link AgentEngineSandboxComputer}. */
export interface AgentEngineSandboxComputerOptions {
  /** The Google Cloud project. Application Default Credentials when omitted. */
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
  /** A template to build a created sandbox from. */
  sandboxTemplateName?: string;
  /** A snapshot to restore a created sandbox from. */
  sandboxSnapshotName?: string;
  /** How long a created sandbox lives, in seconds. Defaults to one hour. */
  sandboxTtlSeconds?: number;
  /** The page {@link AgentEngineSandboxComputer.search} opens. */
  searchEngineUrl?: string;
  /** A Vertex AI client to reuse instead of creating one. */
  vertexaiClient?: AgentEngineSandboxApi;
  /** Mints the sandbox access token. */
  accessTokenProvider?: AccessTokenProvider;
  /** Carries a request to the sandbox. */
  sendCommand?: SandboxCommandSender;
}

/** A long-running operation, as the agent engine API reports it. */
interface LongRunningOperation<T> {
  name?: string;
  done?: boolean;
  response?: T;
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
 * Polls a create operation until it finishes, and returns what it created.
 *
 * Both create calls return while the backend is still working, so the caller
 * polls. `CreateAgentEngineSandboxConfig.waitForCompletion` would say so
 * declaratively, but the request converter in `@google-cloud/vertexai@1.12.0`
 * drops the field, so it never reaches the backend.
 */
async function awaitCreatedResource<T extends {name?: string}>(
  operation: LongRunningOperation<T>,
  poll: () => Promise<LongRunningOperation<T>>,
  resource: string,
): Promise<T> {
  let current = operation;
  for (let polls = 0; !current.done && polls < OPERATION_MAX_POLLS; polls++) {
    await sleep(OPERATION_POLL_INTERVAL_MS);
    current = await poll();
  }
  if (!current.done) {
    throw new SandboxError(
      SandboxErrorCode.CREATE_OPERATION_INCOMPLETE,
      `The operation ${operation.name} that creates the ${resource} was still ` +
        `running after ${OPERATION_MAX_POLLS} polls.`,
    );
  }
  if (!current.response?.name) {
    throw new SandboxError(
      SandboxErrorCode.CREATED_RESOURCE_UNNAMED,
      `The operation ${operation.name} finished without naming the ${resource} ` +
        'it created.',
    );
  }
  return current.response;
}

/**
 * The agent engine that owns a sandbox, template or snapshot.
 *
 * The backend creates a sandbox under the same reasoning engine that owns its
 * template or snapshot, so the engine is read from whichever resource name the
 * caller supplied rather than created fresh. Every such name embeds its engine:
 * `projects/.../reasoningEngines/{engine}/sandboxEnvironment{s,Templates,Snapshots}/...`
 *
 * @param resourceNames The candidates, in the order they take precedence.
 * @returns The first engine a candidate yields, or `undefined` for none.
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
 * The request fields that build a sandbox from a template or a snapshot.
 *
 * A template takes precedence over a snapshot, as it does in adk-python. The
 * fields ride in `httpOptions.extraBody` because the generated request
 * converter in `@google-cloud/vertexai@1.12.0` copies only `displayName`,
 * `description` and `ttl` out of the create config, and would drop these two.
 */
function sandboxSourceFields(
  templateName?: string,
  snapshotName?: string,
): SandboxJson | undefined {
  if (templateName) {
    return {sandboxEnvironmentTemplate: templateName};
  }
  if (snapshotName) {
    return {sandboxEnvironmentSnapshot: snapshotName};
  }
  return undefined;
}

/**
 * Drives a browser hosted in a Vertex AI Agent Engine Computer Use Sandbox.
 *
 * The computer creates an agent engine and a sandbox on first use, or drives a
 * sandbox the caller already owns. It shares the engine name, the sandbox name
 * and the access token through session state, so a later invocation and a
 * second agent server instance reach the same browser.
 *
 * `@google-cloud/vertexai` exposes neither of the two sandbox methods
 * adk-python calls, so
 * {@link AgentEngineSandboxComputerOptions.accessTokenProvider} and
 * {@link AgentEngineSandboxComputerOptions.sendCommand} carry those requests.
 *
 * @example
 * ```ts
 * const computer = new AgentEngineSandboxComputer({
 *   projectId: process.env.GOOGLE_CLOUD_PROJECT,
 *   serviceAccountEmail: process.env.SANDBOX_SERVICE_ACCOUNT,
 *   accessTokenProvider: mintSandboxToken,
 *   sendCommand: callSandbox,
 * });
 * await computer.prepare(context);
 * const {screenshot, url} = await computer.navigate({url: 'https://example.com'});
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
  private client?: AgentEngineSandboxApi;
  private sessionState?: State;

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
    this.sessionState = context.state;
  }

  /**
   * Releases the resources held by the computer.
   *
   * The sandbox is deliberately left running. The sandbox service deletes it
   * when its time to live expires, and until then an agent that restarts
   * resumes the same browser.
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
   * The sandbox browser always runs, so this reports the current state.
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

  /** Scrolls the whole page, from its centre. */
  async scrollDocument(params: {
    direction: ScrollDirection;
  }): Promise<ComputerState> {
    const [width, height] = SCREEN_SIZE;
    return this.scrollAt({
      x: Math.floor(width / 2),
      y: Math.floor(height / 2),
      direction: params.direction,
      magnitude: SCROLL_DOCUMENT_MAGNITUDE,
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

  /** Opens the home page of the configured search engine. */
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

  /** The session state {@link prepare} bound. */
  private requireSessionState(): State {
    if (!this.sessionState) {
      throw new SandboxError(
        SandboxErrorCode.SESSION_STATE_NOT_BOUND,
        'The computer holds no session state. Call prepare() with a context ' +
          'before driving the browser.',
      );
    }
    return this.sessionState;
  }

  /**
   * The two transports, or a failure naming the one that is missing.
   *
   * Both are read before any action starts, so a computer that cannot drive a
   * browser says so instead of first creating a sandbox in the caller's
   * project.
   */
  private requireTransport(): {
    accessTokenProvider: AccessTokenProvider;
    sendCommand: SandboxCommandSender;
  } {
    const {accessTokenProvider, sendCommand} = this;
    if (!accessTokenProvider) {
      throw new SandboxError(
        SandboxErrorCode.TRANSPORT_NOT_CONFIGURED,
        '@google-cloud/vertexai exposes no sandbox generateAccessToken ' +
          'method. Pass an accessTokenProvider to AgentEngineSandboxComputer.',
      );
    }
    if (!sendCommand) {
      throw new SandboxError(
        SandboxErrorCode.TRANSPORT_NOT_CONFIGURED,
        '@google-cloud/vertexai exposes no sandbox sendCommand method. Pass a ' +
          'sendCommand to AgentEngineSandboxComputer.',
      );
    }
    return {accessTokenProvider, sendCommand};
  }

  /** The Vertex AI client, created on first use. */
  private getClient(): AgentEngineSandboxApi {
    this.client ??= new Client({
      project: this.projectId,
      location: this.location,
    });
    return this.client;
  }

  /**
   * The agent engine to create sandboxes under, creating one if there is none.
   *
   * An engine named by the constructor is returned without reading session
   * state, so only a created engine is written back to it.
   */
  private async ensureAgentEngine(): Promise<string> {
    if (this.agentEngineName) {
      return this.agentEngineName;
    }
    const state = this.requireSessionState();
    const sharedName = state.get<string>(STATE_KEY_AGENT_ENGINE_NAME);
    if (sharedName) {
      return sharedName;
    }
    logger.debug('Creating a new agent engine.');
    const client = this.getClient();
    const operation = await client.agentEnginesInternal.createInternal({});
    const engine = await awaitCreatedResource<ReasoningEngine>(
      operation,
      () =>
        client.agentEnginesInternal.getAgentOperationInternal({
          operationName: operation.name!,
        }),
      'agent engine',
    );
    const engineName = engine.name!;
    state.set(STATE_KEY_AGENT_ENGINE_NAME, engineName);
    logger.debug(`Created the agent engine ${engineName}.`);
    return engineName;
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
    const state = this.requireSessionState();
    const sharedName = state.get<string>(STATE_KEY_SANDBOX_NAME);
    if (sharedName) {
      const sandbox = await client.agentEnginesInternal.sandboxes.getInternal({
        name: sharedName,
      });
      return [sharedName, sandbox];
    }
    const sandbox = await this.createSandbox();
    const createdName = sandbox.name!;
    state.set(STATE_KEY_SANDBOX_NAME, createdName);
    logger.debug(`Created the sandbox ${createdName}.`);
    return [createdName, sandbox];
  }

  /** Creates a sandbox and waits for the create operation to finish. */
  private async createSandbox(): Promise<SandboxEnvironment> {
    const agentEngineName = await this.ensureAgentEngine();
    const client = this.getClient();
    const source = sandboxSourceFields(
      this.sandboxTemplateName,
      this.sandboxSnapshotName,
    );
    const config: CreateAgentEngineSandboxConfig = {
      displayName: SANDBOX_DISPLAY_NAME,
      ttl: `${this.sandboxTtlSeconds}s`,
    };
    if (source) {
      config.httpOptions = {extraBody: source};
    }
    logger.debug(`Creating a new sandbox under ${agentEngineName}.`);
    const operation =
      await client.agentEnginesInternal.sandboxes.createInternal({
        name: agentEngineName,
        // A sandbox built from a template or a snapshot takes its environment
        // from that resource, so it carries no spec of its own.
        spec: source ? undefined : {computerUseEnvironment: {}},
        config,
      });
    return awaitCreatedResource<SandboxEnvironment>(
      operation,
      () =>
        client.agentEnginesInternal.sandboxes.getSandboxOperationInternal({
          operationName: operation.name!,
        }),
      'sandbox',
    );
  }

  /** The shared access token, minting a new one when it is about to expire. */
  private async getAccessToken(
    sandboxName: string,
    provider: AccessTokenProvider,
  ): Promise<string> {
    const state = this.requireSessionState();
    const sharedToken = state.get<string>(STATE_KEY_ACCESS_TOKEN);
    const expiry = state.get<number>(STATE_KEY_TOKEN_EXPIRY) ?? 0;
    if (sharedToken && nowSeconds() < expiry - TOKEN_REFRESH_BUFFER_SECONDS) {
      return sharedToken;
    }
    logger.debug(`Minting an access token for the sandbox ${sandboxName}.`);
    const token = await provider({
      sandboxName,
      serviceAccountEmail: this.serviceAccountEmail,
      timeoutSeconds: TOKEN_TIMEOUT_SECONDS,
    });
    state.set(STATE_KEY_ACCESS_TOKEN, token);
    state.set(STATE_KEY_TOKEN_EXPIRY, nowSeconds() + TOKEN_TIMEOUT_SECONDS);
    return token;
  }

  /**
   * A sandbox client holding the current sandbox and a valid token.
   *
   * A token failure drops the shared token and is retried once, because a token
   * the backend has already revoked keeps failing until it is dropped. A second
   * failure reaches the caller.
   */
  private async getSandboxClient(): Promise<SandboxClient> {
    const {accessTokenProvider, sendCommand} = this.requireTransport();
    const [sandboxName, sandbox] = await this.getSandbox();
    let accessToken: string;
    try {
      accessToken = await this.getAccessToken(sandboxName, accessTokenProvider);
    } catch (e: unknown) {
      logger.warn(
        `Minting an access token failed, dropping the shared one: ${formatError(e)}`,
      );
      const state = this.requireSessionState();
      state.set(STATE_KEY_ACCESS_TOKEN, undefined);
      state.set(STATE_KEY_TOKEN_EXPIRY, 0);
      accessToken = await this.getAccessToken(sandboxName, accessTokenProvider);
    }
    return new SandboxClient({sandbox, accessToken, sendCommand});
  }
}
