import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = new URL('../scripts/harden-upload-function-url.mjs', import.meta.url);

function runTransform(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recordings-function-url-hardening-'));
  const file = path.join(dir, 'template.yaml');
  fs.writeFileSync(file, source);
  execFileSync(process.execPath, [script.pathname, file]);
  return fs.readFileSync(file, 'utf8');
}

function templateFixture(callbackBase = '!GetAtt CallbackFunctionUrl.FunctionUrl') {
  return `Resources:\n  UploadFunction:\n    Type: AWS::Serverless::Function\n    Properties:\n      FunctionUrlConfig:\n        AuthType: NONE\n        InvokeMode: BUFFERED\n\n  UploadUrlPermission:\n    Type: AWS::Lambda::Permission\n    Properties:\n      Principal: '*'\n      Action: lambda:InvokeFunctionUrl\n      FunctionUrlAuthType: NONE\n\n  UploadInvokePermission:\n    Type: AWS::Lambda::Permission\n    Properties:\n      Principal: '*'\n      Action: lambda:InvokeFunction\n      InvokedViaFunctionUrl: true\n\n  MediaFunction:\n    Type: AWS::Serverless::Function\n\n  CallbackFunction:\n    Type: AWS::Serverless::Function\n    Properties:\n      FunctionUrlConfig:\n        AuthType: NONE\n\n  CallbackUrlPermission:\n    Type: AWS::Lambda::Permission\n    Properties:\n      Principal: '*'\n      Action: lambda:InvokeFunctionUrl\n      FunctionUrlAuthType: NONE\n\n  CallbackInvokePermission:\n    Type: AWS::Lambda::Permission\n    Properties:\n      Principal: '*'\n      Action: lambda:InvokeFunction\n      InvokedViaFunctionUrl: true\n\n  DeliveryFunction:\n    Type: AWS::Serverless::Function\n    Properties:\n      Environment:\n        Variables:\n          CALLBACK_BASE_URL: ${callbackBase}\n\n  CallbackTable:\n    Type: AWS::DynamoDB::Table\n`;
}

test('hardens upload and callback Function URLs and removes public permissions', () => {
  const output = runTransform(templateFixture());
  assert.match(output, /UploadFunction:[\s\S]*AuthType: AWS_IAM/);
  assert.match(output, /CallbackFunction:[\s\S]*AuthType: AWS_IAM/);
  assert.doesNotMatch(output, /UploadUrlPermission:/);
  assert.doesNotMatch(output, /UploadInvokePermission:/);
  assert.doesNotMatch(output, /CallbackUrlPermission:/);
  assert.doesNotMatch(output, /CallbackInvokePermission:/);
  assert.match(output, /CALLBACK_BASE_URL: https:\/\/recordings\.alf-broadcast\.co\.uk\//);
});

test('accepts SAM-built long-form callback base URL serialization', () => {
  const input = templateFixture('').replace(
    '          CALLBACK_BASE_URL: \n',
    '          CALLBACK_BASE_URL:\n            Fn::GetAtt:\n              - CallbackFunctionUrl\n              - FunctionUrl\n',
  );
  const output = runTransform(input);
  assert.match(output, /CALLBACK_BASE_URL: https:\/\/recordings\.alf-broadcast\.co\.uk\//);
  assert.doesNotMatch(output, /Fn::GetAtt:[\s\S]*CallbackFunctionUrl/);
});

test('fails closed when expected public callback permissions are missing', () => {
  const input = templateFixture().replace(/\n  CallbackUrlPermission:[\s\S]*?(?=\n  CallbackInvokePermission:)/, '');
  assert.throws(() => runTransform(input));
});

test('fails closed when DeliveryFunction callback base is absent', () => {
  const input = templateFixture().replace(/^\s+CALLBACK_BASE_URL:.*\n/m, '');
  assert.throws(() => runTransform(input));
});
