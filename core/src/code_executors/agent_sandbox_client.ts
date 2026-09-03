/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';

import type {CustomObjectsApi} from '@kubernetes/client-node';

import {formatError} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {isNotFoundError} from './k8s_error_utils.js';
import {
  DEFAULT_SANDBOX_TEMPLATE,
  isAbortTimeout,
  SandboxClient,
  SandboxClientFactory,
  SandboxClientOptions,
  SandboxInfrastructureError,
  SandboxRunResult,
  SandboxTimeoutError,
} from './sandbox_client.js';

/** Default router container port, from the public `python-sandbox-template`. */
const DEFAULT_SERVER_PORT = 8888;
/** Default provisioning and per-request budget in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 300;
/** URL scheme used for gateway and in-cluster endpoints. */
const DEFAULT_SCHEME = 'http';

// Agent Sandbox custom resource coordinates (github.com/kubernetes-sigs/agent-sandbox).
const SANDBOX_GROUP = 'agents.x-k8s.io';
const SANDBOX_VERSION = 'v1beta1';
const SANDBOX_PLURAL = 'sandboxes';
const SANDBOX_KIND = 'Sandbox';
const TEMPLATE_GROUP = 'extensions.agents.x-k8s.io';
const TEMPLATE_VERSION = 'v1beta1';
const TEMPLATE_PLURAL = 'sandboxtemplates';
const GATEWAY_GROUP = 'gateway.networking.k8s.io';
const GATEWAY_VERSION = 'v1';
const GATEWAY_PLURAL = 'gateways';

const CREATED_BY_LABEL = 'agents.x-k8s.io/created-by';
const CREATED_BY_VALUE = 'adk-js-client';
const READY_CONDITION_TYPE = 'Ready';
const READY_CONDITION_STATUS = 'True';
const SANDBOX_NAME_PREFIX = 'adk-sandbox-';

// Router HTTP contract, per the public kubernetes-sigs/agent-sandbox client.
const EXECUTE_ENDPOINT = 'execute';
const UPLOAD_ENDPOINT = 'upload';
const UPLOAD_FIELD_NAME = 'file';
const HEADER_SANDBOX_ID = 'X-Sandbox-ID';
const HEADER_SANDBOX_NAMESPACE = 'X-Sandbox-Namespace';
const HEADER_SANDBOX_PORT = 'X-Sandbox-Port';
const HEADER_SANDBOX_POD_IP = 'X-Sandbox-Pod-IP';
const HEADER_SANDBOX_TIMEOUT = 'X-Sandbox-Timeout';
const HEADER_REQUEST_ID = 'X-Request-ID';

// Retry and polling policy (base 500ms, cap 8s, up to 6 attempts for the
// idempotent upload).
const WRITE_MAX_ATTEMPTS = 6;
const RUN_MAX_ATTEMPTS = 1;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;
const POLL_INTERVAL_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([500, 502, 503, 504]);
const HOSTNAME_LABEL_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const MAX_HOSTNAME_LENGTH = 253;

/** The `CustomObjectsApi` operations the sandbox client calls. */
export type SandboxObjectsApi = Pick<
  CustomObjectsApi,
  | 'getNamespacedCustomObject'
  | 'createNamespacedCustomObject'
  | 'deleteNamespacedCustomObject'
>;

/** Options for {@link AgentSandboxClient}. */
export interface AgentSandboxClientOptions extends SandboxClientOptions {
  /** Router container port. Default `8888`. */
  serverPort?: number;
  /** Provisioning and per-request timeout in seconds. Default `300`. */
  timeoutSeconds?: number;
  /**
   * Pre-built custom-objects client. Supplying it skips kubeconfig resolution,
   * which otherwise reads the in-cluster config and then the local one.
   */
  customObjectsApi?: SandboxObjectsApi;
  /** `fetch` implementation for router calls. Injected in tests. */
  fetchFn?: typeof fetch;
}

/** Router connection details discovered during provisioning. */
interface Connection {
  baseUrl: string;
  sandboxName: string;
  namespace: string;
  podIp?: string;
}

/** Minimal shape of a `SandboxTemplate` resource this client reads from. */
interface SandboxTemplateResource {
  spec?: {podTemplate?: unknown; volumeClaimTemplates?: unknown};
}

/** Minimal shape of a `Sandbox` resource this client reads from. */
interface SandboxResource {
  metadata?: {name?: string};
  status?: {
    conditions?: Array<{type?: string; status?: string}>;
    podIPs?: string[];
  };
}

/** Minimal shape of a `Gateway` resource this client reads from. */
interface GatewayResource {
  status?: {addresses?: Array<{value?: string}>};
}

