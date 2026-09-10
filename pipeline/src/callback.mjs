import { randomUUID } from 'node:crypto';

let ddbClient;
let ddbCommands;
let sfnClient;
let sfnCommands;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

function parseBody(event) {
  const raw = event?.body
    ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body)
    : '{}';
  return JSON.parse(raw);
}

export function callbackIdFromPath(path) {
  const match = String(path || '').match(/^\/recordings\/callback\/([a-f0-9]{64})\/?$/i);
  return match?.[1]?.toLowerCase() || null;
}

export function sanitizeCallbackOutput(body, recordingId) {
  const output = {
    recordingId,
    status: body.status,
  };

  for (const key of ['source', 'filename', 'processedAt', 'oneDrivePath', 'oneNotePage']) {
    if (body[key] !== undefined && body[key] !== null) {
      output[key] = String(body[key]).slice(0, 1024);
    }
  }
  if (body.error !== undefined && body.error !== null) {
    output.error = String(body.error).slice(0, 2048);
  }
  return output;
}

async function getDynamoDb() {
  if (!ddbClient) {
    const module = await import('@aws-sdk/client-dynamodb');
    ddbCommands = module;
    ddbClient = new module.DynamoDBClient({});
  }
  return { client: ddbClient, commands: ddbCommands };
}

async function getStepFunctions() {
  if (!sfnClient) {
    const module = await import('@aws-sdk/client-sfn');
    sfnCommands = module;
    sfnClient = new module.SFNClient({});
  }
  return { client: sfnClient, commands: sfnCommands };
}

async function fetchCallback(callbackId) {
  const { client, commands } = await getDynamoDb();
  const result = await client.send(new commands.GetItemCommand({
    TableName: process.env.CALLBACK_TABLE,
    Key: { callbackId: { S: callbackId } },
    ConsistentRead: true,
  }));
  return result.Item || null;
}

async function claimCallback(callbackId, completionId, nowEpoch) {
  const { client, commands } = await getDynamoDb();
  const result = await client.send(new commands.UpdateItemCommand({
    TableName: process.env.CALLBACK_TABLE,
    Key: { callbackId: { S: callbackId } },
    UpdateExpression: 'SET #status = :completing, completionId = :completionId, callbackReceivedAt = :receivedAt',
    ConditionExpression: '#status = :pending AND expiresAtEpoch >= :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':pending': { S: 'PENDING' },
      ':completing': { S: 'COMPLETING' },
      ':completionId': { S: completionId },
      ':receivedAt': { S: new Date(nowEpoch * 1000).toISOString() },
      ':now': { N: String(nowEpoch) },
    },
    ReturnValues: 'ALL_NEW',
  }));
  return result.Attributes;
}

async function finalizeCallback(callbackId, completionId, status) {
  const { client, commands } = await getDynamoDb();
  await client.send(new commands.UpdateItemCommand({
    TableName: process.env.CALLBACK_TABLE,
    Key: { callbackId: { S: callbackId } },
    UpdateExpression: 'SET #status = :status, completedAt = :completedAt REMOVE taskToken',
    ConditionExpression: 'completionId = :completionId',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': { S: status },
      ':completedAt': { S: new Date().toISOString() },
      ':completionId': { S: completionId },
    },
  }));
}

async function rollbackClaim(callbackId, completionId) {
  const { client, commands } = await getDynamoDb();
  await client.send(new commands.UpdateItemCommand({
    TableName: process.env.CALLBACK_TABLE,
    Key: { callbackId: { S: callbackId } },
    UpdateExpression: 'SET #status = :pending REMOVE completionId, callbackReceivedAt',
    ConditionExpression: '#status = :completing AND completionId = :completionId',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':pending': { S: 'PENDING' },
      ':completing': { S: 'COMPLETING' },
      ':completionId': { S: completionId },
    },
  }));
}

async function expireCallback(callbackId) {
  const { client, commands } = await getDynamoDb();
  try {
    await client.send(new commands.UpdateItemCommand({
      TableName: process.env.CALLBACK_TABLE,
      Key: { callbackId: { S: callbackId } },
      UpdateExpression: 'SET #status = :expired, completedAt = :completedAt REMOVE taskToken',
      ConditionExpression: '#status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':pending': { S: 'PENDING' },
        ':expired': { S: 'EXPIRED' },
        ':completedAt': { S: new Date().toISOString() },
      },
    }));
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') throw error;
  }
}

