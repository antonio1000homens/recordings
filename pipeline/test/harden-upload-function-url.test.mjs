import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = new URL('../scripts/harden-upload-function-url.mjs', import.meta.url);

function runTransform(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recordings-upload-hardening-'));
  const file = path.join(dir, 'template.yaml');
  fs.writeFileSync(file, source);
  execFileSync(process.execPath, [script.pathname, file]);
  return fs.readFileSync(file, 'utf8');
}

test('hardens only upload Function URL and removes public upload permissions', () => {
  const input = `Resources:\n  UploadFunction:\n    Type: AWS::Serverless::Function\n    Properties:\n      FunctionUrlConfig:\n        AuthType: NONE\n        InvokeMode: BUFFERED\n\n  UploadUrlPermission:\n    Type: AWS::Lambda::Permission\n    Properties:\n      Principal: '*'\n      Action: lambda:InvokeFunctionUrl\n      FunctionUrlAuthType: NONE\n\n  UploadInvokePermission:\n    Type: AWS::Lambda::Permission\n    Properties:\n      Principal: '*'\n      Action: lambda:InvokeFunction\n      InvokedViaFunctionUrl: true\n\n  MediaFunction:\n    Type: AWS::Serverless::Function\n\n  CallbackFunction:\n    Type: AWS::Serverless::Function\n    Properties:\n      FunctionUrlConfig:\n        AuthType: NONE\n`;

  const output = runTransform(input);
  assert.match(output, /UploadFunction:[\s\S]*AuthType: AWS_IAM/);
  assert.doesNotMatch(output, /UploadUrlPermission:/);
  assert.doesNotMatch(output, /UploadInvokePermission:/);
  assert.match(output, /CallbackFunction:[\s\S]*AuthType: NONE/);
});

test('fails closed when the expected upload permission resources are missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recordings-upload-hardening-'));
  const file = path.join(dir, 'template.yaml');
  fs.writeFileSync(file, `Resources:\n  UploadFunction:\n    Properties:\n      FunctionUrlConfig:\n        AuthType: NONE\n\n  MediaFunction:\n    Type: AWS::Serverless::Function\n`);

  assert.throws(() => execFileSync(process.execPath, [script.pathname, file], { stdio: 'pipe' }));
});