/**
 * Provisions a GKE Agent Sandbox custom resource, routes file and command
 * requests through the sandbox router, and deletes the sandbox on
 * {@link AgentSandboxClient.close}.
 *
 * The behaviour mirrors adk-python's `GkeCodeExecutor` sandbox mode; the wire
 * protocol follows the public `kubernetes-sigs/agent-sandbox` client.
 */
@experimental
export class AgentSandboxClient implements SandboxClient {
  private readonly namespace: string;
  private readonly templateName: string;
  private readonly gatewayName?: string;
  private readonly serverPort: number;
  private readonly timeoutSeconds: number;
  private readonly injectedApi?: SandboxObjectsApi;
  private readonly fetchFn: typeof fetch;

  private api?: SandboxObjectsApi;
  private sandboxName?: string;
  private connection?: Promise<Connection>;

  constructor(options: AgentSandboxClientOptions) {
    this.namespace = options.namespace;
    this.templateName = options.templateName ?? DEFAULT_SANDBOX_TEMPLATE;
    this.gatewayName = options.gatewayName;
    this.serverPort = options.serverPort ?? DEFAULT_SERVER_PORT;
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.injectedApi = options.customObjectsApi;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** Uploads `content` to the sandbox as the plain filename `path`. */
  async write(path: string, content: string): Promise<void> {
    assertPlainFilename(path);
    const connection = await this.ensureConnected();
    const form = new FormData();
    form.append(UPLOAD_FIELD_NAME, new Blob([content]), path);
    await this.sendRouterRequest(
      connection,
      UPLOAD_ENDPOINT,
      form,
      WRITE_MAX_ATTEMPTS,
    );
  }

  /**
   * Runs `command` in the sandbox and returns its output.
   *
   * The `execute` endpoint answers with the `ExecutionResult` shape the
   * reference client models: `stdout`, `stderr` and `exit_code`. A response
   * that omits the status reports none, rather than the reference's `-1`
   * placeholder.
   */
  async run(command: string): Promise<SandboxRunResult> {
    const connection = await this.ensureConnected();
    const response = await this.sendRouterRequest(
      connection,
      EXECUTE_ENDPOINT,
      JSON.stringify({command}),
      RUN_MAX_ATTEMPTS,
    );
    const result = (await response.json()) as {
      stdout?: string;
      stderr?: string;
      exit_code?: number;
    };
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exit_code,
    };
  }

  /** Deletes the provisioned `Sandbox`. Idempotent; never throws. */
  async close(): Promise<void> {
    if (!this.api || !this.sandboxName) {
      return;
    }
    try {
      await this.api.deleteNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: this.namespace,
        plural: SANDBOX_PLURAL,
        name: this.sandboxName,
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      logger.warn(`Failed to delete Sandbox "${this.sandboxName}"`, error);
    }
  }

  /** Provisions the sandbox once and memoizes the resulting connection. */
  private ensureConnected(): Promise<Connection> {
    this.connection ??= this.connect();
    return this.connection;
  }

  private async connect(): Promise<Connection> {
    const api = this.injectedApi ?? (await loadCustomObjectsApi());
    this.api = api;
    const deadline = Date.now() + this.timeoutSeconds * 1000;

    const template = await this.getTemplate(api);
    this.sandboxName = await this.createSandbox(api, template);
    const podIp = await this.waitForReady(api, this.sandboxName, deadline);
    const baseUrl = await this.resolveBaseUrl(api, this.sandboxName, deadline);
    logger.debug(`Agent Sandbox "${this.sandboxName}" ready at ${baseUrl}`);
    return {
      baseUrl,
      sandboxName: this.sandboxName,
      namespace: this.namespace,
      podIp,
    };
  }

  private async getTemplate(
    api: SandboxObjectsApi,
  ): Promise<SandboxTemplateResource> {
    try {
      return await api.getNamespacedCustomObject({
        group: TEMPLATE_GROUP,
        version: TEMPLATE_VERSION,
        namespace: this.namespace,
        plural: TEMPLATE_PLURAL,
        name: this.templateName,
      });
    } catch (error) {
      throw new SandboxInfrastructureError(
        `Failed to get SandboxTemplate "${this.templateName}": ${formatError(error)}`,
      );
    }
  }

