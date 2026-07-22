const fs = require('fs');

function fixFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/appName:([^,]+),\s*userId:([^,]+),\s*sessionId:([^,]+),?/g, 'scope: {appName:$1, userId:$2, sessionId:$3},');
  content = content.replace(/appName:([^,]+),\s*userId:([^,]+),/g, 'scope: {appName:$1, userId:$2},');
  fs.writeFileSync(filePath, content, 'utf8');
}

const files = [
  'core/test/runner/runner_test.ts',
  'core/test/sessions/vertex_ai_session_service_test.ts',
  'tests/integration/context_compaction/agent_controlled/agent_test.ts',
  'tests/integration/context_compaction/anchored/agent_test.ts'
];

files.forEach(fixFile);
console.log('Fixed');
