const fs = require('fs');

const files = [
  'core/test/runner/runner_test.ts',
  'core/test/sessions/vertex_ai_session_service_test.ts',
  'tests/integration/context_compaction/agent_controlled/agent_test.ts',
  'tests/integration/context_compaction/anchored/agent_test.ts',
  'tests/e2e/routing/lro_resumption_routing_e2e_test.ts'
];

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  
  content = content.replace(/(createSession|getSession|deleteSession|listSessions|getOrCreateSession)\(\{\s*appName:\s*([^,]+),\s*userId:\s*([^,]+),\s*sessionId:\s*([^,\}]+)(,)?/g, 
    '$1({ scope: { appName: $2, userId: $3, sessionId: $4 }$5');
    
  content = content.replace(/(createSession|getSession|deleteSession|listSessions|getOrCreateSession)\(\{\s*appName:\s*([^,]+),\s*userId:\s*([^,\}]+)(,)?/g, 
    '$1({ scope: { appName: $2, userId: $3 }$4');
    
  fs.writeFileSync(file, content, 'utf8');
});
console.log('Done');
