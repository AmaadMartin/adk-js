#! /usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, setLogLevel as setAdkCoreLogLevel} from '@google/adk';
import {Argument, Command, Option} from 'commander';
import * as path from 'node:path';
import {runIntegrationTests} from '../integration/run_integration_tests.js';
import {
  ApiServerOptions,
  createApiServer,
} from '../server/api_server_factory.js';
import {FileModuleType, resolveAgentLocation} from '../utils/agent_loader.js';
import {loadDotenvForAgent, loadDotenvFromCwd} from '../utils/envs.js';
import {getAbsolutePath} from '../utils/file_utils.js';
import {AdkLogger} from '../utils/logger.js';
import {toMessage} from '../utils/value_utils.js';
import {version} from '../version.js';
import {registerConformanceCommands} from './cli_conformance.js';
import {createAgent} from './cli_create.js';
import {runEvalCli} from './cli_eval.js';
import {
  convertGoogleApi,
  DEFAULT_OUTPUT_PATH,
} from './cli_googleapi_to_openapi.js';
import {runAgent, runOnceCli} from './cli_run.js';
import {
  maybePromptForTelemetryConsent,
  registerTelemetryCommands,
} from './cli_telemetry.js';
import {deployToAgentEngine} from './deploy/cli_deploy_agent_engine.js';
import {deployToCloudRun} from './deploy/cli_deploy_cloud_run.js';
import {
  applyFeatureOverrides,
  DISABLE_FEATURES_OPTION,
  ENABLE_FEATURES_OPTION,
} from './feature_options.js';
import {applyHelpfulCommand} from './helpful_command.js';
import {
  closeServices,
  MEMORY_SERVICE_URI_OPTION,
  NO_USE_LOCAL_STORAGE_OPTION,
  resolveServices,
  resolveUseLocalStorage,
  USE_LOCAL_STORAGE_OPTION,
} from './service_options.js';

loadDotenvFromCwd();

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  'debug': LogLevel.DEBUG,
  'info': LogLevel.INFO,
  'warn': LogLevel.WARN,
  'error': LogLevel.ERROR,
};

function getLogLevelFromOptions(options: {
  verbose?: boolean;
  log_level?: string;
}) {
  if (options.verbose) {
    return LogLevel.DEBUG;
  }

  if (typeof options.log_level === 'string') {
    // `??`, not `||`: LogLevel.DEBUG is 0, so `||` fell through to INFO and
    // made `--log_level debug` a silent no-op.
    return LOG_LEVEL_MAP[options.log_level.toLowerCase()] ?? LogLevel.INFO;
  }

  return LogLevel.INFO;
}

function getAgentFileOptions(options: {
  compile?: boolean;
  bundle?: boolean;
  file_type?: string;
}) {
  return {
    compile: getBoolean(options['compile']),
    bundle: getBoolean(options['bundle']),
    moduleType: options['file_type'] as FileModuleType | undefined,
  };
}

function getBoolean(option?: string | boolean): boolean {
  if (typeof option === 'boolean') {
    return option;
  }

  if (typeof option === 'string') {
    return option === 'true' || option === '1';
  }

  return false;
}

/**
 * Reports whether the user supplied the option, rather than commander filling
 * in its default. An explicit empty value still counts as supplied.
 */
function wasSupplied(command: Command, name: string): boolean {
  const source = command.getOptionValueSource(name);
  return source !== undefined && source !== 'default';
}

/**
 * Maps the options `web` and `api_server` share onto the API server factory,
 * and builds the services those options ask for. The caller supplies `web`,
 * the one thing the two commands disagree on.
 */
