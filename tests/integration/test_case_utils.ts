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
import {once} from 'node:events';
import {createServer} from 'node:net';
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

/** Maximum characters retained from each captured stream in a failure. */
const OUTPUT_EXCERPT_CHARS = 4000;

/** How long `stop()` waits for a clean exit before escalating to SIGKILL. */
const PROCESS_EXIT_TIMEOUT_MS = 5000;

/**
 * Returns a TCP port on `host` that the OS has just confirmed is free, by
 * binding port 0, reading the assignment back and releasing it.
 *
 * Guessing a port instead is what makes a spawned server die at start-up with
 * exit code 1: the guess can already be held by another concurrently-starting
 * test worker drawing from the same range, or fall inside one of the TCP ranges
 * Windows reserves for Hyper-V/WinNAT, and a failed bind is fatal to the child.
 */
export async function reserveFreePort(host: string): Promise<number> {
  const probe = createServer();

  try {
    const listening = once(probe, 'listening');
    probe.listen({host, port: 0});
    await listening;

    const address = probe.address();
    // `address()` is typed `AddressInfo | string | null`; the string form is
    // for IPC servers, which this never is.
    if (address === null || typeof address === 'string') {
      throw new Error(`Expected a TCP address on ${host}, got ${address}`);
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}

/**
 * Keeps only the last {@link OUTPUT_EXCERPT_CHARS} characters of a captured
 * stream: a child that dies noisily writes far more than is useful, and the
 * bytes it wrote last are the ones explaining why.
 */
function excerpt(output: string): string {
  return output.slice(-OUTPUT_EXCERPT_CHARS) || '(no output captured)';
}

function formatCapturedOutput(stdout: string, stderr: string): string {
  return `\nstdout:\n${excerpt(stdout)}\nstderr:\n${excerpt(stderr)}`;
}

/**
 * Base class for test servers.
 */
export abstract class BaseTestServer {
  host: string;
  port: number;
  protected serverProcess?: ChildProcessWithoutNullStreams;

  constructor(host: string, port?: number) {
    this.host = host;
    // 0 means "allocate at start"; `startProcess` resolves it before spawning.
    this.port = port ?? 0;
  }

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  protected async startProcess({
    spawnProcess,
    startMessage,
    serverName,
    timeoutMs,
  }: {
    spawnProcess: () => ChildProcessWithoutNullStreams;
    startMessage: string;
    serverName: string;
    timeoutMs: number;
  }): Promise<void> {
    // Both subclasses read `this.port` from inside `spawnProcess` -- for
    // `--port` and for TEST_API_SERVER_PORT -- so it has to be a real port
    // before the child starts, not after its banner is parsed.
    if (!this.port) {
      this.port = await reserveFreePort(this.host);
    }

    const child = spawnProcess();
    this.serverProcess = child;

    // Outlive the handshake: an 'error' event with no listener is rethrown by
    // EventEmitter, and a server that dies mid-test is still worth reporting.
    child.on('error', (error: Error) => {
      console.error(`${serverName} Error: ${error.message}`);
    });
    // 'exit' rather than 'close': a child that leaves a grandchild holding the
    // inherited stdio pipes never emits 'close'.
    child.on('exit', (code: number | null) => {
      console.error(`${serverName} exited with code ${code}`);
    });

    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      // Gates retention only. The 'data' listeners stay attached for the life
      // of the child so its pipes keep draining; a chatty server that filled
      // the 64 KB pipe buffer would otherwise block.
      let capturing = true;

      const settle = (error?: Error) => {
        clearTimeout(timer);
        capturing = false;
        child.off('error', onError);
        child.off('close', onClose);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const onStdout = (data: Buffer) => {
        if (!capturing) return;
        stdout += data.toString();

        // Matched against the accumulated output, not this chunk: a banner
        // split across two writes must still complete the handshake.
        if (stdout.includes(startMessage)) {
          settle();
        }
      };

      const onStderr = (data: Buffer) => {
        if (!capturing) return;
        stderr += data.toString();
      };

      const onError = (error: Error) => {
        settle(
          new Error(
            `Failed to start ${serverName.toLowerCase()}: ${error.message}` +
              formatCapturedOutput(stdout, stderr),
          ),
        );
      };

      // 'close' rather than 'exit': it fires only once the stdio pipes have
      // been drained, so the child's last words -- the actual reason it refused
      // to start -- are already captured when the error is built.
      const onClose = (
        code: number | null,
        signal: ChildProcessWithoutNullStreams['signalCode'],
      ) => {
        settle(
          new Error(
            `${serverName} exited prematurely with code ${code}` +
              (signal ? ` (signal ${signal})` : '') +
              formatCapturedOutput(stdout, stderr),
          ),
        );
      };

      const timer = setTimeout(() => {
        settle(
          new Error(
            `Timeout waiting for ${serverName.toLowerCase()} to start.` +
              formatCapturedOutput(stdout, stderr),
          ),
        );
      }, timeoutMs);

      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      child.on('error', onError);
      child.on('close', onClose);
    });

    console.log(`${serverName} started at ${this.url}`);
  }

  async stop(): Promise<void> {
    const child = this.serverProcess;
    if (!child) return;
    this.serverProcess = undefined;

    // 'close' never fires again for a child that is already gone, so waiting on
    // it would hang until the suite timeout.
    if (child.exitCode !== null || child.signalCode !== null) return;

    // 'exit' rather than 'close': `go run` leaves a grandchild holding the
    // inherited stdio pipes, and 'close' waits for those to be released, so it
    // can outlive the process this is trying to reap.
    // Subscribed before the kill so a fast exit cannot be missed.
    const exited = once(child, 'exit');
    child.kill('SIGINT');
    // Windows emulates SIGINT as unconditional termination and a wedged child
    // may ignore it outright, so the wait is bounded rather than open-ended.
    const escalation = setTimeout(
      () => child.kill('SIGKILL'),
      PROCESS_EXIT_TIMEOUT_MS,
    );

    try {
      await exited;
    } finally {
      clearTimeout(escalation);
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
