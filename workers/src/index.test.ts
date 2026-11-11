// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randBytes, randomishBytes, authenticateAndDecrypt, arrayEquals } from './testutil';
import { INFREQUENT_ACCESS_THRESHOLD_BYTES, ListResponse, R2_MAX_PAGE_SIZE } from './index';
import {env, exports} from 'cloudflare:workers';
import './env.d.ts';

const GCS_BUCKET: string = env.GCS_BUCKET;
const worker = exports.default;

function bucket(bucketName: string): R2Bucket {
	if (bucketName === 'attachments') {
		return env.ATTACHMENT_BUCKET;
	} else if (bucketName === 'backups') {
		return env.BACKUP_BUCKET;
	} else {
		throw new Error(`invalid bucketName ${bucketName}`);
	}
}

async function toArray(obj: R2ObjectBody | null): Promise<Uint8Array> {
	return new Uint8Array(await obj!.arrayBuffer());
}

describe('deletes', () => {
	it.each([
		'attachments',
		'backups'
	])('delete from %s', async (bucketName: string) => {
		await bucket(bucketName).put('abc', 'test');
		const read = await toArray(await bucket(bucketName).get('abc'));
		expect(read).toStrictEqual(new TextEncoder().encode('test'));

		const res = await worker.fetch(`http://localhost/${bucketName}/abc`, { method: 'DELETE' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bytesDeleted: 4 });
		expect(await bucket(bucketName).get('abc')).toBeNull();
	});

	it('succeeds on missing objects', async () => {
		const res = await worker.fetch('http://localhost/attachments/fake', { method: 'DELETE' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bytesDeleted: 0 });
	});

	it('handles on objects with / in the name', async () => {
		await env.ATTACHMENT_BUCKET.put('abc/def', 'test');
		const res = await worker.fetch('http://localhost/attachments/abc/def', { method: 'DELETE' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bytesDeleted: 4 });
		expect(await env.ATTACHMENT_BUCKET.get('abc/def')).toBeNull();
	});

});

