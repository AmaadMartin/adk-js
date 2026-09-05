/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, RunnableRoot} from '@google/adk';

import {AgentFile, AgentLoader} from '../../src/utils/agent_loader.js';

/** Agent file that serves an in-memory root instead of reading a file. */
class StubAgentFile extends AgentFile {
  constructor(private readonly root: RunnableRoot) {
    super('stub_agent.js');
  }

  override load(): Promise<RunnableRoot | App> {
    return Promise.resolve(this.root);
  }
}

/**
 * Agent loader that serves one in-memory root under any number of app names.
 *
 * It extends the real loader rather than casting an object literal, because
 * `AgentLoader` holds private state that an object literal cannot satisfy. The
 * real constructor registers process exit handlers and never removes them, so
 * a test file builds ONE stub and re-points it with {@link serve} for each
 * test rather than building a stub per test.
 */
export class StubAgentLoader extends AgentLoader {
  private appNames: string[] = [];
  private root?: RunnableRoot;

  /** Points the loader at `root`, served under each of `appNames`. */
  serve(root: RunnableRoot, ...appNames: string[]): void {
    this.root = root;
    this.appNames = appNames;
  }

  override listAgents(): Promise<string[]> {
    return Promise.resolve(this.appNames);
  }

  override getAgentFile(agentName: string): Promise<AgentFile> {
    if (!this.root) {
      return Promise.reject(new Error(`No agent configured for ${agentName}`));
    }

    return Promise.resolve(new StubAgentFile(this.root));
  }
}