  private async createSandbox(
    api: SandboxObjectsApi,
    template: SandboxTemplateResource,
  ): Promise<string> {
    try {
      const created: SandboxResource = await api.createNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: this.namespace,
        plural: SANDBOX_PLURAL,
        body: buildSandboxManifest(template),
      });
      const name = created.metadata?.name;
      if (!name) {
        throw new Error('created Sandbox has no name');
      }
      return name;
    } catch (error) {
      throw new SandboxInfrastructureError(
        `Failed to create Sandbox: ${formatError(error)}`,
      );
    }
  }

  private async waitForReady(
    api: SandboxObjectsApi,
    sandboxName: string,
    deadline: number,
  ): Promise<string | undefined> {
    while (Date.now() < deadline) {
      let sandbox: SandboxResource;
      try {
        sandbox = await api.getNamespacedCustomObject({
          group: SANDBOX_GROUP,
          version: SANDBOX_VERSION,
          namespace: this.namespace,
          plural: SANDBOX_PLURAL,
          name: sandboxName,
        });
      } catch (error) {
        if (isNotFoundError(error)) {
          throw new SandboxInfrastructureError(
            `Sandbox "${sandboxName}" was deleted before becoming ready`,
          );
        }
        throw new SandboxInfrastructureError(
          `Failed to read Sandbox "${sandboxName}": ${formatError(error)}`,
        );
      }
      if (isSandboxReady(sandbox)) {
        return extractPodIp(sandbox);
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new SandboxTimeoutError(
      `Sandbox "${sandboxName}" did not become ready within ${this.timeoutSeconds}s`,
    );
  }

  private async resolveBaseUrl(
    api: SandboxObjectsApi,
    sandboxName: string,
    deadline: number,
  ): Promise<string> {
    if (this.gatewayName) {
      return this.discoverGatewayUrl(api, this.gatewayName, deadline);
    }
    return `${DEFAULT_SCHEME}://${sandboxName}.${this.namespace}.svc.cluster.local:${this.serverPort}`;
  }

  private async discoverGatewayUrl(
    api: SandboxObjectsApi,
    gatewayName: string,
    deadline: number,
  ): Promise<string> {
    let seenGateway = false;
    let lastError: unknown;
    while (Date.now() < deadline) {
      let gateway: GatewayResource;
      try {
        gateway = await api.getNamespacedCustomObject({
          group: GATEWAY_GROUP,
          version: GATEWAY_VERSION,
          namespace: this.namespace,
          plural: GATEWAY_PLURAL,
          name: gatewayName,
        });
      } catch (error) {
        lastError = error;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      seenGateway = true;
      const address = gateway.status?.addresses?.[0]?.value;
      if (address) {
        if (isGatewayAddressValid(address)) {
          return formatBaseUrl(address);
        }
        logger.warn(
          `Rejected address "${address}" for Gateway "${gatewayName}"`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (!seenGateway) {
      throw new SandboxInfrastructureError(
        `Gateway "${gatewayName}" not found in namespace "${this.namespace}": ${formatError(lastError)}`,
      );
    }
    throw new SandboxTimeoutError(
      `Gateway "${gatewayName}" did not report a valid address within ${this.timeoutSeconds}s`,
    );
  }

  private async sendRouterRequest(
    connection: Connection,
    endpoint: string,
    body: FormData | string,
    maxAttempts: number,
  ): Promise<Response> {
    const url = `${connection.baseUrl}/${endpoint}`;
    const deadline = Date.now() + this.timeoutSeconds * 1000;
    const timedOut = `Sandbox request to "${endpoint}" timed out after ${this.timeoutSeconds}s`;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await sleep(backoffDelayMs(attempt));
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new SandboxTimeoutError(timedOut);
      }

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: 'POST',
          body,
          headers: buildRouterHeaders(
            connection,
            this.serverPort,
            remainingMs,
            body,
          ),
          redirect: 'manual',
          signal: AbortSignal.timeout(remainingMs),
        });
      } catch (error) {
        if (isAbortTimeout(error)) {
          throw new SandboxTimeoutError(timedOut);
        }
        lastError = error;
        continue;
      }

      if (isRedirect(response)) {
        throw new SandboxInfrastructureError(
          `Sandbox router returned an unexpected redirect (status ${response.status}) for "${endpoint}"`,
        );
      }
      if (RETRYABLE_STATUS_CODES.has(response.status)) {
        lastError = new Error(`router returned status ${response.status}`);
        continue;
      }
      if (!response.ok) {
        throw new SandboxInfrastructureError(
          `Sandbox router returned status ${response.status} for "${endpoint}"`,
        );
      }
      return response;
    }

    throw new SandboxInfrastructureError(
      `Sandbox request to "${endpoint}" failed after ${maxAttempts} attempts: ${formatError(lastError)}`,
    );
  }
}

/** Factory used as {@link GkeCodeExecutor}'s default when none is injected. */
export const defaultSandboxClientFactory: SandboxClientFactory = (options) =>
  new AgentSandboxClient(options);

/**
 * Builds a custom-objects client from the in-cluster config, falling back to
 * the local kubeconfig.
 */
