# CloudFront OAC decision gate

Superseded by the Cloudflare Worker implementation in issue #17. CloudFront OAC for Lambda Function URL POST requests requires `x-amz-content-sha256` from the viewer, so it would add client-side hashing to Tasker. The selected design keeps Tasker simple and moves AWS SigV4 signing to the Worker.
