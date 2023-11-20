// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { error, IRequest, json, Router, StatusError } from 'itty-router';
import { Encrypter, streamEncrypt } from './encrypt';

export interface Env {
	ATTACHMENT_BUCKET: R2Bucket;
	BACKUP_BUCKET: R2Bucket;
}

const router = Router();
router
	.put('/copy', copyHandler)
	.get('/usage', usageHandler)
	.get('/:bucketId', listHandler)
	.delete('/:bucketId/:id+', deletionHandler)
	.all('*', () => error(404));


export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return await router.handle(request, env, ctx).catch(e => {
			console.log('error: ' + e.stack);
			return error(e);
		}).then(json);
	}
};

async function deletionHandler(request: IRequest, env: Env): Promise<Response> {
	const bucket = getBucket(env, request.params.bucketId);
	if (bucket == null) {
		return error(404);
	}
	const head = await bucket.head(request.params.id);
	if (head == null) {
		return json({ bytesDeleted: 0 });
	}
	await bucket.delete(request.params.id);
	return json({ bytesDeleted: head.size });
}

export interface ListResponse {
	cursor?: string,
	objects: {
		key: string,
		size: number
	}[]
}

async function listHandler(request: IRequest, env: Env): Promise<Response> {
	const bucket = getBucket(env, request.params.bucketId);
	if (bucket == null) {
		return error(404);
	}
	if (Array.isArray(request.query['cursor'])) {
		return error(400, 'only one cursor parameter can be provided');
	}
	if (Array.isArray(request.query['limit'])) {
		return error(400, 'only one limit parameter can be provided');
	}
	if (Array.isArray(request.query['prefix'])) {
		return error(400, 'only one prefix parameter can be provided');
	}
	const limit = request.query['limit'] == null ? undefined : parseInt(request.query['limit']);
	if (limit != null && isNaN(limit)) {
		throw new StatusError(400, 'limit must be a number');
	}
	const response = await bucket.list({
		prefix: request.query['prefix'],
		cursor: request.query['cursor'],
		limit
	});
	const objects = response.objects.map(({ key, size }) => ({
		key: key,
		size: size
	}));
	const listResponse: ListResponse = {
		cursor: response.truncated ? response.cursor : undefined,
		objects
	};
	return json(listResponse);
}

async function usageHandler(request: IRequest, env: Env): Promise<Response> {
	const bucket = env.BACKUP_BUCKET;
	const prefix = request.query['prefix'];
	if (prefix == null || Array.isArray(prefix) || prefix.length === 0) {
		return error(400, 'exactly one prefix parameter must be provided');
	}

	if (Array.isArray(request.query['limit'])) {
		return error(400, 'only one limit parameter can be provided');
	}
	const limit = request.query['limit'] == null ? undefined : parseInt(request.query['limit']);
	if (limit != null && isNaN(limit)) {
		throw new StatusError(400, 'limit must be a number');
	}


	let totalObjects = 0;
	let totalBytes = 0;
	let cursor: undefined | string = undefined;
	do {
		const response = await bucket.list({ prefix, limit, cursor });
		totalBytes = response.objects.reduce((acc, obj) => acc + obj.size, totalBytes);
		totalObjects += response.objects.length;
		cursor = response.truncated ? response.cursor : undefined;
	} while (cursor != null);
	return json({ bytesUsed: totalBytes, numObjects: totalObjects });
}

interface CopyRequest {
	encryptionKey: string,
	hmacKey: string,
	iv: string,
	source: string,
	expectedSourceLength: number,
	dst: string
}

function isCopyRequest(o: unknown): o is CopyRequest {
	return o != null
		&& typeof o === 'object'
		&& 'encryptionKey' in o && typeof (o.encryptionKey) === 'string'
		&& 'hmacKey' in o && typeof (o.hmacKey) === 'string'
		&& 'iv' in o && typeof (o.iv) === 'string'
		&& 'source' in o && typeof (o.source) === 'string'
		&& 'expectedSourceLength' in o && typeof (o.expectedSourceLength) === 'number'
		&& 'dst' in o && typeof (o.dst) === 'string';
}

async function copyHandler(request: IRequest, env: Env): Promise<Response> {
	const copyRequest = await request.json();
	if (!isCopyRequest(copyRequest)) {
		return error(400, 'invalid copy request');
	}

	const aesKeyBuf = b64decode(copyRequest.encryptionKey);
	if (aesKeyBuf == null) {
		return error(400, 'invalid key, must be base64');
	}
	if (aesKeyBuf.length != 32) {
		return error(400, 'invalid key, must be length 32');
	}

	const hmacKey = b64decode(copyRequest.hmacKey);
	if (hmacKey == null) {
		return error(400, 'invalid hmac key, must be base64');
	}
	if (hmacKey.length != 32) {
		return error(400, 'invalid hmac key, must be length 32');
	}

	const iv = b64decode(copyRequest.iv);
	if (iv == null) {
		return error(400, 'invalid iv, must be base64');
	}
	if (iv.length != 16) {
		return error(400, 'invalid iv, must be length 16');
	}

	const r2Source = await env.ATTACHMENT_BUCKET.get(copyRequest.source);
	if (r2Source === null) {
		return error(404, 'source object not found');
	}

	if (r2Source.size !== copyRequest.expectedSourceLength) {
		return error(409, `request expectedSourceLength ${copyRequest.expectedSourceLength} did not match actual sourceLength ${r2Source.size}`);
	}

	const encrypter = await Encrypter.create(iv, hmacKey, aesKeyBuf);
	const { readable, writable } = new FixedLengthStream(encrypter.encryptedLength(r2Source.size));
	const putRequest = env.BACKUP_BUCKET.put(copyRequest.dst, readable, {
		httpMetadata: r2Source.httpMetadata
	});
	await streamEncrypt(encrypter, r2Source.body, writable);
	await putRequest;
	return new Response(null, { status: 204 });
}


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

function b64decode(b64: string): Uint8Array | null {
	try {
		return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
	} catch (e) {
		return null;
	}
}
