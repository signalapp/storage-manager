# Overview

This directory provides a storage-manager built on [Cloudflare workers](https://developers.cloudflare.com/workers/) that manages objects stored on [Cloudflare R2](https://developers.cloudflare.com/r2/)

# Building
You'll need [Node.js](https://nodejs.org/). If you use [nvm](https://github.com/creationix/nvm) run
```
nvm use
```

To install dependencies,
```
npm install
```

In order to deploy to Cloudflare or use non-local development mode, use the [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/) utility. Follow those instructions to authenticate with your Cloudflare account.

# Testing

To run a development server you can interact with over `localhost`:
```
npx wrangler dev
```

To run unit tests,
```
npm test
```

# Deploying

## One time setup
Create R2 buckets and update the bindings in `wrangler.toml`, then:

```
wrangler deploy -e <staging|production>
```
