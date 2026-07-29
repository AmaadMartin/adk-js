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

/**
 * Binds an ephemeral port on `host`, reads back the number the OS assigned and
 * releases it, so the caller can hand a concretely-free port to a child process
 * that needs to know its port before it starts.
 */
export async function reserveFreePort(host: string): Promise<number> {
  const socket = net.createServer();

  try {
    return await new Promise<number>((resolve, reject) => {
      socket.once('error', reject);
      socket.listen({host, port: 0}, () => {
        const address = socket.address();
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
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
}

/** Renders both captured streams for inclusion in a startup failure. */
function formatCapturedOutput(stdout: string, stderr: string): string {
  return (
    `\n--- stdout ---\n${stdout || '(empty)'}` +
    `\n--- stderr ---\n${stderr || '(empty)'}`
  );
}

/**
 * Resolves once `startMessage` appears in the process's stdout.
 *
 * The message is matched against the accumulated output rather than a single
 * chunk, because a multi-line startup banner can be split across writes. Every
 * rejection carries both captured streams: the real reason a server fails to
 * start (an in-use port, a missing build output) is reported on stderr.
 */
function waitForStartMessage(
  serverProcess: ChildProcessWithoutNullStreams,
  {
    startMessage,
    serverName,
    timeoutMs,
  }: {startMessage: string; serverName: string; timeoutMs: number},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    // Detaching the 'data' handlers does not pause the streams -- they stay in
    // flowing mode -- so a server that keeps logging after startup still
    // drains instead of blocking on a full pipe.
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      serverProcess.stdout.off('data', onStdout);
      serverProcess.stderr.off('data', onStderr);
      serverProcess.off('error', onError);
      serverProcess.off('close', onClose);
      finish();
    };

    const onStdout = (data: Buffer) => {
      stdout += data.toString();
      if (stdout.includes(startMessage)) {
        settle(resolve);
      }
    };

    const onStderr = (data: Buffer) => {
      const message = data.toString();
      stderr += message;
      console.error(`${serverName} Stderr: ${message}`);
    };

    const onError = (error: Error) => {
      settle(() =>
        reject(
          new Error(
            `Failed to start ${serverName.toLowerCase()}: ${error.message}` +
              formatCapturedOutput(stdout, stderr),
          ),
        ),
      );
    };

    // 'close' rather than 'exit': it fires only once the stdio pipes have been
    // drained, so the child's last words -- typically the actual reason it
    // refused to start -- are already captured when the error is built.
    const onClose = (code: number | null) => {
      settle(() =>
        reject(
          new Error(
            `${serverName} exited prematurely with code ${code}` +
              formatCapturedOutput(stdout, stderr),
          ),
        ),
      );
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `Timeout waiting for ${serverName.toLowerCase()} to start.` +
              formatCapturedOutput(stdout, stderr),
          ),
        ),
      );
    }, timeoutMs);

    serverProcess.stdout.on('data', onStdout);
    serverProcess.stderr.on('data', onStderr);
    serverProcess.on('error', onError);
    serverProcess.on('close', onClose);
  });
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
    // Subclasses read `this.port` inside `spawnProcess`, and agents under test
    // read it from the environment, so it has to be concrete before spawning.
    if (!this.port) {
      this.port = await reserveFreePort(this.host);
      this.url = `http://${this.host}:${this.port}`;
    }

    this.serverProcess = spawnProcess();

    await waitForStartMessage(this.serverProcess, {
      startMessage,
      serverName,
      timeoutMs,
    });
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