function getApiServerOptions(
  agentsDir: string,
  logLevel: LogLevel,
  options: Record<string, string>,
  command: Command,
): Omit<ApiServerOptions, 'web'> {
  return {
    logLevel,
    agentsDir,
    host: options['host'],
    port: parseInt(options['port'], 10),
    allowOrigins: options['allow_origins'],
    allowedHosts: splitCommaSeparated(options['allowed_hosts']),
    ...resolveServices({
      baseDir: getAbsolutePath(agentsDir),
      sessionServiceUri: options['session_service_uri'],
      artifactServiceUri: options['artifact_service_uri'],
      memoryServiceUri: options['memory_service_uri'],
      useLocalStorage: resolveUseLocalStorage(command),
    }),
    otelToCloud: options['otel_to_cloud'] ? true : false,
    agentFileLoadOptions: getAgentFileOptions(options),
    a2a: getBoolean(options['a2a']),
    a2aAuthToken: options['a2a_auth_token'],
    reloadAgents: getBoolean(options['reload_agents']),
    defaultLlmModel: options['default_llm_model'],
    urlPrefix: options['url_prefix'],
    autoCreateSession: getBoolean(options['auto_create_session']),
    triggerSources: splitCommaSeparated(options['trigger_sources']),
    triggerOidcAudience: options['trigger_oidc_audience'],
    triggerOidcServiceAccounts: splitCommaSeparated(
      options['trigger_oidc_service_accounts'],
    ),
  };
}

/**
 * Splits a comma-separated option value into a list, dropping
 * empty/whitespace-only entries. An unset or empty option yields undefined
 * rather than [], so it composes with an optional `string[]` server option
 * without callers needing to special-case "no value provided".
 */
