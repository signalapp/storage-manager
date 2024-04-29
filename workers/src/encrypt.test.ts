// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { randBytes, readableStreamFrom, readAll, authenticateAndDecrypt } from './testutil';
import { Encrypter, streamEncrypt } from './encrypt';

describe('streamEncrypt', () => {
	const keyBytes: Uint8Array = randBytes(32);
	const hmacKey = randBytes(32);
	const iv = randBytes(16);

	it.each([1, 3, 113])('handles chunks of size %s', async (chunkSize) => {
		const plaintext = randBytes(1763);
		const encrypter = await Encrypter.create(iv, hmacKey, keyBytes);

		const { readable: source, writable: inp } = new TransformStream();
		const { readable: out, writable: dst } = new TransformStream();
		const [writePromise, readPromise] = [streamEncrypt(encrypter, source, dst, 128), readAll(out)];

		const writer = inp.getWriter();
		for (let i = 0; i < plaintext.length; i += chunkSize) {
			await writer.write(plaintext.subarray(i, i + chunkSize));
		}
		await writer.close();

		await writePromise;
		const encrypted = await readPromise;
		const decrypted = await authenticateAndDecrypt(iv, keyBytes, hmacKey, encrypted);

		expect(encrypted.length).toBe(encrypter.encryptedLength(plaintext.length));
		expect(decrypted).toEqual(plaintext);
	});

	it.each([
		0, 16, 17, 32, 1023, 1024, 1025, 1024 * 3 + 7
	])('encrypts a single chunk of size %s', async (plaintextLength: number) => {
		const plaintext = randBytes(plaintextLength);
		const encrypter = await Encrypter.create(iv, hmacKey, keyBytes);


		const source = readableStreamFrom(plaintext);
		const { readable: actual, writable: dst } = new TransformStream();
		const encrypt = streamEncrypt(encrypter, source, dst, 1024);
		const ciphertext = await readAll(actual);
		const decrypted = await authenticateAndDecrypt(iv, keyBytes, hmacKey, ciphertext);
		await encrypt;
		expect(decrypted).toEqual(plaintext);
		expect(ciphertext.length).toBe(encrypter.encryptedLength(plaintextLength));
	});
});
