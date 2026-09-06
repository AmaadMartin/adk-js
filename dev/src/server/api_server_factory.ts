/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  getArtifactServiceFromUri,
  getSessionServiceFromUri,
  Logger,
  LogLevel,
} from '@google/adk';
import dotenv from 'dotenv';
import {Application} from 'express';
import * as path from 'node:path';

import {AgentFileOptions, AgentLoader} from '../utils/agent_loader.js';
import {getAbsolutePath} from '../utils/file_utils.js';
import {createServerLogger} from '../utils/logger.js';
import {AdkApiServer} from './adk_api_server.js';
import {DevServer} from './dev_server.js';
import {TriggerVerifier} from './trigger_routes.js';

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 8000;
const IN_MEMORY_URI = 'memory://';

/** Configuration for {@link createApiServer} and {@link createApiServerApp}. */
export interface ApiServerOptions {
  /** Directory of agents, or a single agent file, to serve. */
  agentsDir: string;
  /** Serve the dev UI and the dev-only endpoints. */
  web: boolean;
  /** Loader for agent instances. Defaults to one reading `agentsDir`. */
  agentLoader?: AgentLoader;
  /** How the default loader compiles and bundles an agent file. */
  agentFileLoadOptions?: AgentFileOptions;
  /**
   * URI of the session service. Defaults to the `DATABASE_URL` environment
   * variable, then to `memory://`.
   */
  sessionServiceUri?: string;
  /** URI of the artifact service. Defaults to `memory://`. */
  artifactServiceUri?: string;
  /**
   * Session service to serve from, for a caller that built one itself. It
   * takes the place of {@link sessionServiceUri}.
   */
  sessionService?: BaseSessionService;
  /**
   * Artifact service to serve from, for a caller that built one itself. It
   * takes the place of {@link artifactServiceUri}.
   */
  artifactService?: BaseArtifactService;
  /** Memory service to serve from. Defaults to the in-memory one. */
  memoryService?: BaseMemoryService;
  /** Origin, or list of origins, CORS accepts. */
  allowOrigins?: string | string[];
  /**
   * Extra Host header values the DNS-rebinding guard accepts, for a server
   * bound to loopback behind a reverse proxy.
   */
  allowedHosts?: string[];
  /** Mount the A2A surface for every agent. Defaults to false. */
  a2a?: boolean;
  /**
   * Shared bearer token authenticating the A2A surface. Falls back to the
   * `ADK_A2A_AUTH_TOKEN` environment variable.
   */
  a2aAuthToken?: string;
  /**
   * Host the server binds to. It is also the address the DNS-rebinding guard
   * measures, and the host the A2A agent card advertises, so a caller behind
   * a proxy cannot advertise one address and bind another. Defaults to
   * `localhost`, which arms the guard.
   */
  host?: string;
  /** Port the server binds to. Defaults to 8000. */
  port?: number;
  /**
   * Export traces to Google Cloud Trace when `GOOGLE_CLOUD_PROJECT` is set.
   * Ignored when `otelToCloud` is already true.
   *
   * Two differences from adk-python: the project is read from
   * `<agentsDir>/.env` only, where adk-python walks up to the filesystem
   * root; and adk-js reaches Cloud Trace through `setupTelemetry`, which
   * exports Cloud metrics as well as traces.
   */
  traceToCloud?: boolean;
  /** Export OpenTelemetry traces and metrics to Google Cloud. */
  otelToCloud?: boolean;
  /** Watch the agent files and reload an agent that changes. */
  reloadAgents?: boolean;
  /**
   * Path the server is reached under when it sits behind a reverse proxy,
   * e.g. `/adk`. Routes stay at the root -- the proxy strips the prefix --
   * but redirects the server generates are built with it.
   */
  urlPrefix?: string;
  /**
   * Create the session named by a `/run` or `/run_sse` request when it does
   * not exist, instead of answering 404. Defaults to false.
   */
  autoCreateSession?: boolean;
  /**
   * Trigger sources to serve, from `VALID_TRIGGER_SOURCES`. Nothing is mounted
   * when this is omitted, and a mounted endpoint accepts UNAUTHENTICATED work
   * unless `triggerOidcAudience` or `triggerAuthVerifier` is also set.
   */
  triggerSources?: string[];
  /**
   * Audience the Google OIDC identity token on a trigger request must carry,
   * normally this service's public URL. Setting it turns on verification.
   */
  triggerOidcAudience?: string;
  /**
   * Service account addresses allowed to call the trigger endpoints. Requires
   * `triggerOidcAudience`.
   */
  triggerOidcServiceAccounts?: string[];
  /**
   * Verifies a trigger request in place of the built-in OIDC verifier. Throw
   * an `HttpError` from it to reject with a specific status.
   */
  triggerAuthVerifier?: TriggerVerifier;
  /**
   * Model used by an agent that declares none and has no ancestor that does.
   * Applied process-wide when the server starts.
   */
  defaultLlmModel?: string;
  /** Logger the server and the factory log through. */
  logger?: Logger;
  /** Level the logger reports at. Defaults to `LogLevel.INFO`. */
  logLevel?: LogLevel;
}

