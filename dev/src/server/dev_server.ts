/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import express, {Request, Response} from 'express';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {isFileNotFoundError, isRecord} from '../utils/file_utils.js';
import {
  readTelemetryConsent,
  writeTelemetryConsent,
} from '../utils/telemetry_config.js';
import {AdkApiServer} from './adk_api_server.js';
import {getAgentGraphAsDot} from './agent_graph.js';

/** Separator between the parts of a nested app name, as in `parent.child`. */
const NESTED_APP_SEPARATOR = '.';

/** Directory under an agent directory that holds its recorded test files. */
const TESTS_DIR_NAME = 'tests';

const JSON_SUFFIX = '.json';

/** Header a caller must send to change the telemetry consent. */
const TELEMETRY_REQUEST_HEADER = 'x-adk-telemetry-request';

/**
 * The JS-identifier approximation of adk-python's `str.isidentifier()` check on
 * each part of an app name. The two character classes are not the same set:
 * Python accepts Unicode identifier characters that this rejects.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** An error carrying the HTTP status a route handler should answer with. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Resolves the directory of an app under the agents directory.
 *
 * The containment check is a `path.resolve` plus `path.relative` string
 * comparison. It rejects a name that lexically escapes the agents directory;
 * it is not a sandbox, and it does not survive a symlink inside that
 * directory pointing elsewhere.
 *
 * @param agentsDir The configured agents directory, if any.
 * @param appName The app name, whose dots separate nested directories.
 * @throws HttpError when the directory is unconfigured, the name is empty, a
 *   part of the name is not an identifier, or the result escapes `agentsDir`.
 */
export function resolveAgentDir(
  agentsDir: string | undefined,
  appName: string,
): string {
  if (!agentsDir) {
    throw new HttpError(500, 'Agents directory is not configured');
  }
  if (!appName) {
    throw new HttpError(400, 'App name cannot be empty');
  }

  for (const part of appName.split(NESTED_APP_SEPARATOR)) {
    if (!IDENTIFIER_PATTERN.test(part)) {
      throw new HttpError(
        400,
        `Invalid app name: "${appName}". App names must be valid identifiers ` +
          `or paths separated by dots.`,
      );
    }
  }

  const agentsBase = path.resolve(agentsDir);
  const resolved = path.resolve(
    agentsBase,
    ...appName.split(NESTED_APP_SEPARATOR),
  );

  // Redundant today, because no name that passes the identifier check above
  // can escape. adk-python keeps the same second check, and it is the guard
  // that still holds if the accepted name shape is ever widened.
  const relative = path.relative(agentsBase, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(
      400,
      `Access denied: "${appName}" is outside the agents directory`,
    );
  }

  return resolved;
}

/** Appends the `.json` suffix when the sanitised test name lacks it. */
function resolveTestFileName(testName: string): string {
  const base = path.basename(testName);

  return base.endsWith(JSON_SUFFIX) ? base : `${base}${JSON_SUFFIX}`;
}

/**
 * Rebuilds `value` with every object's keys in ascending order, so the written
 * file matches adk-python's `json.dump(..., sort_keys=True)`.
 */
function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withSortedKeys);
  }
  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = withSortedKeys(value[key]);
  }

  return sorted;
}

/** Lists the `.json` file names in a directory, or `[]` when it is absent. */
async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath);

    return entries.filter((name) => name.endsWith(JSON_SUFFIX)).sort();
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

/**
 * Development server that extends {@link AdkApiServer} with the endpoints the
 * dev UI needs.
 *
 * `adk web` runs this class; `adk api_server` runs the base class, so a
 * production deployment does not serve these routes. Like the base class,
 * every endpoint is unauthenticated: this server is for local development and
 * must not be exposed to an untrusted network.
 */
