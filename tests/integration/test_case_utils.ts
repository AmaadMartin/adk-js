/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '@google/adk';
import {
  BaseAgent,
  BasePlugin,
  Gemini,
  InMemoryRunner,
  isLlmAgent,
} from '@google/adk';
import type {Candidate, UsageMetadata} from '@google/genai';
import {
  createUserContent,
  GenerateContentResponse,
  GoogleGenAI,
} from '@google/genai';
import {ChildProcessWithoutNullStreams} from 'node:child_process';
import * as net from 'node:net';
import {expect} from 'vitest';

/**
 * Represents a raw generate content response.
 */
export interface RawGenerateContentResponse {
  candidates?: Candidate[];
  usageMetadata?: UsageMetadata;
}

/**
 * Represents a turn in a test case.
 */
export interface TestCaseTurn {
  userPrompt: string;
  expectedEvents: Event[];
}

/**
 * Represents a test case for an agent.
 */
export interface TestCase {
  agent: BaseAgent;
  turns: TestCaseTurn[];
  modelResponses?: RawGenerateContentResponse[];
}

function toGenerateContentResponse(
  raw: RawGenerateContentResponse,
): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.candidates = raw.candidates;
  response.usageMetadata = raw.usageMetadata;

  return response;
}

/**
 * Helper function to advance time / allow microtasks and clocks to tick in tests.
 */
export async function tick(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

class MockModels {
  private responseIndex = 0;
  private readonly responses: GenerateContentResponse[];

  constructor(responses: GenerateContentResponse[]) {
    this.responses = responses;
  }

  async generateContent(_req: unknown): Promise<GenerateContentResponse> {
    await tick();
    return this.getNextResponse();
  }

  async generateContentStream(
    _req: unknown,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    await tick();
    const response = this.getNextResponse();
    // Use an IIFE to create the async generator
    return (async function* () {
      yield response;
    })();
  }

  private getNextResponse(): GenerateContentResponse {
    if (this.responseIndex >= this.responses.length) {
      throw new Error(
        `No more recorded responses available. Requested ${
          this.responseIndex + 1
        }, but only have ${this.responses.length}.`,
      );
    }
    return this.responses[this.responseIndex++];
  }
}

class MockGenAIClient {
  public models: MockModels;
  public vertexai = false;

  constructor(responses: GenerateContentResponse[]) {
    this.models = new MockModels(responses);
  }
}

/**
 * A mock implementation of Gemini that returns predefined responses.
 */
export class GeminiWithMockResponses extends Gemini {
  private readonly _mockClient: MockGenAIClient;

  constructor(responses: RawGenerateContentResponse[]) {
    super({apiKey: 'test-key'});
    this._mockClient = new MockGenAIClient(
      responses.map(toGenerateContentResponse),
    );
  }

  override get apiClient(): GoogleGenAI {
    return this._mockClient as unknown as GoogleGenAI;
  }
}

/**
 * Creates a runner for the given agent.
 * @param agent The agent to create a runner for.
 * @returns A runner for the given agent.
 */
export async function createRunner(
  agent: BaseAgent,
  plugins: BasePlugin[] = [],
) {
  const userId = 'test_user';
  const appName = agent.name;
  const runner = new InMemoryRunner({agent: agent, appName, plugins});
  const session = await runner.sessionService.createSession({
    appName,
    userId,
  });

  return {
    run(prompt: string): AsyncGenerator<Event, void, undefined> {
      return runner.runAsync({
        userId,
        sessionId: session.id,
        newMessage: createUserContent(prompt),
      });
    },
  };
}

const ADK_EVENT_ID_REGEX = /^[a-zA-Z0-9]{8}$/;
const INVOCATION_ID_REGEX =
  /^e-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const IGNORE_FIELDS = [
  'id',
  'invocationId',
  'timestamp',
  'customMetadata.a2a:response.taskId',
  'customMetadata.a2a:response.contextId',
  'customMetadata.a2a:response.artifact.artifactId',
  'customMetadata.a2a:response.metadata.adk_invocation_id',
  'customMetadata.a2a:response.metadata.adk_session_id',
  'customMetadata.a2a:response.metadata.adk_user_id',
];

/**
 * Deletes fields from an object based on dot-separated paths.
 * @param obj The object to modify.
 * @param paths The paths of the fields to delete (e.g., 'a.b.c').
 */
export function deleteFields(obj: Record<string, unknown>, paths: string[]) {
  if (!obj || typeof obj !== 'object') return;

  for (const path of paths) {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current || typeof current !== 'object') {
        break;
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    const lastPart = parts[parts.length - 1];
    if (current && typeof current === 'object' && lastPart in current) {
      delete current[lastPart];
    }
  }
}

/**
 * Recursively normalizes CRLF (\r\n) to LF (\n) in all string properties of an object.
 */
export function normalizeLineEndings(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\r\n/g, '\n');
  }
  if (Array.isArray(obj)) {
    return obj.map(normalizeLineEndings);
  }
  if (obj !== null && typeof obj === 'object') {
    const normalizedObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      normalizedObj[key] = normalizeLineEndings(value);
    }
    return normalizedObj;
  }
  return obj;
}

