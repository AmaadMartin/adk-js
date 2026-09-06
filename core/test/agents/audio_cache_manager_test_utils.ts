/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';

import {
  ArtifactVersion,
  BaseSessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  SessionArtifactService,
  SessionSaveArtifactRequest,
  createSession,
} from '@google/adk';

/**
 * A session-scoped artifact service that records every save.
 *
 * `saved` replaces the reference tests' call-count assertions, and `failure`
 * drives the flush error path.
 */
export class RecordingArtifactService implements SessionArtifactService {
  readonly saved: SessionSaveArtifactRequest[] = [];
  failure?: Error;

  constructor(private readonly revisionId = 123) {}

  async saveArtifact(request: SessionSaveArtifactRequest): Promise<number> {
    if (this.failure) {
      throw this.failure;
    }
    this.saved.push(request);
    return this.revisionId;
  }

  async loadArtifact(): Promise<Part | undefined> {
    return undefined;
  }

  async listArtifactKeys(): Promise<string[]> {
    return [];
  }

  async deleteArtifact(): Promise<void> {}

  async listVersions(): Promise<number[]> {
    return [];
  }

  async listArtifactVersions(): Promise<ArtifactVersion[]> {
    return [];
  }

  async getArtifactVersion(): Promise<ArtifactVersion | undefined> {
    return undefined;
  }
}

/** Encodes text as the base64 string a `@google/genai` blob carries. */
export function toBase64(data: string | Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/** Decodes a `@google/genai` blob payload back to bytes. */
export function fromBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}

export interface TestContextOptions {
  agentName?: string;
  artifactService?: SessionArtifactService;
  sessionService?: BaseSessionService;
}

/** An invocation context with a real agent and session, and no audio cached. */
export function createTestContext(
  options: TestContextOptions = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: options.agentName ?? 'test_agent'}),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager(),
    artifactService: options.artifactService,
    sessionService: options.sessionService,
  });
}
