// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { expect } from 'vitest';

export function randBytes(n: number): Uint8Array {
	const arr = new Uint8Array(n);
	crypto.getRandomValues(arr);
	return arr;
}

/**
 * Generate large random looking data to use when validating encryption algorithms. This can be faster that actual
 * random data for large buffers if there isn't enough available entropy on the system.
 */
export async function randomishBytes(n: number): Promise<Uint8Array> {
	let curr = new Uint8Array(32);
	const arr = new Uint8Array(n);
	for (let offset = 0; offset < n; offset += 32) {
		const dig = await crypto.subtle.digest('SHA-256', curr);
		curr = new Uint8Array(dig);
		arr.set(curr.subarray(0, n - offset), offset);
	}
	return arr;
}

export function readableStreamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) {
		// save a copy of the chunk
		chunks.push(new Uint8Array(chunk));
	}
	return concat(chunks);
}

export function concat(data: Uint8Array[]): Uint8Array {
	const size = data.reduce((len, nxt) => len + nxt.length, 0);
	const ret = new Uint8Array(size);
	let offset = 0;
	for (const arr of data) {
		ret.set(arr, offset);
		offset += arr.length;
	}
	return ret;
}

export async function hmacVerify(hmac: Uint8Array, key: Uint8Array, ...data: Uint8Array[]): Promise<boolean> {
	return await crypto.subtle.verify({
			name: 'hmac',
			hash: 'SHA-256'
		},
		await crypto.subtle.importKey('raw', key, {
			name: 'hmac',
			hash: 'SHA-256'
		}, false, ['verify']),
		hmac,
		concat(data));
}


export async function aesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
	return await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt', 'decrypt']);
}

export async function decrypt(iv: Uint8Array, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await aesKey(key), data));
}

export async function authenticateAndDecrypt(key: Uint8Array, hmacKey: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
	// Use the IV appended to the ciphertext
	return await authenticateAndDecryptWithIv(ciphertext.subarray(0, 16), key, hmacKey, ciphertext);
}

export async function authenticateAndDecryptWithIv(iv: Uint8Array, key: Uint8Array, hmacKey: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
	expect(ciphertext.subarray(0, 16)).toEqual(iv);
	const encrypted = ciphertext!.subarray(16, ciphertext.length - 32);
	const hmac = ciphertext.subarray(ciphertext.length - 32, ciphertext.length);
	expect(await hmacVerify(hmac, hmacKey, ciphertext.subarray(0, ciphertext.length - 32))).toBe(true);
	return await decrypt(iv, key, encrypted);
}

export function arrayEquals(a1: Uint8Array, a2: Uint8Array): boolean {
	if (a1.length !== a2.length) {
		return false;
	}
	for (let i = 0; i < a1.length; ++i) {
		if (a1[i] !== a2[i]) {
			return false;
		}
	}
	return true;
}

