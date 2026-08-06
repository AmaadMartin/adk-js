/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '@google/adk';
import {spawn} from 'node:child_process';
import * as readline from 'node:readline';
import {ensureGoModules} from '../../../go_modules.js';

export interface GoAgentParams {
  dir: string;
  agentUrl: string;
}

/**
 * A TS client for a Go agent that communicates with Go agent file using command line.
 */
export class GoAgent {
  private readonly dir: string;
  private readonly agentUrl: string;

  constructor(params: GoAgentParams) {
    this.dir = params.dir;
    this.agentUrl = params.agentUrl;
  }

  public async *run(userMessage: string): AsyncGenerator<Event, void, unknown> {
    await ensureGoModules(this.dir);

    const child = spawn(
      'go',
      [
        'run',
        '.',
        `-agent_url=${this.agentUrl}`,
        `-agent_input=${userMessage}`,
      ],
      {
        cwd: this.dir,
        env: process.env,
      },
    );

    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim()) {
        yield JSON.parse(line) as Event;
      }
    }

    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          console.error('STDERR:', stderr);
          reject(
            new Error(`Process exited with code ${code}\nStderr: ${stderr}`),
          );
        }
      });
    });
  }
}