/**
 * Runs the given test case.
 * @param testCase The test case to run.
 */
export async function runTestCase(testCase: TestCase) {
  if (isLlmAgent(testCase.agent)) {
    testCase.agent.model = new GeminiWithMockResponses(
      testCase.modelResponses ?? [],
    );
  }
  const runner = await createRunner(testCase.agent);

  for (const turn of testCase.turns) {
    let eventIndex = 0;

    for await (const event of runner.run(turn.userPrompt)) {
      expect(eventIndex < turn.expectedEvents.length).toBe(true);

      const expectedEvent = turn.expectedEvents[eventIndex];

      // Validate random fields.
      expect(event.id).toMatch(ADK_EVENT_ID_REGEX);
      expect(event.invocationId).toMatch(INVOCATION_ID_REGEX);
      expect(event.timestamp).toBeGreaterThan(0);

      // Prune random fields from expected event.
      deleteFields(
        expectedEvent as unknown as Record<string, unknown>,
        IGNORE_FIELDS,
      );

      const normalizedActual = normalizeLineEndings(event);
      const normalizedExpected = normalizeLineEndings(expectedEvent);

      expect(normalizedActual).toMatchObject(
        normalizedExpected as Record<string, unknown>,
      );

      eventIndex++;
    }
  }
}

/** Cap on captured child output per stream, in bytes. */
export const MAX_CAPTURED_OUTPUT_BYTES = 16384;

/** Matches the loopback URL a test server prints in its start-up banner. */
const SERVER_URL_REGEX = /http:\/\/localhost:([0-9]+)/i;

/** The signal that terminated a child, sourced from Node's own typing. */
type TerminationSignal = ChildProcessWithoutNullStreams['signalCode'];

/** Options for {@link waitForProcessStart}. */
export interface WaitForProcessStartOptions {
  childProcess: ChildProcessWithoutNullStreams;
  startMessage: string;
  serverName: string;
  timeoutMs: number;
}

/**
 * Appends `chunk` to `captured`, keeping only its trailing
 * {@link MAX_CAPTURED_OUTPUT_BYTES} bytes. A child that dies noisily can write
 * far more than is useful, and the bytes it wrote last are the ones that
 * explain why.
 */
function appendBounded(captured: Buffer, chunk: Buffer): Buffer {
  return Buffer.concat([captured, chunk]).subarray(-MAX_CAPTURED_OUTPUT_BYTES);
}

function formatCapturedStream(
  serverName: string,
  label: string,
  output: Buffer,
): string {
  const body = output.length > 0 ? output.toString() : '(no output captured)';
  return `\n--- ${serverName} ${label} ---\n${body}`;
}

/**
 * Renders both captured streams, labelled with the server they came from so
 * they stay readable in a CI log that interleaves several vitest projects.
 */
function formatCapture(
  serverName: string,
  stdout: Buffer,
  stderr: Buffer,
): string {
  return (
    formatCapturedStream(serverName, 'stdout', stdout) +
    formatCapturedStream(serverName, 'stderr', stderr)
  );
}

/**
 * Resolves with everything the child wrote to stdout once `startMessage`
 * appears there.
 *
 * Rejects if the child closes first, fails to spawn, or does not signal
 * readiness within `timeoutMs` — in every case with the child's captured
 * stdout and stderr in the message, since the reason a server refused to start
 * only ever exists in its own output. Both streams are captured because the
 * ADK CLI logs its start-up failures to stdout, not stderr.
 */
