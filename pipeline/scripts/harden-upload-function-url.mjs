import fs from 'node:fs';

const [templatePath] = process.argv.slice(2);
if (!templatePath) {
  console.error('Usage: node scripts/harden-upload-function-url.mjs <template.yaml>');
  process.exit(2);
}

const original = fs.readFileSync(templatePath, 'utf8');
const start = original.indexOf('\n  UploadFunction:\n');
const end = original.indexOf('\n  MediaFunction:\n');

if (start < 0 || end < 0 || end <= start) {
  throw new Error('Could not locate UploadFunction/MediaFunction boundaries in SAM template');
}

const before = original.slice(0, start);
const uploadSection = original.slice(start, end);
const after = original.slice(end);

const noneMatches = uploadSection.match(/AuthType: NONE/g) || [];
if (noneMatches.length !== 1) {
  throw new Error(`Expected exactly one upload AuthType: NONE, found ${noneMatches.length}`);
}

let hardened = uploadSection.replace('AuthType: NONE', 'AuthType: AWS_IAM');

for (const logicalId of ['UploadUrlPermission', 'UploadInvokePermission']) {
  const block = new RegExp(`\\n  ${logicalId}:\\n[\\s\\S]*?(?=\\n  [A-Za-z0-9]+:|$)`);
  if (!block.test(hardened)) throw new Error(`Expected ${logicalId} in upload section`);
  hardened = hardened.replace(block, '');
}

if (/Principal:\s*['\"]?\*['\"]?/.test(hardened)) {
  throw new Error('Public principal remains in hardened upload section');
}
if (!/AuthType: AWS_IAM/.test(hardened)) {
  throw new Error('AWS_IAM auth was not applied to upload Function URL');
}

fs.writeFileSync(templatePath, before + hardened + after);
