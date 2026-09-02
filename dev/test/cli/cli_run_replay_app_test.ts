/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseAgent,
  BasePlugin,
  createEvent,
  Event,
  InMemorySessionService,
  InvocationContext,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runAgent} from '../../src/cli/cli_run.js';
import {AgentFile} from '../../src/utils/agent_loader.js';

/** Records the runner lifecycle callbacks the App's plugins receive. */
class RecordingPlugin extends BasePlugin {
  readonly seen: string[] = [];

  constructor() {
    super('recording-plugin');
  }

  override async beforeRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<undefined> {
    this.seen.push(params.invocationContext.appName);
    return;
  }
}

/** An agent that answers without a model, so the run needs no network. */
class ReplyAgent extends BaseAgent {
  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      content: {role: 'model', parts: [{text: 'sunny'}]},
    });
  }

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
}

describe('adk run --replay with an App', () => {
  let tempDir: string;
  let inputFile: string;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-cli-replay-'));
    inputFile = path.join(tempDir, 'input.json');
    fs.writeFileSync(
      inputFile,
      JSON.stringify({state: {}, queries: ['What is the weather?']}),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  it("runs the App's plugins and files the session under the App name", async () => {
    const plugin = new RecordingPlugin();
    const app = new App({
      name: 'weather_app',
      rootAgent: new ReplyAgent({name: 'assistant'}),
      plugins: [plugin],
    });
    // Only the compile-and-import step is stubbed; the Runner, the App, the
    // plugin and the session service below are all real.
    vi.spyOn(AgentFile.prototype, 'load').mockResolvedValue(app);
    const sessionService = new InMemorySessionService();

    await runAgent({
      agentPath: path.join(tempDir, 'agent.ts'),
      inputFile,
      sessionService,
    });

    expect(plugin.seen).toEqual(['weather_app']);
    const {sessions} = await sessionService.listSessions({
      appName: 'weather_app',
      userId: 'test_user',
    });
    expect(sessions).toHaveLength(2);
  });
});
