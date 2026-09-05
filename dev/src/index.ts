/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  ServiceRegistry,
  getServiceRegistry,
  loadServicesModule,
  registerBuiltinServices,
} from './cli/service_registry.js';
export type {
  DeclaredServiceOptions,
  ServiceFactory,
  ServiceFactoryOptions,
  ServiceType,
} from './cli/service_registry.js';
export {AdkApiClient} from './server/adk_api_client.js';
export {AdkApiServer} from './server/adk_api_server.js';
