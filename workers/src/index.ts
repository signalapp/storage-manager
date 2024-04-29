// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { error, IRequest, json, Router, StatusError } from 'itty-router';
import { Encrypter, streamEncrypt } from './encrypt';

export interface Env {
	ATTACHMENT_BUCKET: R2Bucket;
	BACKUP_BUCKET: R2Bucket;
	GCS_BUCKET: string;
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
	source: SourceDescriptor,
	expectedSourceLength: number,
	dst: string
}

interface GCSSourceDescriptor {
	scheme: 'gcs',
	key: string,
}

interface R2SourceDescriptor {
	scheme: 'r2',
	key: string,
}

type SourceDescriptor = GCSSourceDescriptor | R2SourceDescriptor;


function isCopyRequest(o: unknown): o is CopyRequest {

	function isGCSSource(o: object): o is GCSSourceDescriptor {
		return 'scheme' in o && typeof (o.scheme) === 'string' && o.scheme === 'gcs'
			&& 'key' in o && typeof (o.key) === 'string';
	}

	function isR2Source(o: object): o is R2SourceDescriptor {
		return 'scheme' in o && typeof (o.scheme) === 'string' && o.scheme === 'r2'
			&& 'key' in o && typeof (o.key) === 'string';
	}

	function isSourceDescriptor(o: unknown): o is SourceDescriptor {
		return o != null
			&& typeof o === 'object'
			&& (isGCSSource(o) || isR2Source(o));
	}

	return o != null
		&& typeof o === 'object'
		&& 'encryptionKey' in o && typeof (o.encryptionKey) === 'string'
		&& 'hmacKey' in o && typeof (o.hmacKey) === 'string'
		&& 'iv' in o && typeof (o.iv) === 'string'
		&& 'source' in o && isSourceDescriptor(o.source)
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

	const s = await source(env, copyRequest.source);
	if (s == null) {
		return error(404, 'source object not found');
	}
	if (s.length !== copyRequest.expectedSourceLength) {
		return error(409, `request expectedSourceLength ${copyRequest.expectedSourceLength} did not match actual sourceLength ${s.length}`);
	}

	const encrypter = await Encrypter.create(iv, hmacKey, aesKeyBuf);
	const { readable, writable } = new FixedLengthStream(encrypter.encryptedLength(s.length));
	const putRequest = env.BACKUP_BUCKET.put(copyRequest.dst, readable, {
		httpMetadata: s.httpMetadata
	});
	await streamEncrypt(encrypter, s.body, writable);
	await putRequest;
	return new Response(null, { status: 204 });
}

interface SourceStream {
	body: ReadableStream<Uint8Array>,
	httpMetadata?: R2HTTPMetadata,
	length: number
}

async function source(env: Env, sourceDescriptor: SourceDescriptor): Promise<SourceStream | null> {
	switch (sourceDescriptor.scheme) {
		case 'r2': {
			const r2Source = await env.ATTACHMENT_BUCKET.get(sourceDescriptor.key);
			if (r2Source == null) {
				return null;
			}
			return { body: r2Source.body, length: r2Source.size, httpMetadata: r2Source.httpMetadata };
		}
		case 'gcs': {
			const uri = `https://storage.googleapis.com/${env.GCS_BUCKET}/attachments/${sourceDescriptor.key}`;
			const fetchSource = await fetch(uri);
			if (fetchSource.status === 404) {
				return null;
			}
			if (!fetchSource.ok) {
				throw new StatusError(500, `Unexpected error reading source object ${fetchSource.status}`);
			}
			const sourceLength = readInt(fetchSource.headers.get('Content-Length'));
			if (isNaN(sourceLength)) {
				throw new StatusError(500, 'source did not provide content-length header');
			}
			if (fetchSource.body == null) {
				throw new StatusError(500, 'source did not have body');
			}
			return { length: sourceLength, body: fetchSource.body as ReadableStream<Uint8Array> };
		}
		default:
			return assertNever(sourceDescriptor);
	}
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

function readInt(s: string | null): number {
	if (s == null) {
		return NaN;
	}
	return parseInt(s, 10);
}

function assertNever(x: never): never {
	throw new Error('Unexpected object: ' + x);
}

function b64decode(b64: string): Uint8Array | null {
	try {
		return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
	} catch (e) {
		return null;
	}
}
