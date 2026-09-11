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

function resourceSection(source, logicalId) {
  const start = source.indexOf(`\n  ${logicalId}:\n`);
  if (start < 0) throw new Error(`Could not locate ${logicalId} in SAM template`);

  const tail = source.slice(start + 1);
  const nextResource = tail.match(/^  [A-Za-z0-9]+:\s*$/m);
  if (!nextResource || nextResource.index === 0) {
    const afterHeader = tail.indexOf('\n');
    const searchFrom = afterHeader >= 0 ? afterHeader + 1 : tail.length;
    const remaining = tail.slice(searchFrom);
    const next = remaining.match(/^  [A-Za-z0-9]+:\s*$/m);
    const end = next ? start + 1 + searchFrom + next.index : source.length;
    return { start, end, section: source.slice(start, end) };
  }

  const end = start + 1 + nextResource.index;
  return { start, end, section: source.slice(start, end) };
}

function replaceCallbackBaseUrl(source) {
  const { start, end, section: originalSection } = resourceSection(source, 'DeliveryFunction');
  let section = originalSection;

  const callbackBaseBlock = /^\s+CALLBACK_BASE_URL:\s*(?:.*\n(?:\s{12,}.*\n)*)?/m;
  const matches = section.match(/^\s+CALLBACK_BASE_URL:/gm) || [];
  if (matches.length !== 1 || !callbackBaseBlock.test(section)) {
    throw new Error(`Expected exactly one DeliveryFunction CALLBACK_BASE_URL property, found ${matches.length}`);
  }

  section = section.replace(
    callbackBaseBlock,
    `          CALLBACK_BASE_URL: ${PUBLIC_CALLBACK_BASE_URL}\n`,
  );

  if (!section.includes(`CALLBACK_BASE_URL: ${PUBLIC_CALLBACK_BASE_URL}`)) {
    throw new Error('Public Cloudflare callback base URL was not applied');
  }

  return source.slice(0, start) + section + source.slice(end);
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

hardened = replaceCallbackBaseUrl(hardened);

fs.writeFileSync(templatePath, hardened);