export class DevServer extends AdkApiServer {
  protected override registerDevEndpoints(app: express.Application): void {
    app.get('/config/telemetry', (req: Request, res: Response) => {
      res.json({telemetry: readTelemetryConsent() ?? null});
    });

    app.post(
      '/config/telemetry',
      this.handle('Failed to set telemetry consent', (req, res) => {
        if (req.headers[TELEMETRY_REQUEST_HEADER] !== 'true') {
          res
            .status(400)
            .json({error: 'Forbidden: missing required security header'});
          return;
        }

        const body: unknown = req.body;
        if (!isRecord(body) || typeof body['telemetry'] !== 'boolean') {
          res.status(400).json({error: 'Field "telemetry" must be a boolean'});
          return;
        }

        writeTelemetryConsent(body['telemetry']);
        res.json({telemetry: body['telemetry']});
      }),
    );

    app.get(
      '/dev/apps/:appName/tests',
      this.handle('Failed to list tests', async (req, res) => {
        res.json(await listJsonFiles(this.resolveTestsDir(req)));
      }),
    );

    app.put(
      '/dev/apps/:appName/tests/:testName',
      this.handle('Failed to create test', async (req, res) => {
        const body: unknown = req.body;
        const sessionData = isRecord(body) ? body['session_data'] : undefined;
        if (!isRecord(sessionData)) {
          res
            .status(400)
            .json({error: 'Field "session_data" must be an object'});
          return;
        }

        const testsDir = this.resolveTestsDir(req);
        const fileName = resolveTestFileName(req.params['testName']);
        await fs.mkdir(testsDir, {recursive: true});
        await fs.writeFile(
          path.join(testsDir, fileName),
          `${JSON.stringify(withSortedKeys(sessionData), null, 2)}\n`,
          'utf-8',
        );

        res.json({status: 'success', file: fileName});
      }),
    );

    app.get(
      '/dev/apps/:appName/tests/:testName',
      this.handle('Failed to get test content', async (req, res) => {
        const filePath = path.join(
          this.resolveTestsDir(req),
          resolveTestFileName(req.params['testName']),
        );

        let contents: string;
        try {
          contents = await fs.readFile(filePath, 'utf-8');
        } catch (error: unknown) {
          if (isFileNotFoundError(error)) {
            res.status(404).json({error: 'Test file not found'});
            return;
          }
          throw error;
        }

        const parsed: unknown = JSON.parse(contents);
        res.json(parsed);
      }),
    );

    app.delete(
      '/dev/apps/:appName/tests/:testName',
      this.handle('Failed to delete test', async (req, res) => {
        const filePath = path.join(
          this.resolveTestsDir(req),
          resolveTestFileName(req.params['testName']),
        );

        try {
          await fs.unlink(filePath);
        } catch (error: unknown) {
          if (isFileNotFoundError(error)) {
            res.status(404).json({error: 'Test file not found'});
            return;
          }
          throw error;
        }

        res.json({status: 'success'});
      }),
    );

    app.get(
      '/dev/apps/:appName/graph',
      this.handle('Failed to get app graph', async (req, res) => {
        const appName = req.params['appName'];
        const rootAgent = await this.loadRootTarget(appName);
        if (!rootAgent) {
          res.status(404).json({error: `App not found: ${appName}`});
          return;
        }

        const darkMode = String(req.query['dark_mode']) === 'true';
        res.json({dotSrc: await getAgentGraphAsDot(rootAgent, [], darkMode)});
      }),
    );
  }

  /** Resolves the tests directory of the app named in the request path. */
  private resolveTestsDir(req: Request): string {
    return path.join(
      resolveAgentDir(this.agentsDir, req.params['appName']),
      TESTS_DIR_NAME,
    );
  }

  /**
   * Wraps a route handler so a thrown {@link HttpError} becomes its own status
   * and every other failure becomes a logged 500.
   */
  private handle(
    context: string,
    handler: (req: Request, res: Response) => void | Promise<void>,
  ): (req: Request, res: Response) => Promise<void> {
    return async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch (error: unknown) {
        // `HttpError` is module-private and thrown only by `resolveAgentDir`
        // below, so the class identity here is always this module's own.
        if (error instanceof HttpError) {
          res.status(error.status).json({error: error.message});
          return;
        }

        const message = `${context}: ${error}`;
        this.logger.error(message);
        res.status(500).json({error: message});
      }
    };
  }
}