describe('list', () => {
	const prefix = 'myBackupId/media';

	async function addObjects(prefix: string, numObjects: number, content: string): Promise<string[]> {
		const keys = [...Array(numObjects).keys()].map(i => `${prefix}/${i}`);
		const futures = keys.map(key => env.BACKUP_BUCKET.put(key, content));
		await Promise.all(futures);
		return keys;
	}

	it('lists all objects', async () => {
		const keys = await addObjects(prefix, 5, 'test');

		const response = await worker.fetch(`http://localhost/backups?prefix=${prefix}&limit=5`, { method: 'GET' });
		expect(response.status).toBe(200);
		const res = await response.json() as ListResponse;
		expect(res.cursor).toBeUndefined();
		expect(res.objects).toHaveLength(5);
		expect(res.objects.map(obj => obj.key)).toEqual(keys);
		expect(res.objects.map(obj => obj.size).every(n => n === 4)).toBeTruthy();
	});

	it('limit larger than numObjects', async () => {
		await addObjects(prefix, 5, 'test');
		const response = await worker.fetch(`http://localhost/backups/?prefix=${prefix}&limit=10`, { method: 'GET' });
		expect(response.status).toBe(200);
		const res = await response.json() as ListResponse;
		expect(res.cursor).toBeUndefined();
		expect(res.objects).toHaveLength(5);
	});

	it('pages results', async () => {
		const keys = await addObjects(prefix, 5, 'test');

		let response = await worker.fetch(`http://localhost/backups?prefix=${prefix}&limit=3`, { method: 'GET' });
		expect(response.status).toBe(200);
		let res = await response.json() as ListResponse;
		expect(res.cursor).toBeTruthy();
		expect(res.objects).toHaveLength(3);
		expect(res.objects.map(obj => obj.key)).toEqual(keys.slice(0, 3));

		response = await worker.fetch(`http://localhost/backups/?prefix=${prefix}&limit=3&cursor=${res.cursor}`, { method: 'GET' });
		expect(response.status).toBe(200);
		res = await response.json() as ListResponse;
		expect(res.cursor).toBeFalsy();
		expect(res.objects).toHaveLength(2);
		expect(res.objects.map(obj => obj.key)).toEqual(keys.slice(3));
	});

	it('handles url-encoded query parameters', async () => {
		await addObjects('myBackupId==/m/edia', 5, 'test');
		await addObjects('myBackUpId==/m/edia2', 10, 'test');

		const response = await worker.fetch(
			`http://localhost/backups/?prefix=${encodeURIComponent('myBackupId==/m/edia')}&limit=10`,
			{ method: 'GET' });
		expect(response.status).toBe(200);
		const res = await response.json() as ListResponse;
		expect(res.cursor).toBeUndefined();
		expect(res.objects).toHaveLength(5);
	});

	it('handles multiple r2 pages', async () => {
		const totalObjects = R2_MAX_PAGE_SIZE * 2 + 2;
		await addObjects('myBackupId==/m/edia', totalObjects, 'test');

		// Can't return all objects because a third page would potentially bring us past our requested limit
		let response = await worker.fetch(
			`http://localhost/backups/?prefix=${encodeURIComponent('myBackupId==/m/edia')}&limit=${totalObjects}`,
			{ method: 'GET' });
		expect(response.status).toBe(200);
		let res = await response.json() as ListResponse;
		expect(res.objects).toHaveLength(totalObjects - 2);
		expect(res.cursor).toBeTruthy();

		// List the remaining 2 objects
		response = await worker.fetch(
			`http://localhost/backups/?prefix=${encodeURIComponent('myBackupId==/m/edia')}&limit=2&cursor=${res.cursor}`,
			{ method: 'GET' });
		expect(response.status).toBe(200);
		res = await response.json() as ListResponse;
		expect(res.objects).toHaveLength(2);
		expect(res.cursor).toBeFalsy();
	});
});

describe('usage', async () => {
	afterEach(async () => {
		// Clear the backup bucket after each test
		let cursor: string | undefined;
		do {
			const listed = await env.BACKUP_BUCKET.list({ cursor });
			if (listed.objects.length > 0) {
				await env.BACKUP_BUCKET.delete(listed.objects.map(o => o.key));
			}
			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor != null);
	});

	it('calculates usage', async () => {
		let total = 0;
		for (let i = 0; i < 100; i++) {
			await env.BACKUP_BUCKET.put(`prefix1/${i}`, randBytes(i));
			await env.BACKUP_BUCKET.put(`prefix2/${i}`, randBytes(i));
			total += i;
		}
		const response = await worker.fetch('http://localhost/usage?prefix=prefix1', { method: 'GET' });
		expect(response.status).toBe(200);
		const { bytesUsed, numObjects } = await response.json() as { bytesUsed: number, numObjects: number };
		expect(bytesUsed).toBe(total);
		expect(numObjects).toBe(100);
	});

	it('handles 0 bytesUsed', async () => {
		const response = await worker.fetch('http://localhost/usage?prefix=prefix1', { method: 'GET' });
		expect(response.status).toBe(200);
		const { bytesUsed, numObjects } = await response.json() as { bytesUsed: number, numObjects: number };
		expect(bytesUsed).toBe(0);
		expect(numObjects).toBe(0);
	});

	const pagingParams = [1, 3, 5, 10, 50, 100, 113]
		.flatMap(i => [1, 3, 5, 50, 113].map(j => ({ numObjects: i, limit: j })));
	it.each(pagingParams)('handles paging %s', async (params) => {
		let total = 0;
		for (let i = 0; i < params.numObjects; i++) {
			await env.BACKUP_BUCKET.put(`prefix1/${i}`, randBytes(i));
			total += i;
		}
		const response = await worker.fetch(`http://localhost/usage?prefix=prefix1&limit=${params.limit}`, { method: 'GET' });
		expect(response.status).toBe(200);
		const { bytesUsed, numObjects } = await response.json() as { bytesUsed: number, numObjects: number };
		expect(bytesUsed).toBe(total);
		expect(numObjects).toBe(params.numObjects);
	});
});

