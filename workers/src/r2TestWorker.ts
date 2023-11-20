// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { error, json, Router } from 'itty-router';

export interface Env {
	ATTACHMENT_BUCKET: R2Bucket;
	BACKUP_BUCKET: R2Bucket;
}

const router = Router();
router.get('/:bucketId/:id+', async (request, env) => {
	const bucket = getBucket(env, request.params.bucketId);
	if (bucket == null) {
		return error(404);
	}
	const object = await bucket.get(request.params.id);
	if (object == null) {
		return error(404);
	}
	return new Response(object.body, { status: 200 });
});
router.put('/:bucketId/:id+', async (request, env) => {
	const bucket = getBucket(env, request.params.bucketId);
	if (bucket == null) {
		return error(404);
	}
	if (request.body == null) {
		return error(400);
	}
	await bucket.put(request.params.id, request.body as ReadableStream<never>, { httpMetadata: request.headers });
	return new Response(null, { status: 200 });
});

router.delete('/:bucketId', async (request, env) => {
	const bucket = getBucket(env, request.params.bucketId);
	if (bucket == null) {
		return error(404);
	}

	let cursor: undefined | string = undefined;
	do {
		const response = await bucket.list({ cursor });
		await bucket.delete(response.objects.map(obj => obj.key));
		if (response.truncated) {
			cursor = response.cursor;
		}
	} while (cursor != null);
	return new Response(null, { status: 200 });
});

router.all('*', () => error(404));


export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return await router.handle(request, env, ctx).catch(e => {
			console.log('error: ' + e.stack);
			return error(e);
		}).then(json);
	}
};


function getBucket(env: Env, bucketId: string): R2Bucket | undefined {
	switch (bucketId) {
		case 'attachments':
			return env.ATTACHMENT_BUCKET;
		case 'backups':
			return env.BACKUP_BUCKET;
		default:
			return undefined;
	}
}
