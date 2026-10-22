// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {defineConfig} from "vitest/config";
import {cloudflareTest} from "@cloudflare/vitest-plugin";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: {configPath: './wrangler.toml'},
			miniflare: {
				bindings: {ALLOWED_HOSTS: ['127.0.0.1:8787']},
			},
		}),
	]
});
