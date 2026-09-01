/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Everything `adk run` needs before it can run a turn: the loaded agent, the
 * agent's environment, and the services the runner talks to.
 */
import {
  App,
  BaseAgent,
  BaseArtifactService,
  BaseCredentialService,
  BaseMemoryService,
  BaseSessionService,
  getArtifactServiceFromUri,
  getSessionServiceFromUri,
  InMemoryArtifactService,
  InMemoryCredentialService,
  InMemoryMemoryService,
  InMemorySessionService,
  isApp,
  isLlmAgent,
  RunnableRoot,
  VertexAiMemoryBankService,
} from '@google/adk';
import dotenv from 'dotenv';
import * as path from 'node:path';
import {AgentFile, AgentFileOptions} from '../utils/agent_loader.js';
import {isEnvEnabled} from '../utils/env_utils.js';
import {getAbsolutePath, isFileExists} from '../utils/file_utils.js';
import {AdkLogger} from '../utils/logger.js';
import {
  createLocalArtifactService,
  createLocalSessionService,
  resolveUseLocalStorage,
} from './local_storage.js';

const logger = new AdkLogger({label: 'RunContext'});

const DISABLE_LOAD_DOTENV_ENV = 'ADK_DISABLE_LOAD_DOTENV';
const DOTENV_FILE = '.env';
const IN_MEMORY_URI = 'memory://';
const AGENT_ENGINE_SCHEME = 'agentengine://';

/** The user a CLI run acts as, matching adk-python. */
export const CLI_USER_ID = 'test_user';

/** Options for {@link createRunContext}. */
export interface RunContextOptions {
  agentPath: string;

  /** Whether to keep everything in memory and persist nothing. */
  inMemory?: boolean;
  sessionServiceUri?: string;
  artifactServiceUri?: string;
  memoryServiceUri?: string;

  /** Whether to persist under the agent's `.adk` folder. Defaults to true. */
  useLocalStorage?: boolean;

  /** The model an agent that declares none is given. */
  defaultLlmModel?: string;
  agentFileLoadOptions?: AgentFileOptions;

  /** A session service to use instead of building one from the options. */
  sessionService?: BaseSessionService;

  /** An artifact service to use instead of building one from the options. */
  artifactService?: BaseArtifactService;

  /** A memory service to use instead of building one from the options. */
  memoryService?: BaseMemoryService;

  /** A credential service to use instead of the in-memory one. */
  credentialService?: BaseCredentialService;
}

/** The loaded agent and the services a run needs. */
export interface RunContext {
  /** The loaded agent file. The caller disposes it. */
  agentFile: AgentFile;
  rootAgent: RunnableRoot;
  app?: App;
  appName: string;
  userId: string;

  /** The directory holding the agent file, which roots `.env` and `.adk`. */
  agentDir: string;
  sessionService: BaseSessionService;
  artifactService: BaseArtifactService;
  memoryService: BaseMemoryService;
  credentialService: BaseCredentialService;
}

/** The scheme of a URI, for a message that must not repeat its credentials. */
function schemeOf(uri: string): string {
  const separator = uri.indexOf('://');
  return separator === -1 ? '<scheme-missing>' : uri.slice(0, separator);
}

/**
 * Builds the memory service a URI names.
 *
 * There is no memory registry in core, so the two schemes adk-python supports
 * are mapped here.
 */
function createMemoryServiceFromUri(uri: string): BaseMemoryService {
  if (uri.startsWith(IN_MEMORY_URI)) {
    return new InMemoryMemoryService();
  }

  if (uri.startsWith(AGENT_ENGINE_SCHEME)) {
    // Both a bare id and a full `projects/.../reasoningEngines/<id>` resource
    // name are accepted, as adk-python does.
    const agentEngineId = uri
      .slice(AGENT_ENGINE_SCHEME.length)
      .split('/')
      .pop();
    if (!agentEngineId) {
      throw new Error('Missing agent engine id in the memory service URI.');
    }
    return new VertexAiMemoryBankService({agentEngineId});
  }

  throw new Error(`Unsupported memory service URI scheme: ${schemeOf(uri)}`);
}

/**
 * Gives the default model to every agent that would otherwise have none.
 *
 * An agent under a parent that declares a model already inherits one through
 * `canonicalModel`, so it is left alone.
 */
function applyDefaultLlmModel(
  node: RunnableRoot | BaseAgent,
  defaultLlmModel: string,
  inheritsModel: boolean,
): void {
  let childrenInherit = inheritsModel;

  if (isLlmAgent(node)) {
    if (node.model) {
      childrenInherit = true;
    } else if (!inheritsModel) {
      logger.debug(`Defaulting ${node.name} to model ${defaultLlmModel}.`);
      node.model = defaultLlmModel;
      childrenInherit = true;
    }
  }

  const subAgents = 'subAgents' in node ? node.subAgents : [];
  for (const subAgent of subAgents) {
    applyDefaultLlmModel(subAgent, defaultLlmModel, childrenInherit);
  }
}