describe('copy', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const encryptionKey = randBytes(32);
	const hmacKey = randBytes(32);
	const plaintext = randBytes(1024 * 3 + 7);

	function validRequest(source: Uint8Array = plaintext, key = 'abc', scheme = 'r2') {
		return {
			encryptionKey: Buffer.from(encryptionKey).toString('base64'),
			hmacKey: Buffer.from(hmacKey).toString('base64'),
			source: { scheme, key },
			expectedSourceLength: source.length,
			dst: 'my/abc'
		};
	}

	it.each(Object.keys(validRequest()))('rejects missing %s', async (missingProp: string) => {
		const request: Record<string, unknown> = validRequest();
		delete request[missingProp];
		const body = JSON.stringify(request);
		const res = await worker.fetch('http://localhost/copy', {
			method: 'PUT',
			body: body,
			headers: { 'Content-Length': body.length.toString() }
		});
		expect(res.status, await res.text()).toBe(400);
	});

	it.each(['encryptionKey', 'hmacKey', 'expectedSourceLength'])('rejects bad base64 encoded %s', async (badprop: string) => {
		const request: Record<string, unknown> = validRequest();
		request[badprop] = 'aa&bb';
		const body = JSON.stringify(request);
		const res = await worker.fetch('http://localhost/copy', {
			method: 'PUT',
			body: body,
			headers: { 'Content-Length': body.length.toString() }
		});
		expect(res.status, await res.text()).toBe(400);
	});

	it.each(['r2', 'gcs'])('handles missing %s source object', async (scheme: string) => {
		if (scheme === 'gcs') {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === `https://storage.googleapis.com/${GCS_BUCKET}/attachments/DoesNotExist`) {
					return new Response(null, { status: 404 });
				}
				throw new Error(`Unexpected fetch: ${url}`);
			});
		}
		const request: Record<string, unknown> = validRequest(plaintext, 'DoesNotExist', scheme);
		const body = JSON.stringify(request);
		const res = await worker.fetch('http://localhost/copy', {
			method: 'PUT',
			body: body,
			headers: { 'Content-Length': body.length.toString() }
		});
		expect(res.status, await res.text()).toBe(404);
	});

	it('handles weird sourceKeys', async () => {
		const sourceKey = '../+_../--';
		const encoded = '..%2F%2B_..%2F--';

		const plaintext = Buffer.from(await randomishBytes(32));
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === `https://storage.googleapis.com/${GCS_BUCKET}/attachments/${encoded}`) {
				return new Response(plaintext, {
					status: 200,
					headers: { 'Content-Length': plaintext.length.toString() }
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const request = validRequest(plaintext, sourceKey, 'gcs');
		const body = JSON.stringify(request);
		const res = await worker.fetch('http://localhost/copy', { method: 'PUT', body });
		expect(res.status, await res.text()).toBe(204);
		expect(globalThis.fetch).toHaveBeenCalledOnce();
	});

	it('rejects bad r2 sourceLength', async () => {
		await env.ATTACHMENT_BUCKET.put('abc', plaintext);
		const request: Record<string, unknown> = validRequest();
		request['expectedSourceLength'] = plaintext.length - 1;
		const body = JSON.stringify(request);
		const res = await worker.fetch('http://localhost/copy', {
			method: 'PUT',
			body: body,
			headers: { 'Content-Length': body.length.toString() }
		});
		expect(res.status, await res.text()).toBe(409);
	});

	it('rejects bad gcs sourceLength', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === `https://storage.googleapis.com/${GCS_BUCKET}/attachments/wrongSourceLength`) {
				return new Response(plaintext, {status: 200, headers: {'Content-Length': (plaintext.length - 1).toString()}});
			} else if (url === `https://storage.googleapis.com/${GCS_BUCKET}/attachments/missingSourceLength`) {
				return new Response(plaintext, {status: 200});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		let request: Record<string, unknown> = validRequest(plaintext, 'missingSourceLength', 'gcs');
		const missingRes = await worker.fetch('http://localhost/copy', { method: 'PUT', body: JSON.stringify(request) });
		expect(missingRes.status, await missingRes.text()).toBe(500);

		request = validRequest(plaintext, 'wrongSourceLength', 'gcs');
		const wrongRes = await worker.fetch('http://localhost/copy', { method: 'PUT', body: JSON.stringify(request) });
		expect(wrongRes.status, await wrongRes.text()).toBe(409);
	});

	it.each([
		0, 63, 64, 1024 * 4 - 1, 1024, 1024 * 4 + 1, 1024 * 1024, 1024 * 1024 * 3 + 1
	])('copies %s bytes to backup bucket', async (plaintextLength: number) => {
		const plaintext = await randomishBytes(plaintextLength);
		await env.ATTACHMENT_BUCKET.put('abc', plaintext);
		const body = JSON.stringify(validRequest(plaintext));
		const res = await worker.fetch('http://localhost/copy', {
			method: 'PUT',
			body: body
		});
		expect(res.status, await res.text()).toBe(204);
		const payload = await toArray(await env.BACKUP_BUCKET.get('my/abc'));
		const decrypted = await authenticateAndDecrypt(encryptionKey, hmacKey, payload!);
		expect(arrayEquals(decrypted, plaintext)).toBe(true);
	});

	it.each([
		// 99,951 plaintext bytes encrypt to exactly INFREQUENT_ACCESS_THRESHOLD_BYTES, one more byte adds an AES block
		[0, 'Standard'],
		[8 * 1024, 'Standard'],
		[99_951, 'Standard'],
		[99_952, 'InfrequentAccess'],
		[1024 * 1024, 'InfrequentAccess']
	])('copies %s bytes to %s storage', async (plaintextLength: number, expectedStorageClass: string) => {
		const plaintext = await randomishBytes(plaintextLength);
		await env.ATTACHMENT_BUCKET.put('abc', plaintext);
		const put = vi.spyOn(env.BACKUP_BUCKET, 'put');
		const body = JSON.stringify(validRequest(plaintext));
		const res = await worker.fetch('http://localhost/copy', {
			method: 'PUT',
			body: body
		});
		expect(res.status, await res.text()).toBe(204);
		const copied = await env.BACKUP_BUCKET.head('my/abc');
		expect(copied!.size > INFREQUENT_ACCESS_THRESHOLD_BYTES).toBe(expectedStorageClass === 'InfrequentAccess');
		// The local R2 simulator doesn't record storage classes, so check what was requested instead
		expect(put).toHaveBeenCalledOnce();
		expect(put.mock.calls[0][2]?.storageClass).toBe(expectedStorageClass);
	});

	it.each([0, 63, 64, 1024 * 4 - 1, 1024, 1024 * 4 + 1])('copies %s bytes from GCS', async (plaintextLength: number) => {
		const plaintext = Buffer.from(await randomishBytes(plaintextLength));
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === `https://storage.googleapis.com/${GCS_BUCKET}/attachments/myKey`) {
				return new Response(plaintext, {
					status: 200,
					headers: { 'Content-Length': plaintext.length.toString() }
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		const request = validRequest(plaintext, 'myKey', 'gcs');
		const body = JSON.stringify(request);
		const res = await worker.fetch('http://localhost/copy', { method: 'PUT', body });
		expect(res.status, await res.text()).toBe(204);
		expect(globalThis.fetch).toHaveBeenCalledOnce();
	});

});