export function waitForProcessStart({
  childProcess,
  startMessage,
  serverName,
  timeoutMs,
}: WaitForProcessStartOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);

    const settle = (finish: () => void) => {
      clearTimeout(timer);
      childProcess.stdout.off('data', onStdout);
      childProcess.stderr.off('data', onStderr);
      childProcess.off('error', onError);
      childProcess.off('close', onClose);
      finish();
      // Detaching the handlers leaves both streams in flowing mode, so a
      // healthy long-lived server keeps draining instead of blocking on a full
      // pipe, while its output stops being retained.
      stdout = Buffer.alloc(0);
      stderr = Buffer.alloc(0);
    };

    const onStdout = (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
      if (stdout.includes(startMessage)) {
        settle(() => resolve(stdout.toString()));
      }
    };

    const onStderr = (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    };

    const onError = (error: Error) => {
      settle(() =>
        reject(
          new Error(
            `Failed to start ${serverName.toLowerCase()}: ${error.message}` +
              formatCapture(serverName, stdout, stderr),
          ),
        ),
      );
    };

    // 'close' rather than 'exit': it fires only once the child's stdio has
    // been drained, so its last words are already captured. The two events
    // have no guaranteed order relative to each other.
    const onClose = (code: number | null, signal: TerminationSignal) => {
      settle(() =>
        reject(
          new Error(
            `${serverName} exited prematurely with code ${code} ` +
              `(signal: ${signal ?? 'none'}).` +
              formatCapture(serverName, stdout, stderr),
          ),
        ),
      );
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `Timeout waiting for ${serverName.toLowerCase()} to start.` +
              formatCapture(serverName, stdout, stderr),
          ),
        ),
      );
    }, timeoutMs);

    childProcess.stdout.on('data', onStdout);
    childProcess.stderr.on('data', onStderr);
    childProcess.on('error', onError);
    childProcess.on('close', onClose);
  });
}

/**
 * Returns a port the OS has just confirmed is bindable on `host`, by listening
 * on port 0 and releasing it again.
 *
 * This narrows the bind race rather than eliminating it: another process can
 * still claim the port between the release here and the child's bind. Its real
 * value is that the OS will not hand the same ephemeral port to two
 * concurrently-starting vitest workers, which a shared random range can.
 */
export async function getFreePort(host = 'localhost'): Promise<number> {
  const server = net.createServer();

  try {
    return await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen({host, port: 0}, () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(
            new Error(`Expected a TCP address on ${host}, got ${address}`),
          );
          return;
        }
        resolve(address.port);
      });
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Base class for test servers.
 */
export abstract class BaseTestServer {
  host: string;
  port: number;
  url: string;
  protected serverProcess?: ChildProcessWithoutNullStreams;

  constructor(host: string, port?: number) {
    this.host = host;
    this.port = port ?? 0;
    this.url = `http://${this.host}:${this.port}`;
  }

  protected async startProcess({
    spawnProcess,
    startMessage,
    successLogMessage,
    serverName,
    timeoutMs,
  }: {
    spawnProcess: () => ChildProcessWithoutNullStreams;
    startMessage: string;
    successLogMessage: string;
    serverName: string;
    timeoutMs: number;
  }): Promise<void> {
    // Subclasses read `this.port` inside `spawnProcess` — for `--port` and for
    // TEST_API_SERVER_PORT — so it has to be concrete before the child spawns.
    if (this.port === 0) {
      this.port = await getFreePort(this.host);
      this.url = `http://${this.host}:${this.port}`;
    }

    const serverProcess = spawnProcess();
    this.serverProcess = serverProcess;

    // Outlives the start handshake: an 'error' event with no listener is
    // thrown by EventEmitter, and the exit of a server that started fine is
    // still worth reporting.
    serverProcess.on('error', (error) => {
      console.error(`${serverName} Error: ${error.message}`);
    });
    serverProcess.on('exit', (code) => {
      console.error(`${serverName} exited with code ${code}`);
    });

    const stdout = await waitForProcessStart({
      childProcess: serverProcess,
      startMessage,
      serverName,
      timeoutMs,
    });

    const urlMatch = stdout.match(SERVER_URL_REGEX);
    if (urlMatch) {
      const parsedPort = parseInt(urlMatch[1], 10);
      if (parsedPort > 0) {
        this.port = parsedPort;
        this.url = `http://${this.host}:${this.port}`;
      }
    }

    console.log(successLogMessage);
  }

  async stop(): Promise<void> {
    if (this.serverProcess) {
      this.serverProcess.kill('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

export function sendInput(
  childProcess: ChildProcessWithoutNullStreams,
  input: string,
): Promise<string> {
  childProcess.stdin.write(input);
  childProcess.stdin.end();

  return getResponse(childProcess);
}

export function getResponse(
  childProcess: ChildProcessWithoutNullStreams,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let output = '';
    let resolved = false;

    const onFinish = () => {
      if (!resolved) {
        resolve(output);
      }

      childProcess.stdout.off('data', onData);
      resolved = true;
    };

    const onData = (data: Buffer) => {
      output += data.toString();
    };

    childProcess.stdout.on('data', onData);
    childProcess.stdout.once('end', onFinish);
    childProcess.stdout.once('close', onFinish);
  });
}
