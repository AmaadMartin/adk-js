/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
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
  /** Logger the server and the factory log through. */
  logger?: Logger;
  /** Level the logger reports at. Defaults to `LogLevel.INFO`. */
  logLevel?: LogLevel;
}

/**
 * Assembles an ADK API server from configuration: it resolves the session and
 * artifact services from their URIs and applies the defaults the `adk web`
 * and `adk api_server` commands use. The server supplies the in-memory
 * memory service, which is the only one adk-js has.
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

  return new AdkApiServer({
    agentsDir,
    agentLoader: options.agentLoader,
    agentFileLoadOptions: options.agentFileLoadOptions,
    sessionService: getSessionServiceFromUri(
      options.sessionServiceUri || process.env.DATABASE_URL || IN_MEMORY_URI,
    ),
    artifactService: getArtifactServiceFromUri(
      options.artifactServiceUri || IN_MEMORY_URI,
    ),
    serveDebugUI: options.web,
    allowOrigins: options.allowOrigins,
    allowedHosts: options.allowedHosts,
    a2a: options.a2a ?? false,
    a2aAuthToken: options.a2aAuthToken,
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    otelToCloud: resolveOtelToCloud(options, agentsDir, logger),
    reloadAgents: options.reloadAgents ?? false,
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
