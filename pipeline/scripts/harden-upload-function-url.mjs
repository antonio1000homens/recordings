import fs from 'node:fs';

const [templatePath] = process.argv.slice(2);
if (!templatePath) {
  console.error('Usage: node scripts/harden-upload-function-url.mjs <template.yaml>');
  process.exit(2);
}

const PUBLIC_CALLBACK_BASE_URL = 'https://recordings.alf-broadcast.co.uk/';
const original = fs.readFileSync(templatePath, 'utf8');

function hardenSection(source, {
  startLogicalId,
  endLogicalId,
  permissionLogicalIds,
  label,
}) {
  const start = source.indexOf(`\n  ${startLogicalId}:\n`);
  const end = source.indexOf(`\n  ${endLogicalId}:\n`);

  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Could not locate ${startLogicalId}/${endLogicalId} boundaries in SAM template`);
  }

  const before = source.slice(0, start);
  let section = source.slice(start, end);
  const after = source.slice(end);

  const noneMatches = section.match(/^\s+AuthType: NONE$/gm) || [];
  if (noneMatches.length !== 1) {
    throw new Error(`Expected exactly one ${label} AuthType: NONE, found ${noneMatches.length}`);
  }

  section = section.replace(/^\s+AuthType: NONE$/m, '        AuthType: AWS_IAM');

  for (const logicalId of permissionLogicalIds) {
    const block = new RegExp(`\\n  ${logicalId}:\\n[\\s\\S]*?(?=\\n  [A-Za-z0-9]+:|$)`);
    if (!block.test(section)) throw new Error(`Expected ${logicalId} in ${label} section`);
    section = section.replace(block, '');
  }

  if (/Principal:\s*['\"]?\*['\"]?/.test(section)) {
    throw new Error(`Public principal remains in hardened ${label} section`);
  }
  if (!/^\s+AuthType: AWS_IAM$/m.test(section)) {
    throw new Error(`AWS_IAM auth was not applied to ${label} Function URL`);
  }

  return before + section + after;
}

let hardened = hardenSection(original, {
  startLogicalId: 'UploadFunction',
  endLogicalId: 'MediaFunction',
  permissionLogicalIds: ['UploadUrlPermission', 'UploadInvokePermission'],
  label: 'upload',
});

hardened = hardenSection(hardened, {
  startLogicalId: 'CallbackFunction',
  endLogicalId: 'DeliveryFunction',
  permissionLogicalIds: ['CallbackUrlPermission', 'CallbackInvokePermission'],
  label: 'callback',
});

const callbackBasePattern = /^\s+CALLBACK_BASE_URL: !GetAtt CallbackFunctionUrl\.FunctionUrl$/m;
if (!callbackBasePattern.test(hardened)) {
  throw new Error('Expected DeliveryFunction CALLBACK_BASE_URL to reference CallbackFunctionUrl');
}
hardened = hardened.replace(
  callbackBasePattern,
  `          CALLBACK_BASE_URL: ${PUBLIC_CALLBACK_BASE_URL}`,
);

if (!hardened.includes(`CALLBACK_BASE_URL: ${PUBLIC_CALLBACK_BASE_URL}`)) {
  throw new Error('Public Cloudflare callback base URL was not applied');
}

fs.writeFileSync(templatePath, hardened);
