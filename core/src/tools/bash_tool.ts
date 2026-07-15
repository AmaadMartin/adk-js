import {FunctionDeclaration, Type} from '@google/genai';
import {spawn} from 'child_process';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

export interface BashToolPolicy {
  allowedCommandPrefixes?: string[];
  blockedOperators?: string[];
  timeoutSeconds?: number;
  maxMemoryBytes?: number;
  maxFileSizeBytes?: number;
  maxChildProcesses?: number;
}

export function validateCommand(
  command: string,
  policy: BashToolPolicy,
): string | null {
  const stripped = command.trim();
  if (!stripped) {
    return 'Command is required.';
  }

  for (const op of policy.blockedOperators ?? []) {
    if (command.includes(op)) {
      return `Command contains blocked operator: ${op}`;
    }
  }

  const allowedPrefixes = policy.allowedCommandPrefixes ?? ['*'];
  if (allowedPrefixes.some((p) => p === '*' || stripped.startsWith(p)))
    return null;

  return `Command blocked. Permitted prefixes are: ${allowedPrefixes.join(', ')}`;
}

export interface ExecuteBashToolParams {
  workspace?: string;
  policy?: BashToolPolicy;
}

export class ExecuteBashTool extends BaseTool {
  private workspace: string;
  private policy: BashToolPolicy;

  constructor(params?: ExecuteBashToolParams) {
    const policy = {
      allowedCommandPrefixes: ['*'],
      blockedOperators: [],
      timeoutSeconds: 30,
      ...params?.policy,
    };
    const allowedHint = policy.allowedCommandPrefixes.includes('*')
      ? 'any command'
      : `commands matching prefixes: ${policy.allowedCommandPrefixes.join(', ')}`;
    super({
      name: 'execute_bash',
      description: `Executes a bash command with the working directory set to the workspace. Allowed: ${allowedHint}. All commands require user confirmation.`,
    });
    this.workspace = params?.workspace ?? process.cwd();
    this.policy = policy;
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          command: {
            type: Type.STRING,
            description: 'The bash command to execute.',
          },
        },
        required: ['command'],
      },
    };
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const command = (request.args.command as string) ?? '';

    const validationError = validateCommand(command, this.policy);
    if (validationError) {
      return {error: validationError};
    }

    const {toolContext} = request;
    if (!toolContext.toolConfirmation) {
      toolContext.requestConfirmation({
        hint: `Please approve or reject the bash command: ${command}`,
      });
      toolContext.actions.skipSummarization = true;
      return {
        error:
          'This tool call requires confirmation, please approve or reject.',
      };
    } else if (!toolContext.toolConfirmation.confirmed) {
      return {error: 'This tool call is rejected.'};
    }

    const timeoutSeconds = this.policy.timeoutSeconds ?? 30;

    let stdoutData = '';
    let stderrData = '';

    const limitCmds: string[] = [];
    if (this.policy.maxMemoryBytes) {
      limitCmds.push(
        `ulimit -v ${Math.floor(this.policy.maxMemoryBytes / 1024)}`,
      );
    }
    if (this.policy.maxFileSizeBytes) {
      limitCmds.push(
        `ulimit -f ${Math.floor(this.policy.maxFileSizeBytes / 1024)}`,
      );
    }
    if (this.policy.maxChildProcesses) {
      limitCmds.push(`ulimit -u ${this.policy.maxChildProcesses}`);
    }

    // In node, to mimic start_new_session=True from python and allow killpg, we use detached: true
    const fullCommand = [...limitCmds, command].join(' ; ');

    return new Promise((resolve) => {
      let isSettled = false;
      const child = spawn('/bin/bash', ['-c', fullCommand], {
        cwd: this.workspace,
        detached: true,
      });

      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const finishProcess = (
        returncode: number | null,
        errorMessage?: string,
      ) => {
        if (isSettled) return;
        isSettled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);

        const stdoutTrimmed = stdoutData || '<no stdout captured>';
        const stderrTrimmed = stderrData || '<no stderr captured>';

        resolve({
          ...(!errorMessage && {returncode: returncode ?? -1}),
          ...(errorMessage && {
            error: errorMessage,
            ...(returncode !== null && {returncode}),
          }),
          stdout: stdoutTrimmed,
          stderr: stderrTrimmed,
        });
      };

      child.stdout?.on('data', (data) => {
        stdoutData += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderrData += data.toString();
      });

      child.on('error', (err) => {
        finishProcess(null, `Execution failed: ${err.message}`);
      });

      child.on('close', (code) => {
        finishProcess(code);
      });

      if (timeoutSeconds > 0) {
        timeoutTimer = setTimeout(() => {
          if (!isSettled) {
            try {
              if (child.pid) {
                process.kill(-child.pid, 'SIGKILL');
              }
            } catch (_e) {
              // Ignore failure to kill
            }
            finishProcess(
              null,
              `Command timed out after ${timeoutSeconds} seconds.`,
            );
          }
        }, timeoutSeconds * 1000);
      }
    });
  }
}
