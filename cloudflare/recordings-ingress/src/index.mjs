import { AwsClient } from 'aws4fetch';

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function constantTimeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a || ''));
  const bb = new TextEncoder().encode(String(b || ''));
  if (!aa.length || aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i += 1) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') return json(200, { ok: true, service: 'recordings-ingress' });
    if (request.method !== 'POST' || url.pathname !== '/upload-url') return json(404, { error: 'not_found' });

    // Reject at the edge before consuming an AWS Lambda invocation.
    const clientSecret = request.headers.get('x-recordings-auth');
    if (!constantTimeEqual(clientSecret, env.RECORDINGS_SHARED_SECRET)) return json(401, { error: 'unauthorized' });

    let body;
    try {
      body = await request.text();
      JSON.parse(body);
    } catch {
      return json(400, { error: 'invalid_json' });
    }

    if (!env.UPLOAD_ORIGIN_URL?.startsWith('https://')) return json(503, { error: 'origin_not_configured' });

    const origin = new URL('/upload-url', env.UPLOAD_ORIGIN_URL);
    const aws = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION,
      service: 'lambda',
    });

    // The Lambda keeps its existing shared-secret check as defence in depth.
    // aws4fetch signs this request with SigV4; Tasker remains AWS-unaware.
    const headers = new Headers();
    headers.set('content-type', request.headers.get('content-type') || 'application/json');
    headers.set('x-recordings-auth', clientSecret);

    try {
      const response = await aws.fetch(origin.toString(), { method: 'POST', headers, body });
      const responseBody = await response.text();
      return new Response(responseBody, {
        status: response.status,
        headers: {
          'content-type': response.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store',
        },
      });
    } catch (error) {
      console.error('AWS origin invocation failed', { name: error?.name });
      return json(502, { error: 'origin_unavailable' });
    }
  },
};