async function loadCustomObjectsApi(): Promise<SandboxObjectsApi> {
  const {CustomObjectsApi: CustomObjects, KubeConfig} = await loadOptionalPeer(
    {packageName: '@kubernetes/client-node', feature: 'AgentSandboxClient'},
    () => import('@kubernetes/client-node'),
  );
  const kubeConfig = new KubeConfig();
  try {
    kubeConfig.loadFromCluster();
    return kubeConfig.makeApiClient(CustomObjects);
  } catch (clusterError) {
    logger.debug(
      'In-cluster Kubernetes config unavailable; trying local kubeconfig',
      clusterError,
    );
  }
  try {
    kubeConfig.loadFromDefault();
  } catch (defaultError) {
    throw new SandboxInfrastructureError(
      `Failed to load Kubernetes configuration: ${formatError(defaultError)}`,
    );
  }
  return kubeConfig.makeApiClient(CustomObjects);
}

/** Builds the `Sandbox` manifest, copying the pod template from `template`. */
function buildSandboxManifest(template: SandboxTemplateResource) {
  const podTemplate = template.spec?.podTemplate;
  if (!podTemplate) {
    throw new SandboxInfrastructureError(
      'SandboxTemplate is missing spec.podTemplate',
    );
  }
  const spec: {podTemplate: unknown; volumeClaimTemplates?: unknown} = {
    podTemplate,
  };
  if (template.spec?.volumeClaimTemplates) {
    spec.volumeClaimTemplates = template.spec.volumeClaimTemplates;
  }
  return {
    apiVersion: `${SANDBOX_GROUP}/${SANDBOX_VERSION}`,
    kind: SANDBOX_KIND,
    metadata: {
      generateName: SANDBOX_NAME_PREFIX,
      labels: {[CREATED_BY_LABEL]: CREATED_BY_VALUE},
    },
    spec,
  };
}

/** Returns whether the sandbox has a `Ready=True` status condition. */
function isSandboxReady(sandbox: SandboxResource): boolean {
  return (sandbox.status?.conditions ?? []).some(
    (condition) =>
      condition.type === READY_CONDITION_TYPE &&
      condition.status === READY_CONDITION_STATUS,
  );
}

/** Returns the first valid pod IP from the sandbox status, if any. */
function extractPodIp(sandbox: SandboxResource): string | undefined {
  const podIp = sandbox.status?.podIPs?.[0];
  return podIp && isIP(podIp) !== 0 ? podIp : undefined;
}

/** Rejects addresses with URL metacharacters or non-IP, non-hostname values. */
function isGatewayAddressValid(value: string): boolean {
  if (/[/?#@]/.test(value)) {
    return false;
  }
  return isIP(value) !== 0 || isValidHostname(value);
}

/** Validates a DNS-1123 hostname: no empty labels, no leading or trailing dash. */
function isValidHostname(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HOSTNAME_LENGTH) {
    return false;
  }
  return value.split('.').every((label) => HOSTNAME_LABEL_PATTERN.test(label));
}

/** Builds `http://host` or `http://[ipv6]` from a validated gateway address. */
function formatBaseUrl(address: string): string {
  return isIP(address) === 6
    ? `${DEFAULT_SCHEME}://[${address}]`
    : `${DEFAULT_SCHEME}://${address}`;
}

/**
 * Builds the routing headers required for every router request. A `FormData`
 * body is left without a `Content-Type` so `fetch` can add the multipart
 * boundary itself.
 */
function buildRouterHeaders(
  connection: Connection,
  serverPort: number,
  remainingMs: number,
  body: FormData | string,
): Record<string, string> {
  const headers: Record<string, string> = {
    [HEADER_SANDBOX_ID]: connection.sandboxName,
    [HEADER_SANDBOX_NAMESPACE]: connection.namespace,
    [HEADER_SANDBOX_PORT]: String(serverPort),
    [HEADER_SANDBOX_TIMEOUT]: (remainingMs / 1000).toString(),
    [HEADER_REQUEST_ID]: randomUUID(),
  };
  if (connection.podIp) {
    headers[HEADER_SANDBOX_POD_IP] = connection.podIp;
  }
  if (typeof body === 'string') {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/** Exponential backoff with jitter (base 500ms, cap 8s); attempt 0 has no delay. */
function backoffDelayMs(attempt: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return base + Math.random() * (base / 2) - base / 4;
}

/** Throws unless `path` is a plain filename, with no separators and not `.` or `..`. */
function assertPlainFilename(path: string): void {
  if (path === '' || path === '.' || path === '..' || path.includes('/')) {
    throw new Error(
      `Invalid sandbox file path "${path}": expected a plain filename without directory separators`,
    );
  }
}

/**
 * Returns whether a fetch response is an HTTP redirect. With
 * `redirect: 'manual'` Node hands back the real 3xx response, not the browser's
 * opaque-redirect placeholder, so the status is the only thing to read.
 */
function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