/**
 * Assembles an ADK API server from configuration: it resolves the session and
 * artifact services from their URIs and applies the defaults the `adk web`
 * and `adk api_server` commands use. A caller that builds its own services,
 * as the CLI does for local storage and for the memory bank, passes them
 * instead of their URIs.
 *
 * The returned server is not listening. Call `start()` to bind a port, or
 * `buildApp()` to serve the Express app yourself.
 */
export function createApiServer(options: ApiServerOptions): AdkApiServer {
  const agentsDir = getAbsolutePath(options.agentsDir);
  const logger = options.logger ?? createServerLogger();
  // The factory reports before the server constructor sets the level, so it
  // has to set the level itself or logLevel cannot suppress what it reports.
  logger.setLogLevel(options.logLevel ?? LogLevel.INFO);

  // `web` asks for the dev-only endpoint surface as well as the dev UI, and
  // those endpoints live on `DevServer`. `adk api_server` gets the plain
  // server, so the endpoints that write into the agents directory stay out of
  // a production deployment.
  const ServerClass = options.web ? DevServer : AdkApiServer;

  return new ServerClass({
    agentsDir,
    agentLoader: options.agentLoader,
    agentFileLoadOptions: options.agentFileLoadOptions,
    sessionService:
      options.sessionService ??
      getSessionServiceFromUri(
        options.sessionServiceUri || process.env.DATABASE_URL || IN_MEMORY_URI,
      ),
    artifactService:
      options.artifactService ??
      getArtifactServiceFromUri(options.artifactServiceUri || IN_MEMORY_URI),
    memoryService: options.memoryService,
    serveDebugUI: options.web,
    allowOrigins: options.allowOrigins,
    allowedHosts: options.allowedHosts,
    a2a: options.a2a ?? false,
    a2aAuthToken: options.a2aAuthToken,
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    otelToCloud: resolveOtelToCloud(options, agentsDir, logger),
    reloadAgents: options.reloadAgents ?? false,
    urlPrefix: options.urlPrefix,
    autoCreateSession: options.autoCreateSession,
    triggerSources: options.triggerSources,
    triggerOidcAudience: options.triggerOidcAudience,
    triggerOidcServiceAccounts: options.triggerOidcServiceAccounts,
    triggerAuthVerifier: options.triggerAuthVerifier,
    defaultLlmModel: options.defaultLlmModel,
    logger,
    logLevel: options.logLevel,
  });
}

/**
 * Builds an ADK API server and returns its initialised Express application,
 * ready to serve from a listener the caller creates. No port is bound.
 *
 * The A2A agent card advertises the configured `host` and `port`, so serve
 * the app on those.
 */
export function createApiServerApp(
  options: ApiServerOptions,
): Promise<Application> {
  return createApiServer(options).buildApp();
}

/**
 * Decides whether the server exports telemetry to Google Cloud. `otelToCloud`
 * answers on its own; `traceToCloud` answers yes only when a project is
 * configured, reading `<agentsDir>/.env` for one first.
 */
function resolveOtelToCloud(
  options: ApiServerOptions,
  agentsDir: string,
  logger: Logger,
): boolean {
  const otelToCloud = options.otelToCloud ?? false;
  if (otelToCloud || options.traceToCloud !== true) {
    return otelToCloud;
  }

  dotenv.config({path: path.join(agentsDir, '.env'), quiet: true});
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    return true;
  }

  logger.warn(
    'GOOGLE_CLOUD_PROJECT environment variable is not set. Tracing will not ' +
      'be enabled.',
  );
  return false;
}