async function releaseStepFunction(taskToken, output) {
  const { client, commands } = await getStepFunctions();
  if (output.status === 'success') {
    await client.send(new commands.SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify(output),
    }));
    return 'SUCCEEDED';
  }

  await client.send(new commands.SendTaskFailureCommand({
    taskToken,
    error: 'DownstreamIntegrationFailed',
    cause: String(output.error || 'Downstream consumer reported failure').slice(0, 2048),
  }));
  return 'FAILED';
}

function itemString(item, name) {
  return item?.[name]?.S || '';
}

function itemNumber(item, name) {
  return Number(item?.[name]?.N || 0);
}

export function isTerminal(status) {
  return ['SUCCEEDED', 'FAILED', 'DELIVERY_FAILED', 'EXPIRED'].includes(status);
}

function isExpiredTaskTokenError(error) {
  return ['TaskTimedOut', 'InvalidToken', 'TaskDoesNotExist'].includes(error?.name);
}

function productionDependencies() {
  return {
    fetchCallback,
    claimCallback,
    finalizeCallback,
    rollbackClaim,
    expireCallback,
    releaseStepFunction,
  };
}

export async function processCallback({ callbackId, body, completionId, nowEpoch }, dependencies = productionDependencies()) {
  const item = await dependencies.fetchCallback(callbackId);
  if (!item) return { statusCode: 404, payload: { error: 'unknown_callback' } };

  const recordingId = itemString(item, 'recordingId');
  if (body.recordingId && String(body.recordingId) !== recordingId) {
    return { statusCode: 409, payload: { error: 'recording_mismatch' } };
  }

  const currentStatus = itemString(item, 'status');
  if (isTerminal(currentStatus)) {
    return {
      statusCode: 200,
      payload: { ok: true, duplicate: true, status: currentStatus.toLowerCase() },
    };
  }
  if (currentStatus === 'COMPLETING') {
    return { statusCode: 202, payload: { ok: true, duplicate: true, status: 'completing' } };
  }

  if (itemNumber(item, 'expiresAtEpoch') < nowEpoch) {
    await dependencies.expireCallback(callbackId);
    return { statusCode: 410, payload: { error: 'callback_expired' } };
  }

  let claimed;
  try {
    claimed = await dependencies.claimCallback(callbackId, completionId, nowEpoch);
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      const latest = await dependencies.fetchCallback(callbackId);
      const latestStatus = itemString(latest, 'status');
      if (isTerminal(latestStatus)) {
        return {
          statusCode: 200,
          payload: { ok: true, duplicate: true, status: latestStatus.toLowerCase() },
        };
      }
      return { statusCode: 409, payload: { error: 'callback_not_available' } };
    }
    throw error;
  }

  const taskToken = itemString(claimed, 'taskToken');
  if (!taskToken) {
    await dependencies.finalizeCallback(callbackId, completionId, 'EXPIRED');
    return { statusCode: 410, payload: { error: 'callback_expired' } };
  }

  const output = sanitizeCallbackOutput(body, recordingId);
  try {
    const terminalStatus = await dependencies.releaseStepFunction(taskToken, output);
    await dependencies.finalizeCallback(callbackId, completionId, terminalStatus);
    console.info('Recording callback completed', { recordingId, status: terminalStatus });
    return { statusCode: 200, payload: { ok: true, status: terminalStatus.toLowerCase() } };
  } catch (error) {
    if (isExpiredTaskTokenError(error)) {
      await dependencies.finalizeCallback(callbackId, completionId, 'EXPIRED');
      console.warn('Recording callback arrived after Step Functions task expired', { recordingId });
      return { statusCode: 410, payload: { error: 'callback_expired' } };
    }

    try {
      await dependencies.rollbackClaim(callbackId, completionId);
    } catch (rollbackError) {
      console.error('Unable to release callback claim after Step Functions error', {
        recordingId,
        error: rollbackError.name,
      });
    }
    console.error('Unable to resume Step Functions callback task', { recordingId, error: error.name });
    return { statusCode: 503, payload: { error: 'callback_retry_required' } };
  }
}

export async function handler(event, context = {}) {
  const method = event?.requestContext?.http?.method || 'GET';
  const callbackId = callbackIdFromPath(event?.rawPath);
  if (method === 'GET' && event?.rawPath === '/healthz') {
    return json(200, { ok: true, service: 'recordings-callback' });
  }
  if (method !== 'POST' || !callbackId) return json(404, { error: 'not_found' });

  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  if (!['success', 'failed'].includes(body?.status)) {
    return json(400, { error: 'invalid_status' });
  }

  const result = await processCallback({
    callbackId,
    body,
    completionId: String(context.awsRequestId || randomUUID()),
    nowEpoch: Math.floor(Date.now() / 1000),
  });
  return json(result.statusCode, result.payload);
}
