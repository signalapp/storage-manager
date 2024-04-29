// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				main: './src/index.ts',
				miniflare: { bindings: { GCS_BUCKET: 'myBucket' } },
				wrangler: { configPath: './wrangler.toml' }
			}
		}
	}
});