/** The nearest `.env` at or above `startDir`, if there is one. */
async function findDotenvFile(startDir: string): Promise<string | undefined> {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, DOTENV_FILE);
    if (await isFileExists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Applies the agent's `.env`, keeping what the real environment already said.
 *
 * The file overrides values an earlier `.env` set, but a variable the user
 * exported before the run wins over both, so `FOO=x adk run ...` behaves as the
 * user expects.
 */
async function loadAgentDotenv(agentDir: string): Promise<void> {
  if (isEnvEnabled(DISABLE_LOAD_DOTENV_ENV)) {
    logger.debug(
      `Skipping ${DOTENV_FILE} loading because ${DISABLE_LOAD_DOTENV_ENV} is enabled.`,
    );
    return;
  }

  const dotenvPath = await findDotenvFile(agentDir);
  if (!dotenvPath) {
    logger.debug(`No ${DOTENV_FILE} file found for ${agentDir}.`);
    return;
  }

  const explicitEnv = {...process.env};
  dotenv.config({path: dotenvPath, override: true, quiet: true});
  Object.assign(process.env, explicitEnv);
  logger.debug(`Loaded ${dotenvPath} for ${agentDir}.`);
}

async function createSessionService(
  uri: string | undefined,
  agentDir: string,
  useLocalStorage: boolean,
): Promise<BaseSessionService> {
  if (uri) {
    return getSessionServiceFromUri(uri);
  }
  return useLocalStorage
    ? createLocalSessionService(agentDir)
    : new InMemorySessionService();
}

async function createArtifactService(
  uri: string | undefined,
  agentDir: string,
  useLocalStorage: boolean,
): Promise<BaseArtifactService> {
  if (uri) {
    return getArtifactServiceFromUri(uri);
  }
  return useLocalStorage
    ? createLocalArtifactService(agentDir)
    : new InMemoryArtifactService();
}

/**
 * Loads the agent and builds the services `adk run` needs.
 *
 * The agent's `.env` is applied before any service is built, so a service URI
 * or credential the file supplies is in place by the time it is read.
 *
 * @return The context. Its `agentFile` belongs to the caller, which must
 *     dispose it.
 */
export async function createRunContext(
  options: RunContextOptions,
): Promise<RunContext> {
  const agentPath = getAbsolutePath(options.agentPath);
  const agentDir = path.dirname(agentPath);
  const agentFile = new AgentFile(agentPath, options.agentFileLoadOptions);

  try {
    const loaded = await agentFile.load();
    const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;
    const app = isApp(loaded) ? loaded : undefined;

    if (options.defaultLlmModel) {
      applyDefaultLlmModel(rootAgent, options.defaultLlmModel, false);
    }

    await loadAgentDotenv(agentDir);

    const inMemory = options.inMemory ?? false;
    const sessionServiceUri = inMemory
      ? IN_MEMORY_URI
      : options.sessionServiceUri;
    const artifactServiceUri = inMemory
      ? IN_MEMORY_URI
      : options.artifactServiceUri;
    const memoryServiceUri = inMemory
      ? IN_MEMORY_URI
      : options.memoryServiceUri;

    let useLocalStorage = false;
    // Local storage only decides what an unset service URI falls back to, so
    // asking about it when both are set would warn about nothing.
    if (!inMemory && !(sessionServiceUri && artifactServiceUri)) {
      const decision = await resolveUseLocalStorage(
        agentDir,
        options.useLocalStorage ?? true,
      );
      useLocalStorage = decision.useLocalStorage;
      if (decision.warning) {
        logger.warn(decision.warning);
      }
    }

    return {
      agentFile,
      rootAgent,
      app,
      appName: app?.name ?? rootAgent.name,
      userId: CLI_USER_ID,
      agentDir,
      sessionService:
        options.sessionService ??
        (await createSessionService(
          sessionServiceUri,
          agentDir,
          useLocalStorage,
        )),
      artifactService:
        options.artifactService ??
        (await createArtifactService(
          artifactServiceUri,
          agentDir,
          useLocalStorage,
        )),
      memoryService:
        options.memoryService ??
        (memoryServiceUri
          ? createMemoryServiceFromUri(memoryServiceUri)
          : new InMemoryMemoryService()),
      credentialService:
        options.credentialService ?? new InMemoryCredentialService(),
    };
  } catch (error: unknown) {
    await agentFile.dispose();
    throw error;
  }
}
