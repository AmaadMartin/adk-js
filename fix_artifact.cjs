const fs = require('fs');

let file = 'core/test/artifacts/artifact_service_test_utils.ts';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/appName,\s*userId,\s*sessionId,\s*/g, 'scope,\n');
content = content.replace(/\.\.\.sessionKey,/g, 'scope: sessionKey,');
content = content.replace(/listArtifactKeys\(sessionKey\)/g, 'listArtifactKeys({scope: sessionKey})');

fs.writeFileSync(file, content, 'utf8');
console.log('Fixed');
