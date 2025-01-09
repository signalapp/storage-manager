// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { randBytes, randomishBytes, authenticateAndDecrypt, arrayEquals } from './testutil';
import { ListResponse } from './index';
import { fetchMock } from 'cloudflare:test';
import './env.d.ts';

const GCS_BUCKET: string = env.GCS_BUCKET;

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

		const res = await SELF.fetch(`http://localhost/${bucketName}/abc`, { method: 'DELETE' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bytesDeleted: 4 });
		expect(await bucket(bucketName).get('abc')).toBeNull();
	});

	it('succeeds on missing objects', async () => {
		const res = await SELF.fetch('http://localhost/attachments/fake', { method: 'DELETE' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bytesDeleted: 0 });
	});

	it('handles on objects with / in the name', async () => {
		await env.ATTACHMENT_BUCKET.put('abc/def', 'test');
		const res = await SELF.fetch('http://localhost/attachments/abc/def', { method: 'DELETE' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bytesDeleted: 4 });
		expect(await env.ATTACHMENT_BUCKET.get('abc/def')).toBeNull();
	});

});

describe('list', () => {
	const prefix = 'myBackupId/media';

	async function addObjects(prefix: string, numObjects: number, content: string): Promise<string[]> {
		const keys = [...Array(numObjects).keys()].map(i => `${prefix}/${i}`);
		for (const key of keys) {
			await env.BACKUP_BUCKET.put(key, content);
		}
		return keys;
	}

	it('lists all objects', async () => {
		const keys = await addObjects(prefix, 5, 'test');

		const response = await SELF.fetch(`http://localhost/backups?prefix=${prefix}&limit=5`, { method: 'GET' });
		expect(response.status).toBe(200);
		const res = await response.json() as ListResponse;
		expect(res.cursor).toBeUndefined();
		expect(res.objects).toHaveLength(5);
		expect(res.objects.map(obj => obj.key)).toEqual(keys);
		expect(res.objects.map(obj => obj.size).every(n => n === 4)).toBeTruthy();
	});

	it('limit larger than numObjects', async () => {
		await addObjects(prefix, 5, 'test');
		const response = await SELF.fetch(`http://localhost/backups/?prefix=${prefix}&limit=10`, { method: 'GET' });
		expect(response.status).toBe(200);
		const res = await response.json() as ListResponse;
		expect(res.cursor).toBeUndefined();
		expect(res.objects).toHaveLength(5);
	});

	it('pages results', async () => {
		const keys = await addObjects(prefix, 5, 'test');

		let response = await SELF.fetch(`http://localhost/backups?prefix=${prefix}&limit=3`, { method: 'GET' });
		expect(response.status).toBe(200);
		let res = await response.json() as ListResponse;
		expect(res.cursor).toBeTruthy();
		expect(res.objects).toHaveLength(3);
		expect(res.objects.map(obj => obj.key)).toEqual(keys.slice(0, 3));

		response = await SELF.fetch(`http://localhost/backups/?prefix=${prefix}&limit=3&cursor=${res.cursor}`, { method: 'GET' });
		expect(response.status).toBe(200);
		res = await response.json() as ListResponse;
		expect(res.cursor).toBeFalsy();
		expect(res.objects).toHaveLength(2);
		expect(res.objects.map(obj => obj.key)).toEqual(keys.slice(3));
	});

	it('handles url-encoded query parameters', async () => {
		await addObjects('myBackupId==/m/edia', 5, 'test');
		await addObjects('myBackUpId==/m/edia2', 10, 'test');

		const response = await SELF.fetch(
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
			await env.BACKUP_BUCKET.put(`prefix1/${i}`, randBytes(i));
			await env.BACKUP_BUCKET.put(`prefix2/${i}`, randBytes(i));
			total += i;
		}
		const response = await SELF.fetch('http://localhost/usage?prefix=prefix1', { method: 'GET' });
		expect(response.status).toBe(200);
		const { bytesUsed, numObjects } = await response.json() as { bytesUsed: number, numObjects: number };
		expect(bytesUsed).toBe(total);
		expect(numObjects).toBe(100);
	});

	it('handles 0 bytesUsed', async () => {
		const response = await SELF.fetch('http://localhost/usage?prefix=prefix1', { method: 'GET' });
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
		const response = await SELF.fetch(`http://localhost/usage?prefix=prefix1&limit=${params.limit}`, { method: 'GET' });
		expect(response.status).toBe(200);
		const { bytesUsed, numObjects } = await response.json() as { bytesUsed: number, numObjects: number };
		expect(bytesUsed).toBe(total);
		expect(numObjects).toBe(params.numObjects);
	});
});