function splitCommaSeparated(option?: string): string[] | undefined {
  if (!option) {
    return undefined;
  }
  const values = option
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

const AGENT_DIR_ARGUMENT = new Argument(
  '[agents_dir]',
  'Agent file or directory of agents to serve. For directory the internal structure should be agents_dir/{agentName}.js or agents_dir/{agentName}/agent.js. Agent file should has export of the rootAgent as instance of BaseAgent (e.g LlmAgent) or a Workflow',
).default(process.cwd());
const HOST_OPTION = new Option(
  '-h, --host <string>',
  'Optional. The binding host of the server',
).default('localhost');
const PORT_OPTION = new Option(
  '-p, --port <number>',
  'Optional. The port of the server. Default: 8000',
).default('8000');
const ORIGINS_OPTION = new Option(
  '--allow_origins <string>',
  'Optional. The allow origins of the server',
).default('');
const ALLOWED_HOSTS_OPTION = new Option(
  '--allowed_hosts <string>',
  'Optional. Comma-separated list of additional Host header values the ' +
    'DNS-rebinding guard accepts, independent of --allow_origins. Use ' +
    'this to widen the guard for a reverse proxy in front of a ' +
    'loopback-bound server without opening --allow_origins to "*".',
).default('');
const VERBOSE_OPTION = new Option(
  '-v, --verbose',
  'Optional. Log at debug level. Shorthand for --log_level debug',
).default(false);
const LOG_LEVEL_OPTION = new Option(
  '--log_level <string>',
  'Optional. The log level of the server',
).default('info');
const SESSION_SERVICE_URI_OPTION = new Option(
  '--session_service_uri <string>',
  'Optional. The URI of the session service. Supported URIs: memory:// for in-memory session service.',
);
const ARTIFACT_SERVICE_URI_OPTION = new Option(
  '--artifact_service_uri <string>',
  'Optional. The URI of the artifact service. Supported URIs: gs://<bucket name> for GCS artifact service.',
);
const OTEL_TO_CLOUD_OPTION = new Option(
  '--otel_to_cloud [boolean]',
  'Optional. Whether to send otel traces to cloud.',
).default(false);
const COMPILE_AGENT_FILE = new Option(
  '--compile [boolean]',
  'Optional. Whether to compile ts agent file to js before execution',
).default(true);
const BUNDLE_AGENT_FILE = new Option(
  '--bundle [boolean]',
  'Optional. Whether to inline the agent file dependencies into a single ' +
    'bundle before execution. Bundling also minifies the result.',
).default(true);
const A2A_OPTION = new Option(
  '--a2a [boolean]',
  'Optional. Whether to enable A2A for web/api server. Default: false',
).default(false);
const A2A_AUTH_TOKEN_OPTION = new Option(
  '--a2a_auth_token <string>',
  'Optional. Shared bearer token used to authenticate the A2A surface. Callers must send "Authorization: Bearer <token>". Can also be set via the ADK_A2A_AUTH_TOKEN environment variable. If unset, the A2A surface is served WITHOUT authentication.',
);
const A2A_AUTH_TOKEN_DEPLOY_OPTION = new Option(
  '--a2a_auth_token <string>',
  'Optional. Shared bearer token used to authenticate the deployed A2A surface. Callers must send "Authorization: Bearer <token>". It is sent to Cloud Run as the ADK_A2A_AUTH_TOKEN environment variable and is never written into the image. If unset, the deployed A2A surface is served WITHOUT authentication.',
);
const URL_PREFIX_OPTION = new Option(
  '--url_prefix <string>',
  'Optional. URL path prefix when the application is mounted behind a ' +
    "reverse proxy or API gateway (e.g. '/api/v1', '/adk'). Routes stay at " +
    'the root; the prefix is applied to the redirects the server generates.',
);
const AUTO_CREATE_SESSION_OPTION = new Option(
  '--auto_create_session [boolean]',
  "Optional. Automatically create a session if it doesn't exist when " +
    'calling /run or /run_sse, instead of answering 404. Default: false',
).default(false);
const TRIGGER_SOURCES_OPTION = new Option(
  '--trigger_sources <string>',
  'Optional. Comma-separated event sources to serve trigger endpoints for: ' +
    'pubsub, eventarc. Nothing is served without this flag. A served ' +
    'endpoint accepts UNAUTHENTICATED requests unless ' +
    '--trigger_oidc_audience is also set or a verifier is configured in code.',
);
const TRIGGER_OIDC_AUDIENCE_OPTION = new Option(
  '--trigger_oidc_audience <string>',
  'Optional. Audience the Google OIDC identity token on a trigger request ' +
    "must carry, normally this service's public URL. Without it the trigger " +
    'endpoints accept UNAUTHENTICATED requests.',
);
const TRIGGER_OIDC_SERVICE_ACCOUNTS_OPTION = new Option(
  '--trigger_oidc_service_accounts <string>',
  'Optional. Comma-separated service account addresses allowed to call the ' +
    'trigger endpoints. Requires --trigger_oidc_audience.',
);
const RELOAD_AGENTS_OPTION = new Option(
  '--reload_agents [boolean]',
  'Optional. Watch agent files for changes and automatically reload them. Default: false. To see any changes to your agent file, you need to initiate a new agent run.',
).default(false);
const DEFAULT_LLM_MODEL_OPTION = new Option(
  '--default_llm_model <string>',
  'Optional. Sets the default LLM model used when the agent does not set a ' +
    'model explicitly.',
);
const AGENT_FILE_MODULE_TYPE = new Option('--file_type <string>', 'Optional. ');
AGENT_FILE_MODULE_TYPE.argChoices = [FileModuleType.CJS, FileModuleType.ESM];

// Reusable deployment CLI option constants
export const PROJECT_DEPLOY_OPTION = new Option(
  '--project [string]',
  'Optional. Google Cloud project to deploy the agent. If not set, default project from gcloud config is used',
);
export const REGION_DEPLOY_OPTION = new Option(
  '--region [string]',
  'Optional. Google Cloud region to deploy the agent. If not set, default run/region from gcloud config is used',
);
export const ADK_VERSION_OPTION = new Option(
  '--adk_version [string]',
  'Optional. ADK version to use. If not set, default to the latest version available on npm',
).default('latest');
export const WITH_UI_OPTION = new Option(
  '--with_ui [boolean]',
  'Optional. Deploy ADK Web UI if set. (default: deploy ADK API server only)',
).default(false);
export const DISPLAY_NAME_OPTION = new Option(
  '--display_name [string]',
  'Optional. The display name for the Reasoning Engine. Defaults to agent directory name.',
);
export const DESCRIPTION_OPTION = new Option(
  '--description [string]',
  'Optional. The description for the Reasoning Engine.',
);
export const REPOSITORY_DEPLOY_OPTION = new Option(
  '--repository [string]',
  'Optional. Artifact Registry repository name to push docker images. Required for agent_engine deploy.',
);
export const AGENT_ENGINE_ID_OPTION = new Option(
  '--agent_engine_id [id]',
  'Optional. ID of the Agent Engine instance to update if it exists (default: undefined, which means a new instance will be created). If project and region are set, this should be the resource ID or the full resource name (projects/.../locations/.../reasoningEngines/...).',
);

/** What distinguishes the `web` command from the `api_server` command. */
interface ServerCommandOptions {
  name: string;
  description: string;
  /** Whether to serve the developer UI alongside the API. */
  serveDebugUI: boolean;
  startFailureMessage: string;
  /**
   * Whether the command accepts `--auto_create_session`. adk-python declares
   * that option on `api_server` only, so `web` must reject it.
   */
  autoCreateSession?: boolean;
}

/**
 * Registers one of the two commands that serve an agents directory.
 *
 * `web` and `api_server` take the same options and start the same server, so
 * they are declared once here and differ only by {@link ServerCommandOptions}.
 */
function addServerCommand(
  program: Command,
  logger: AdkLogger,
  server: ServerCommandOptions,
): void {
  const serverCommand = program
    .command(server.name)
    .description(server.description)
    .addArgument(AGENT_DIR_ARGUMENT)
    .addOption(HOST_OPTION)
    .addOption(PORT_OPTION)
    .addOption(ORIGINS_OPTION)
    .addOption(ALLOWED_HOSTS_OPTION)
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .addOption(SESSION_SERVICE_URI_OPTION)
    .addOption(ARTIFACT_SERVICE_URI_OPTION)
    .addOption(OTEL_TO_CLOUD_OPTION)
    .addOption(COMPILE_AGENT_FILE)
    .addOption(BUNDLE_AGENT_FILE)
    .addOption(AGENT_FILE_MODULE_TYPE)
    .addOption(A2A_OPTION)
    .addOption(A2A_AUTH_TOKEN_OPTION)
    .addOption(RELOAD_AGENTS_OPTION)
    .addOption(DEFAULT_LLM_MODEL_OPTION)
    .addOption(TRIGGER_SOURCES_OPTION)
    .addOption(TRIGGER_OIDC_AUDIENCE_OPTION)
    .addOption(TRIGGER_OIDC_SERVICE_ACCOUNTS_OPTION)
    .addOption(URL_PREFIX_OPTION)
    .addOption(ENABLE_FEATURES_OPTION)
    .addOption(DISABLE_FEATURES_OPTION)
    .addOption(MEMORY_SERVICE_URI_OPTION)
    .addOption(USE_LOCAL_STORAGE_OPTION)
    .addOption(NO_USE_LOCAL_STORAGE_OPTION);

  if (server.autoCreateSession) {
    serverCommand.addOption(AUTO_CREATE_SESSION_OPTION);
  }

  serverCommand.action(
    async (
      agentsDir: string,
      options: Record<string, string>,
      command: Command,
    ) => {
      applyFeatureOverrides(command);
      const logLevel = getLogLevelFromOptions(options);
      setAdkCoreLogLevel(logLevel);

      try {
        await createApiServer({
          ...getApiServerOptions(agentsDir, logLevel, options, command),
          web: server.serveDebugUI,
        }).start();
      } catch (error) {
        logger.error(server.startFailureMessage, toMessage(error));
        process.exit(1);
      }
    },
  );
}

/**
 * Creates the ADK CLI program.
 * @returns The ADK CLI program.
 */
export function createProgram(): Command {
  const logger = new AdkLogger({
    label: 'ADK CLI',
    colorize: {all: true},
  });

  const program = new Command('ADK CLI');

  program
    .addOption(new Option('-v, --version', 'Get ADK CLI version'))
    .action(() => {
      console.log(version);
    });

  registerTelemetryCommands(program);

  program.hook('preSubcommand', async (_program, subcommand) => {
    await maybePromptForTelemetryConsent(subcommand.name(), process.argv);
  });

  addServerCommand(program, logger, {
    name: 'web',
    description: 'Start ADK web server',
    serveDebugUI: true,
    startFailureMessage: 'Error starting web server:',
  });

  addServerCommand(program, logger, {
    name: 'api_server',
    description: 'Start ADK API server',
    serveDebugUI: false,
    startFailureMessage: 'Error starting API server:',
    autoCreateSession: true,
  });

  applyHelpfulCommand(program.command('create'))
    .description('Creates a new agent')
    .argument('[agent]', 'Name to give the new agent', 'adk_agent')
    .option('-y, --yes', 'Optional. Skip confirmation prompts.')
    .option('--model <string>', 'Optional. THe model used for the root_agent')
    .option(
      '--api_key <string>',
      'Optional. The API Key needed to access the model, e.g. Google AI API Key.',
    )
    .option(
      '--project <string>',
      'Optional. The Google Cloud Project for using VertexAI as backend.',
    )
    .option(
      '--region <string>',
      'Optional. The Google Cloud Region for using VertexAI as backend.',
    )
    .option(
      '--language <string>',
      'Optional. Either ts or js as the language to output.',
    )
    .action(async (agentName: string, options: Record<string, string>) => {
      try {
        await createAgent({
          agentName,
          forceYes: !!options['yes'],
          model: options['model'],
          apiKey: options['api_key'],
          project: options['project'],
          region: options['region'],
          language: options['language'],
        });
      } catch (error) {
        logger.error('Error creating agent:', (error as Error).message);
      }
    });

  applyHelpfulCommand(program.command('run'))
    .description('Runs agent')
    .argument('<agent>', 'Agent file path (.js or .ts)')
    .argument(
      '[query]',
      'Optional. The user message to send to the agent for a single-step run. Without it, run opens the interactive prompt.',
    )
    .option(
      '--state <string>',
      'Optional. Initial session state, as a JSON object.',
    )
    .option(
      '--timeout <string>',
      'Optional. Budget for one query, e.g. 30 (seconds), 30s or 5m.',
    )
    .option(
      '--in_memory',
      'Optional. Keep the session, artifacts and memory in memory, overriding every other storage option.',
    )
    .option(
      '--jsonl',
      'Optional. Print one JSON object per event on stdout instead of human-readable text.',
    )
    .option(
      '--save_session [boolean]',
      'Optional. Whether to save the session to a json file on exit.',
      false,
    )
    .option(
      '--session_id <string>',
      'Optional. The session ID to save the session to on exit when --save_session is set to true. User will be prompted to enter a session ID if not set.',
    )
    .option(
      '--replay <string>',
      'The json file that contains the initial state of the session and user queries. A new session will be created using this state. And user queries are run against the newly created session. Users cannot continue to interact with the agent.',
    )
    .option(
      '--resume <string>',
      'The json file that contains a previously saved session (by --save_session option). The previous session will be re-displayed. And user can continue to interact with the agent.',
    )
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .addOption(SESSION_SERVICE_URI_OPTION)
    .addOption(ARTIFACT_SERVICE_URI_OPTION)
    .addOption(OTEL_TO_CLOUD_OPTION)
    .addOption(COMPILE_AGENT_FILE)
    .addOption(BUNDLE_AGENT_FILE)
    .addOption(AGENT_FILE_MODULE_TYPE)
    .addOption(RELOAD_AGENTS_OPTION)
    .addOption(ENABLE_FEATURES_OPTION)
    .addOption(DISABLE_FEATURES_OPTION)
    .addOption(MEMORY_SERVICE_URI_OPTION)
    .addOption(USE_LOCAL_STORAGE_OPTION)
    .addOption(NO_USE_LOCAL_STORAGE_OPTION)
    .addOption(DEFAULT_LLM_MODEL_OPTION)
    .action(
      async (
        agentPath: string,
        query: string | undefined,
        options: Record<string, string>,
        command: Command,
      ) => {
        // Before anything is resolved or loaded: the two options name two
        // different sessions, so the run cannot honour both.
        if (wasSupplied(command, 'replay') && wasSupplied(command, 'resume')) {
          command.error(
            `error: Options 'resume' and 'replay' cannot be set together.`,
            {code: 'commander.conflictingOption'},
          );
        }
        applyFeatureOverrides(command);
        setAdkCoreLogLevel(getLogLevelFromOptions(options));

        // Before the services: the agent's `.env` may hold the DATABASE_URL
        // that decides which session service the run gets.
        const location = resolveAgentLocation(agentPath);
        loadDotenvForAgent(location.name, location.parentDir);

        const services = resolveServices({
          baseDir: path.dirname(getAbsolutePath(agentPath)),
          sessionServiceUri: options['session_service_uri'],
          artifactServiceUri: options['artifact_service_uri'],
          memoryServiceUri: options['memory_service_uri'],
          useLocalStorage: resolveUseLocalStorage(command),
          inMemory: getBoolean(options['in_memory']),
        });

        let exitCode = 0;
        try {
          // adk-python switches to the single-shot run on the query alone, so
          // a piped stdin still reaches the interactive prompt.
          if (query !== undefined) {
            exitCode = await runOnceCli({
              agentPath,
              query,
              stateStr: options['state'],
              sessionId: options['session_id'],
              replay: options['replay'],
              timeout: options['timeout'],
              jsonl: getBoolean(options['jsonl']),
              ...services,
              agentFileLoadOptions: getAgentFileOptions(options),
            });
          } else {
            await runAgent({
              agentPath,
              inputFile: options['replay'],
              savedSessionFile: options['resume'],
              saveSession: getBoolean(options['save_session']),
              sessionId: options['session_id'],
              stateStr: options['state'],
              timeout: options['timeout'],
              jsonl: getBoolean(options['jsonl']),
              ...services,
              otelToCloud: options['otel_to_cloud'] ? true : false,
              agentFileLoadOptions: getAgentFileOptions(options),
              reloadAgents: getBoolean(options['reload_agents']),
              defaultLlmModel: options['default_llm_model'],
            });
          }
        } catch (error) {
          logger.error('Error running agent:', toMessage(error));
          exitCode = 1;
        } finally {
          // The database session service keeps a sqlite connection on the
          // event loop, so the command never exits until it is released.
          await closeServices(services);
        }

        if (exitCode !== 0) {
          process.exit(exitCode);
        }
      },
    );

  applyHelpfulCommand(program.command('eval'))
    .description('Evaluates an agent given the eval sets')
    .argument('<agent>', 'Agent file path (.js or .ts)')
    .argument(
      '[eval_set_file_path_or_id...]',
      'One or more eval set file paths or eval set ids. Add `:case1,case2` to run only those eval cases. Mixing file paths with ids is not supported.',
    )
    .option('--config_file_path <string>', 'Optional. The path to config file.')
    .option(
      '--print_detailed_results',
      'Optional. Whether to print detailed results on console or not.',
      false,
    )
    .option(
      '--eval_storage_uri <string>',
      'Optional. The evals storage URI to store agent evals, supported URIs: gs://<bucket name>.',
    )
    .addOption(LOG_LEVEL_OPTION)
    .addOption(COMPILE_AGENT_FILE)
    .addOption(BUNDLE_AGENT_FILE)
    .addOption(AGENT_FILE_MODULE_TYPE)
    .action(
      async (
        agentPath: string,
        evalSetFileOrIds: string[],
        options: Record<string, string>,
      ) => {
        setAdkCoreLogLevel(getLogLevelFromOptions(options));
        try {
          await runEvalCli({
            agentPath,
            evalSetFileOrIds,
            configFilePath: options['config_file_path'],
            printDetailedResults: getBoolean(options['print_detailed_results']),
            evalStorageUri: options['eval_storage_uri'],
            agentFileLoadOptions: getAgentFileOptions(options),
          });
        } catch (error) {
          logger.error('Error evaluating agent:', toMessage(error));
          process.exit(1);
        }
      },
    );

  program
    .command('googleapi_to_openapi')
    .description(
      'Converts a Google API Discovery document to an OpenAPI v3 specification',
    )
    .argument('<api_name>', "Name of the Google API, e.g. 'calendar'")
    .argument('<api_version>', "Version of the API, e.g. 'v3'")
    .option(
      '-o, --output <path>',
      'Optional. Output file path for the OpenAPI specification.',
      DEFAULT_OUTPUT_PATH,
    )
    .action(
      async (
        apiName: string,
        apiVersion: string,
        options: Record<string, string>,
      ) => {
        try {
          await convertGoogleApi({
            apiName,
            apiVersion,
            output: options['output'],
          });
        } catch (error) {
          logger.error(
            'Error converting Google API:',
            (error as Error).message,
          );
          process.exit(1);
        }
      },
    );

  const DEPLOY_COMMAND = program
    .command('deploy')
    .description('Deploy agent')
    .allowUnknownOption()
    .allowExcessArguments();

  DEPLOY_COMMAND.command('cloud_run')
    .addArgument(AGENT_DIR_ARGUMENT)
    .allowUnknownOption()
    .allowExcessArguments()
    .addOption(PORT_OPTION)
    .addOption(PROJECT_DEPLOY_OPTION)
    .addOption(REGION_DEPLOY_OPTION)
    .option(
      '--service_name [string]',
      'Optional. The service name to use in Cloud Run. Default: "adk-default-service-name"',
      'adk-default-service-name',
    )
    .option(
      '--temp_folder [string]',
      'Optional. Temp folder for the generated Cloud Run source files (default: a private directory created in the system temp directory).',
    )
    .addOption(ADK_VERSION_OPTION)
    .addOption(WITH_UI_OPTION)
    .addOption(ORIGINS_OPTION)
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .addOption(SESSION_SERVICE_URI_OPTION)
    .addOption(ARTIFACT_SERVICE_URI_OPTION)
    .addOption(COMPILE_AGENT_FILE)
    .addOption(BUNDLE_AGENT_FILE)
    .addOption(AGENT_FILE_MODULE_TYPE)
    .addOption(A2A_OPTION)
    .addOption(A2A_AUTH_TOKEN_DEPLOY_OPTION)
    .action(async (agentPath: string, options: Record<string, string>) => {
      const extraGcloudArgs = [];
      for (const arg of process.argv.slice(5)) {
        let argName = arg.replace(/^-+/, '');
        if (argName.includes('=')) {
          argName = argName.split('=')[0];
        }
        if (argName in options) {
          continue;
        }

        extraGcloudArgs.push(arg);
      }

      try {
        await deployToCloudRun({
          agentPath: getAbsolutePath(agentPath),
          project: options['project'],
          region: options['region'],
          serviceName: options['service_name'],
          tempFolder: options['temp_folder'],
          port: parseInt(options['port'], 10),
          withUi: getBoolean(options['with_ui']),
          logLevel: options['log_level'],
          adkVersion: options['adk_version'],
          allowOrigins: options['allow_origins'],
          sessionServiceUri: options['session_service_uri'],
          artifactServiceUri: options['artifact_service_uri'],
          agentFileLoadOptions: getAgentFileOptions(options),
          a2a: getBoolean(options['a2a']),
          a2aAuthToken: options['a2a_auth_token'],
          extraGcloudArgs,
        });
      } catch (error) {
        logger.error('Error deploying agent:', (error as Error).message);
      }
    });

  const registerAgentEngineCommand = (cmd: Command) => {
    cmd
      .addArgument(AGENT_DIR_ARGUMENT)
      .allowUnknownOption()
      .allowExcessArguments()
      .addOption(PROJECT_DEPLOY_OPTION)
      .addOption(REGION_DEPLOY_OPTION)
      .addOption(DISPLAY_NAME_OPTION)
      .addOption(DESCRIPTION_OPTION)
      .addOption(REPOSITORY_DEPLOY_OPTION)
      .option(
        '--temp_folder [string]',
        'Optional. Temp folder for the generated source files (default: a private directory created in the system temp directory).',
      )
      .addOption(ADK_VERSION_OPTION)
      .addOption(WITH_UI_OPTION)
      .addOption(ORIGINS_OPTION)
      .addOption(VERBOSE_OPTION)
      .addOption(LOG_LEVEL_OPTION)
      .addOption(SESSION_SERVICE_URI_OPTION)
      .addOption(ARTIFACT_SERVICE_URI_OPTION)
      .addOption(COMPILE_AGENT_FILE)
      .addOption(BUNDLE_AGENT_FILE)
      .addOption(AGENT_FILE_MODULE_TYPE)
      .addOption(A2A_OPTION)
      .addOption(AGENT_ENGINE_ID_OPTION)
      .addOption(MEMORY_SERVICE_URI_OPTION)
      .action(async (agentPath: string, options: Record<string, string>) => {
        try {
          await deployToAgentEngine({
            agentPath: getAbsolutePath(agentPath),
            project: options['project'],
            region: options['region'],
            displayName: options['display_name'],
            description: options['description'],
            repository: options['repository'],
            tempFolder: options['temp_folder'],
            port: 8080, // Agent Engine requires fixed port of 8080
            withUi: getBoolean(options['with_ui']),
            logLevel: options['log_level'],
            adkVersion: options['adk_version'],
            allowOrigins: options['allow_origins'],
            sessionServiceUri: options['session_service_uri'],
            artifactServiceUri: options['artifact_service_uri'],
            memoryServiceUri: options['memory_service_uri'],
            agentFileLoadOptions: getAgentFileOptions(options),
            a2a: getBoolean(options['a2a']),
            agentEngineId: options['agent_engine_id'],
          });
        } catch (error) {
          logger.error('Error deploying agent:', (error as Error).message);
        }
      });
  };

  registerAgentEngineCommand(DEPLOY_COMMAND.command('agent_engine'));
  registerAgentEngineCommand(DEPLOY_COMMAND.command('reasoning_engine'));

  const CONFORMANCE_COMMAND = program
    .command('integration')
    .description('Run ADK integration and conformance tests');

  CONFORMANCE_COMMAND.command('conformance')
    .description('Run ADK conformance tests')
    .addOption(VERBOSE_OPTION)
    .addOption(LOG_LEVEL_OPTION)
    .option(
      '--agents_dir [dir]',
      'Directory of conformance test agent definitions. Recursively searched for .yaml files with agent definitions.',
      process.cwd(),
    )
    .option(
      '--tests_dir [dir]',
      'Directory of conformance test definitions. Recursively searched for .yaml files with test definitions.',
      process.cwd(),
    )
    .option('--force', 'Force run skipped tests.')
    .action(async (options: Record<string, string>) => {
      runIntegrationTests({
        agentsDir: options['agents_dir'],
        testsDir: options['tests_dir'],
        forceRunAll: getBoolean(options['force']),
      });
    });

  registerConformanceCommands(program);

  return program;
}
