// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import crypto from 'node:crypto';

// @ts-expect-error crypto is available both in node and workers
const subtle = globalThis.crypto.subtle;

// Maximum plaintext length where the output length (including a 16-byte IV, 32-byte HMAC, and up to 16 extra padding
// bytes) will fit in a Number.MAX_SAFE_INTEGER
const MAX_PLAINTEXT_LENGTH = Number.MAX_SAFE_INTEGER - 32 - 16 - 16;

/**
 * Writes IV || AES-CBC-256(plaintext) || HMAC-SHA-256(IV || ciphertext)
 *
 * The underlying webcrypto APIs do not provide streaming AES. This class builds streaming AES-CBC over one-shot, with
 * the caveat that all but the last block must be provided as a multiple of the block size (16 bytes).
 */
export class Encrypter {
	hmac: crypto.Hmac;
	iv: Uint8Array;
	aesKey: CryptoKey;

	constructor(iv: Uint8Array, hmac: crypto.Hmac, aesKey: CryptoKey) {
		if (iv.length !== 16) {
			throw new Error('invalid iv length ' + iv.length);
		}
		this.hmac = hmac;
		this.aesKey = aesKey;
		this.iv = new Uint8Array(16);
		this.iv.set(iv);
	}

	static async create(iv: Uint8Array, hmacKey: Uint8Array, aesKey: Uint8Array): Promise<Encrypter> {
		return new Encrypter(
			iv,
			crypto.createHmac('sha256', hmacKey),
			await subtle.importKey('raw', aesKey, 'AES-CBC', false, ['encrypt']));
	}

	encryptedLength(plaintextLength: number): number {
		if (plaintextLength > MAX_PLAINTEXT_LENGTH) {
			throw new Error('plaintext length too large' + plaintextLength);
		}
		// AES-256 has 16-byte block size, and always adds a block if the plaintext is a multiple of the block size
		const numBlocks = Math.ceil((plaintextLength + 1) / 16);
		return this.iv.length +
			(numBlocks * 16) + // AES-256 encrypted data
			32; // hmac-sha256(IV || encrypted)
	}

	/**
	 * Initialize the encrypter
	 *
	 * Writes the iv to dst
	 *
	 * @param dst The output stream for the encrypter
	 */
	async init(dst: WritableStreamDefaultWriter<Uint8Array>) {
		await dst.write(this.iv);
		this.hmac.update(this.iv);
	}

	/**
	 * Encrypt and write one or more 16-byte blocks of plaintext
	 *
	 * @param dst The output stream for the encrypter where the encrypted plaintext will be written
	 * @param plaintext The plaintext to encrypt
	 */
	async encrypt(dst: WritableStreamDefaultWriter<Uint8Array>, plaintext: Uint8Array) {
		if (plaintext.length % 16 !== 0) {
			throw new Error('All but final block must be multiple of block size (16)');
		}

		let encrypted = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: this.iv }, this.aesKey, plaintext));

		if (encrypted.length !== plaintext.length + 16) {
			// sanity check: we should always end up with an extra padding block
			throw new Error(`Unexpected AES output length ${encrypted.length} instead of ${plaintext.length + 16}`);
		}

		// Since plaintext is a multiple of block size, the PKCS#7 padding added to the plaintext will always add a 16-byte
		// block. We can trim this off since we don't want any padding until the final block.
		encrypted = encrypted.subarray(0, encrypted.length - 16);

		// In CBC mode, the iv for the next block is the previous block
		this.iv.set(encrypted.subarray(encrypted.length - 16));

		await dst.write(encrypted);
		this.hmac.update(encrypted);
	}

	/**
	 * Finish writing
	 *
	 * Encrypts and writes the remaining plaintext if provided, and writes the HMAC of the IV and encrypted bytes
	 *
	 * @param dst The output stream for the encrypter
	 * @param plaintext If present, plaintext to encrypt and write to dst
	 */
	async finish(dst: WritableStreamDefaultWriter<Uint8Array>, plaintext: Uint8Array | undefined) {
		const encrypted = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: this.iv }, this.aesKey, plaintext));
		await dst.write(encrypted);
		this.hmac.update(encrypted);
		await dst.write(this.hmac.digest());
	}
}

/**
 * Encrypt the source stream and write it to the destination stream.
 *
 * Writes:
 * IV || AES-CBC-256(source) || HMAC-SHA256(IV || AES-CBC-256(source))
 */
export async function streamEncrypt(
	encrypter: Encrypter,
	source: ReadableStream<Uint8Array>,
	dst: WritableStream<Uint8Array>,
	bufferSize?: number) {

	bufferSize = bufferSize || 1024 * 1024;
	if (bufferSize % 16 !== 0) {
		throw new Error('bufferSize must be a multiple of AES-CBC-256 blockSize (16)');
	}

	// This could be cleaned up a little bit with use of the TransformStream API, however cloudflare workers does not
	// currently support Transforms other than IdentityTransforms.
	const writer = dst.getWriter();
	try {
		// write the IV
		await encrypter.init(writer);

		// we'll buffer up to 1MiB before encrypting and flushing
		const plaintext = new Uint8Array(bufferSize);
		let offset = 0;
		for await (const sourceChunk of source) {
			let chunk: Uint8Array | null = sourceChunk;

			// Keep writing the chunk until it has all made it into the writer, or it has been buffered into `plaintext`
			do {
				const amtToCopy = Math.min(plaintext.length - offset, chunk.length);
				plaintext.set(chunk.subarray(0, amtToCopy), offset);
				offset += amtToCopy;
				if (offset === plaintext.length) {
					// plaintext buffer is full, encrypt and flush it down
					await encrypter.encrypt(writer, plaintext);
					offset = 0;
				}
				// If there's more left in the chunk, trim it and keep going.
				chunk = amtToCopy < chunk.length ? chunk.subarray(amtToCopy) : null;
			} while (chunk !== null);
		}

		// write whatever is left and the hmac
		await encrypter.finish(writer, plaintext.subarray(0, offset));
	} finally {
		await writer.close();
	}
}