describe('copy', () => {
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
		const res = await SELF.fetch('http://localhost/copy', {
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
		const res = await SELF.fetch('http://localhost/copy', {
			method: 'PUT',
			body: body,
			headers: { 'Content-Length': body.length.toString() }
		});
		expect(res.status, await res.text()).toBe(400);
	});

	it.each(['r2', 'gcs'])('handles missing %s source object', async (scheme: string) => {
		if (scheme === 'gcs') {
			fetchMock.activate();
			fetchMock.disableNetConnect();

			fetchMock.get('https://storage.googleapis.com')
				.intercept({ path: `/${GCS_BUCKET}/attachments/DoesNotExist` })
				.reply(404);
		}
		const request: Record<string, unknown> = validRequest(plaintext, 'DoesNotExist', scheme);
		const body = JSON.stringify(request);
		const res = await SELF.fetch('http://localhost/copy', {
			method: 'PUT',
			body: body,
			headers: { 'Content-Length': body.length.toString() }
		});
		expect(res.status, await res.text()).toBe(404);
	});

	it('handles weird sourceKeys', async () => {
		const sourceKey = '../+_../--';
		const encoded = '..%2F%2B_..%2F--';
		fetchMock.activate();
		fetchMock.disableNetConnect();

		const plaintext = Buffer.from(await randomishBytes(32));
		fetchMock.get('https://storage.googleapis.com')
			.intercept({ path: `/${GCS_BUCKET}/attachments/${encoded}` })
			.reply(200, plaintext, {
				headers: { 'Content-Length': plaintext.length.toString() }
			});

		const request = validRequest(plaintext, sourceKey, 'gcs');
		const body = JSON.stringify(request);
		const res = await SELF.fetch('http://localhost/copy', { method: 'PUT', body });
		expect(res.status, await res.text()).toBe(204);
		fetchMock.assertNoPendingInterceptors();
	});

	it('rejects bad r2 sourceLength', async () => {
		await env.ATTACHMENT_BUCKET.put('abc', plaintext);
		const request: Record<string, unknown> = validRequest();
		request['expectedSourceLength'] = plaintext.length - 1;
		const body = JSON.stringify(request);
		const res = await SELF.fetch('http://localhost/copy', {
			method: 'PUT',
			body: body,
			headers: { 'Content-Length': body.length.toString() }
		});
		expect(res.status, await res.text()).toBe(409);
	});

	it('rejects bad gcs sourceLength', async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();

		fetchMock.get('https://storage.googleapis.com')
			.intercept({ path: `/${GCS_BUCKET}/attachments/wrongSourceLength` })
			.reply(200, plaintext, {
				headers: { 'Content-Length': (plaintext.length - 1).toString() }
			});

		fetchMock.get('https://storage.googleapis.com')
			.intercept({ path: `/${GCS_BUCKET}/attachments/missingSourceLength` })
			.reply(200, plaintext, {});

		let request: Record<string, unknown> = validRequest(plaintext, 'missingSourceLength', 'gcs');
		const missingRes = await SELF.fetch('http://localhost/copy', { method: 'PUT', body: JSON.stringify(request) });
		expect(missingRes.status, await missingRes.text()).toBe(500);

		request = validRequest(plaintext, 'wrongSourceLength', 'gcs');
		const wrongRes = await SELF.fetch('http://localhost/copy', { method: 'PUT', body: JSON.stringify(request) });
		expect(wrongRes.status, await wrongRes.text()).toBe(409);
	});

	it.each([
		0, 63, 64, 1024 * 4 - 1, 1024, 1024 * 4 + 1, 1024 * 1024, 1024 * 1024 * 3 + 1
	])('copies %s bytes to backup bucket', async (plaintextLength: number) => {
		const plaintext = await randomishBytes(plaintextLength);
		await env.ATTACHMENT_BUCKET.put('abc', plaintext);
		const body = JSON.stringify(validRequest(plaintext));
		const res = await SELF.fetch('http://localhost/copy', {
			method: 'PUT',
			body: body
		});
		expect(res.status, await res.text()).toBe(204);
		const payload = await toArray(await env.BACKUP_BUCKET.get('my/abc'));
		const decrypted = await authenticateAndDecrypt(encryptionKey, hmacKey, payload!);
		expect(arrayEquals(decrypted, plaintext)).toBe(true);
	});

	it.each([0, 63, 64, 1024 * 4 - 1, 1024, 1024 * 4 + 1])('copies %s bytes from GCS', async (plaintextLength: number) => {
		fetchMock.activate();
		fetchMock.disableNetConnect();

		const plaintext = Buffer.from(await randomishBytes(plaintextLength));
		fetchMock.get('https://storage.googleapis.com')
			.intercept({ path: `/${GCS_BUCKET}/attachments/myKey` })
			.reply(200, plaintext, {
				headers: { 'Content-Length': plaintext.length.toString() }
			});
		const request = validRequest(plaintext, 'myKey', 'gcs');
		const body = JSON.stringify(request);
		const res = await SELF.fetch('http://localhost/copy', { method: 'PUT', body });
		expect(res.status, await res.text()).toBe(204);
		fetchMock.assertNoPendingInterceptors();
	});

});
