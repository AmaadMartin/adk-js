# OpenAPI Toolset (`openapi_tool`) — ADK TypeScript (`v0.1.0` Parity)

The `openapi_tool` subsystem automatically converts OpenAPI v3 specifications (JSON or YAML) into executable `RestApiTool` instances that an ADK `LlmAgent` can invoke directly.

## Architecture & Modules (`v0.1.0` Parity)

| Python Reference (`v0.1.0`) | TypeScript Module (`adk-js`) | Description |
| :--- | :--- | :--- |
| `openapi_spec_parser/openapi_toolset.py` | `core/src/tools/openapi_tool/openapi_toolset.ts` | High-level `OpenAPIToolset` entry point (`getTools()`, `getTool(name)`, `close()`). |
| `openapi_spec_parser/rest_api_tool.py` | `core/src/tools/openapi_tool/rest_api_tool.ts` | `RestApiTool` wrapping a single parsed OpenAPI operation with parameter serialization and auth execution. |
| `openapi_spec_parser/openapi_spec_parser.py` | `core/src/tools/openapi_tool/openapi_spec_parser/openapi_spec_parser.ts` | `OpenApiSpecParser` resolving `$ref` pointers, servers, security schemes, and operations. |
| `openapi_spec_parser/operation_parser.py` | `core/src/tools/openapi_tool/openapi_spec_parser/operation_parser.ts` | `OperationParser` extracting `ApiParameter` args, return types, JSON schemas, and docstrings. |
| `openapi_spec_parser/tool_auth_handler.py` | `core/src/tools/openapi_tool/openapi_spec_parser/tool_auth_handler.ts` | `ToolAuthHandler` managing multi-step OAuth2/API-key/Service-Account credential preparation. |
| `auth/auth_helpers.py` | `core/src/tools/openapi_tool/auth/auth_helpers.ts` | Helper builders for `AuthScheme` and `AuthCredential` (`tokenToSchemeCredential`, `serviceAccountDictToSchemeCredential`, `openidUrlToSchemeCredential`). |
| `auth/credential_exchangers/base_credential_exchanger.py` | `core/src/tools/openapi_tool/auth/credential_exchangers/base_credential_exchanger.ts` | Abstract `BaseAuthCredentialExchanger` base class and `AuthCredentialMissingError`. |
| `auth/credential_exchangers/auto_auth_credential_exchanger.py` | `core/src/tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.ts` | `AutoAuthCredentialExchanger` dispatching across OAuth2, Service Account, and HTTP credentials. |
| `auth/credential_exchangers/oauth2_exchanger.py` | `core/src/tools/openapi_tool/auth/credential_exchangers/oauth2_exchanger.ts` | `OAuth2CredentialExchanger` exchanging OAuth2/OIDC tokens into HTTP Bearer credentials. |
| `auth/credential_exchangers/service_account_exchanger.py` | `core/src/tools/openapi_tool/auth/credential_exchangers/service_account_exchanger.ts` | `ServiceAccountCredentialExchanger` exchanging Google Service Account & ADC credentials. |
| `common/common.py` | `core/src/tools/openapi_tool/common/common.ts` | `ApiParameter`, `TypeHintHelper`, `PydocHelper`, `toSnakeCase`, and `renamePythonKeywords`. |

## Quick Start

```typescript
import {OpenAPIToolset, tokenToSchemeCredential} from '@google/adk';

const {authScheme, authCredential} = tokenToSchemeCredential(
  'apikey',
  'header',
  'X-API-Key',
  process.env.PETSTORE_API_KEY ?? 'demo-key',
);

const toolset = new OpenAPIToolset({
  specStr: openApiYamlString,
  specStrType: 'yaml',
  authScheme,
  authCredential,
});

const listPetsTool = toolset.getTool('list_pets');
const allTools = await toolset.getTools();
```
