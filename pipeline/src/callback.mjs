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

function callbackIdFromPath(path) {
  const match = String(path || '').match(/^\/recordings\/callback\/([a-f0-9]{64})\/?$/i);
  return match?.[1]?.toLowerCase() || null;
}

function sanitizeCallbackOutput(body, recordingId) {
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

function isTerminal(status) {
  return ['SUCCEEDED', 'FAILED', 'DELIVERY_FAILED', 'EXPIRED'].includes(status);
}

function isExpiredTaskTokenError(error) {
  return ['TaskTimedOut', 'InvalidToken', 'TaskDoesNotExist'].includes(error?.name);
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

  const item = await fetchCallback(callbackId);
  if (!item) return json(404, { error: 'unknown_callback' });

  const recordingId = itemString(item, 'recordingId');
  if (body.recordingId && String(body.recordingId) !== recordingId) {
    return json(409, { error: 'recording_mismatch' });
  }

  const currentStatus = itemString(item, 'status');
  if (isTerminal(currentStatus)) {
    return json(200, { ok: true, duplicate: true, status: currentStatus.toLowerCase() });
  }
  if (currentStatus === 'COMPLETING') {
    return json(202, { ok: true, duplicate: true, status: 'completing' });
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  if (itemNumber(item, 'expiresAtEpoch') < nowEpoch) {
    await expireCallback(callbackId);
    return json(410, { error: 'callback_expired' });
  }

  const completionId = String(context.awsRequestId || cryptoRandomFallback());
  let claimed;
  try {
    claimed = await claimCallback(callbackId, completionId, nowEpoch);
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      const latest = await fetchCallback(callbackId);
      const latestStatus = itemString(latest, 'status');
      if (isTerminal(latestStatus)) {
        return json(200, { ok: true, duplicate: true, status: latestStatus.toLowerCase() });
      }
      return json(409, { error: 'callback_not_available' });
    }
    throw error;
  }

  const taskToken = itemString(claimed, 'taskToken');
  if (!taskToken) {
    await finalizeCallback(callbackId, completionId, 'EXPIRED');
    return json(410, { error: 'callback_expired' });
  }

  const output = sanitizeCallbackOutput(body, recordingId);
  try {
    const terminalStatus = await releaseStepFunction(taskToken, output);
    await finalizeCallback(callbackId, completionId, terminalStatus);
    console.info('Recording callback completed', { callbackId, recordingId, status: terminalStatus });
    return json(200, { ok: true, status: terminalStatus.toLowerCase() });
  } catch (error) {
    if (isExpiredTaskTokenError(error)) {
      await finalizeCallback(callbackId, completionId, 'EXPIRED');
      console.warn('Recording callback arrived after Step Functions task expired', { callbackId, recordingId });
      return json(410, { error: 'callback_expired' });
    }

    try {
      await rollbackClaim(callbackId, completionId);
    } catch (rollbackError) {
      console.error('Unable to release callback claim after Step Functions error', {
        callbackId,
        recordingId,
        error: rollbackError.name,
      });
    }
    console.error('Unable to resume Step Functions callback task', { callbackId, recordingId, error: error.name });
    return json(503, { error: 'callback_retry_required' });
  }
}

function cryptoRandomFallback() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
