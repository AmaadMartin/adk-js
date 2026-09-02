/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The scriptable half of `adk run`: one query, one exit code, no prompts.
 */
import {
  getPendingUserInputRequests,
  requiresUserInput,
  Runner,
  Session,
} from '@google/adk';
import {Content} from '@google/genai';
import {parseDuration} from '../utils/duration_utils.js';
import {toErrorMessage} from '../utils/error_utils.js';
import {getAbsolutePath, loadFileData} from '../utils/file_utils.js';
import {parseStateOption} from '../utils/json_utils.js';
import {runWithTimeout} from '../utils/timeout_utils.js';
import {printEvent} from './event_printer.js';
import {buildInterruptResponse} from './hitl_response.js';
import {withJsonlStdout} from './jsonl_stdout.js';
import {
  createRunContext,
  RunContext,
  RunContextOptions,
} from './run_context.js';

/** Exit codes, matching adk-python's `run_once_cli`. */
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_PAUSED = 2;

const BANNER_RULE = '='.repeat(60);

/** A `--replay` file: the state to start from and the queries to run. */
interface InputFile {
  state: Record<string, unknown>;
  queries: string[];
}

/** Options for {@link runAgentOnce}. */
export interface RunAgentOnceOptions extends RunContextOptions {
  /** The message to send. An empty query reads the message from stdin. */
  query?: string;

  /** A json file of queries to run instead of a single query. */
  replay?: string;

  /** The session to run in. A new one is created when it does not exist. */
  sessionId?: string;

  /** Initial session state, as a JSON object. */
  state?: string;

  /** Budget for one query, e.g. `30s` or `5m`. */
  timeout?: string;

  /** Whether to write one JSON line per event instead of readable text. */
  jsonl?: boolean;
}

/** Reads the whole of stdin, which is where a piped query arrives. */
async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    chunks.push(String(chunk));
  }
  return chunks.join('').trim();
}

/** Tells the user how to answer the pause, and which session to answer it in. */
function printPauseBanner(sessionId: string): void {
  console.error(
    `\n${BANNER_RULE}\n` +
      '[PAUSED] Workflow is waiting for human input!\n\n' +
      'To resume, run the command again with:\n' +
      `  --session_id ${sessionId}\n` +
      'And provide your input as the query.\n' +
      `${BANNER_RULE}\n`,
  );
}

/**
 * Runs one query and reports whether it left the agent waiting on a human.
 *
 * A query typed against a session that is already paused answers that pause
 * rather than starting a new turn, so a script resumes by re-running the
 * command with the session id.
 */
async function executeQuery(
  runner: Runner,
  session: Session,
  query: string,
  jsonl: boolean,
  abortSignal: AbortSignal,
): Promise<boolean> {
  // A request a later function response already answered is not pending, so a
  // query sent to a resolved session stays an ordinary message.
  const pendingRequest = getPendingUserInputRequests(session.events)[0];
  if (pendingRequest && !jsonl) {
    console.error(
      `Auto-resuming interrupt ${pendingRequest.interruptId} with input: ${query}`,
    );
  }

  const newMessage: Content = pendingRequest
    ? {role: 'user', parts: [buildInterruptResponse(pendingRequest, query)]}
    : {role: 'user', parts: [{text: query}]};

  let paused = false;
  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage,
    abortSignal,
  })) {
    printEvent(event, {jsonl, sessionId: session.id});
    paused = paused || requiresUserInput(event);
  }

  if (paused && !jsonl) {
    printPauseBanner(session.id);
  }
  return paused;
}

/** Creates the session a `--replay` file describes, and reads its queries. */
async function planReplay(
  context: RunContext,
  replay: string,
  sessionId: string | undefined,
): Promise<{session: Session; queries: string[]}> {
  const inputFile = await loadFileData<InputFile>(getAbsolutePath(replay));
  if (!inputFile) {
    throw new Error(`Failed to read the --replay file ${replay}.`);
  }

  const session = await context.sessionService.createSession({
    appName: context.appName,
    userId: context.userId,
    state: inputFile.state,
    sessionId,
  });
  return {session, queries: inputFile.queries};
}

async function runPlan(
  context: RunContext,
  options: RunAgentOnceOptions,
): Promise<number> {
  if (options.query && options.replay) {
    console.error('Error: Cannot provide both query and --replay.');
    return EXIT_ERROR;
  }

  const jsonl = options.jsonl ?? false;
  let exitCode = EXIT_OK;

  try {
    let session: Session;
    let queries: string[];
    if (options.replay) {
      ({session, queries} = await planReplay(
        context,
        options.replay,
        options.sessionId,
      ));
    } else {
      // An empty query argument reads the message from a pipe instead.
      const query =
        options.query || (process.stdin.isTTY ? undefined : await readStdin());
      if (!query) {
        console.error('Error: Missing query argument or stdin input.');
        return EXIT_ERROR;
      }
      session = await context.sessionService.getOrCreateSession({
        appName: context.appName,
        userId: context.userId,
        sessionId: options.sessionId,
        state: parseStateOption(options.state),
      });
      queries = [query];
    }

    if (!jsonl) {
      console.error(`Session ID: ${session.id}`);
    }

    const runner = new Runner({
      app: context.app,
      appName: context.appName,
      agent: context.rootAgent,
      artifactService: context.artifactService,
      sessionService: context.sessionService,
      memoryService: context.memoryService,
      credentialService: context.credentialService,
    });

    const timeoutMs = options.timeout
      ? parseDuration(options.timeout)
      : undefined;

    for (const query of queries) {
      const timedOut = await runWithTimeout(timeoutMs, async (abortSignal) => {
        const paused = await executeQuery(
          runner,
          session,
          query,
          jsonl,
          abortSignal,
        );
        exitCode = paused ? EXIT_PAUSED : exitCode;
      });

      if (timedOut) {
        console.error(`Error: Command timed out after ${options.timeout}`);
        return EXIT_ERROR;
      }
    }
  } catch (error: unknown) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return EXIT_ERROR;
  }

  return exitCode;
}

/**
 * Runs an agent once and returns the exit code the process should use.
 *
 * @return 0 when the run finished, 2 when it paused for a human, and 1 for a
 *     usage error, a timeout, or a failed run.
 */
export async function runAgentOnce(
  options: RunAgentOnceOptions,
): Promise<number> {
  const run = async (): Promise<number> => {
    const context = await createRunContext(options);
    try {
      return await runPlan(context, options);
    } finally {
      await context.agentFile.dispose();
    }
  };

  return options.jsonl ? withJsonlStdout(run) : run();
}
