// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, UnstableDevWorker } from 'wrangler';
import { randBytes, randomishBytes, webcryptoAuthenticateAndDecrypt } from './testutil';
import { ListResponse } from './index';


let worker: UnstableDevWorker;
let r2Worker: UnstableDevWorker;
beforeAll(async () => {
	worker = await unstable_dev('src/index.ts', {
		experimental: { disableExperimentalWarning: true }
	});
	r2Worker = await unstable_dev('src/r2TestWorker.ts', {
		experimental: { disableExperimentalWarning: true }
	});
});

afterEach(async () => {
	await r2Clear('attachments');
	await r2Clear('backups');
});

afterAll(async () => {
	await worker.stop();
	await r2Worker.stop();
});

async function r2Clear(bucketName: string): Promise<void> {
	const response = await r2Worker.fetch(`http://${r2Worker.address}:${r2Worker.port}/${bucketName}`, { method: 'DELETE' });
	if (response.status !== 200) {
		throw new Error(`error ${response.status} : ${response.statusText}`);
	}
}

async function r2Put(bucketName: string, key: string, content: string | Uint8Array): Promise<number> {
	const url = `http://${r2Worker.address}:${r2Worker.port}/${bucketName}/${key}`;
	const response = await r2Worker.fetch(url, {
		method: 'PUT',
		body: content,
		headers: {
			'Content-Length': `${content.length}`
		}
	});
	if (response.status !== 200) {
		throw new Error(`error ${response.status} : ${response.statusText}`);
	}
	return response.status;
}

async function r2Get(bucketName: string, key: string): Promise<Uint8Array | null> {
	const url = `http://${r2Worker.address}:${r2Worker.port}/${bucketName}/${key}`;
	const response = await r2Worker.fetch(url, { method: 'GET' });
	if (response.status == 404) {
		return null;
	}
	if (response.status != 200) {
		throw new Error(`error ${response.status} : ${response.statusText}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}

describe('deletes', () => {
	it.each([
		'attachments',
		'backups'
	])('delete from %s', async (bucketName: string) => {
		await r2Put(bucketName, 'abc', 'test');
		expect(await r2Get(bucketName, 'abc')).toStrictEqual(new TextEncoder().encode('test'));

		const res = await worker.fetch(`http://localhost/${bucketName}/abc`, { method: 'DELETE' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bytesDeleted: 4 });
		expect(await r2Get(bucketName, 'abc')).toBeNull();
	});

	it('succeeds on missing objects', async () => {
		const res = await worker.fetch('http://localhost/attachments/fake', { method: 'DELETE' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bytesDeleted: 0 });
	});

	it('handles on objects with / in the name', async () => {
		await r2Put('attachments', 'abc/def', 'test');
		const res = await worker.fetch('http://localhost/attachments/abc/def', { method: 'DELETE' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bytesDeleted: 4 });
		expect(await r2Get('attachments', 'abc/def')).toBeNull();
	});

});

describe('list', () => {
	const prefix = 'myBackupId/media';

	async function addObjects(prefix: string, numObjects: number, content: string): Promise<string[]> {
		const keys = [...Array(numObjects).keys()].map(i => `${prefix}/${i}`);
		for (const key of keys) {
			await r2Put('backups', key, content);
		}
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

		const url = `http://${r2Worker.address}:${r2Worker.port}/backups`;
		await r2Worker.fetch(url, { method: 'GET' });

		const response = await worker.fetch(
			`http://localhost/backups/?prefix=${encodeURIComponent('myBackupId==/m/edia')}&limit=10`,
			{ method: 'GET' });
		expect(response.status).toBe(200);
		const res = await response.json() as ListResponse;
		expect(res.cursor).toBeUndefined();
		expect(res.objects).toHaveLength(5);
	});
});

describe('usage', async () => {
	it('calculates usage', async () => {
		let total = 0;
		for (let i = 0; i < 100; i++) {
			await r2Put('backups', `prefix1/${i}`, randBytes(i));
			await r2Put('backups', `prefix2/${i}`, randBytes(i));
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
			await r2Put('backups', `prefix1/${i}`, randBytes(i));
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
	const key = randBytes(32);
	const hmacKey = randBytes(32);
	const iv = randBytes(16);
	const plaintext = randBytes(1024 * 3 + 7);

	function validRequest(source: Uint8Array = plaintext) {
		return {
			encryptionKey: Buffer.from(key).toString('base64'),
			hmacKey: Buffer.from(hmacKey).toString('base64'),
			iv: Buffer.from(iv).toString('base64'),
			source: 'abc',
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

	it.each(['encryptionKey', 'hmacKey', 'iv', 'expectedSourceLength'])('rejects bad base64 encoded %s', async (badprop: string) => {
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

	it('handles missing source object', async () => {
		const request: Record<string, unknown> = validRequest();
		request['source'] = 'DoesNotExist';
		const body = JSON.stringify(request);
		const res = await worker.fetch('http://localhost/copy', {
			method: 'PUT',
			body: body,
			headers: { 'Content-Length': body.length.toString() }
		});
		expect(res.status, await res.text()).toBe(404);
	});

	it('rejects bad sourceLength', async () => {
		await r2Put('attachments', 'abc', plaintext);
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

	it.each([
		0, 63, 64, 1024 * 4 - 1, 1024, 1024 * 4 + 1, 1024 * 1024, 1024 * 1024 * 3 + 1
	])('copies %s bytes to backup bucket', async (plaintextLength: number) => {
		const plaintext = randomishBytes(plaintextLength);
		await r2Put('attachments', 'abc', plaintext);
		const body = JSON.stringify(validRequest(plaintext));
		const res = await worker.fetch('http://localhost/copy', {
			method: 'PUT',
			body: body,
			headers: { 'Content-Length': body.length.toString() }
		});
		expect(res.status, await res.text()).toBe(204);
		const payload = await r2Get('backups', 'my/abc');
		const decrypted = await webcryptoAuthenticateAndDecrypt(iv, key, hmacKey, payload!);
		expect(decrypted).toEqual(plaintext);
	});
});
