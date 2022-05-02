# 🏋️‍♂️CRoW: an OCI Registry on Cloudflare Workers🏋️‍♀️

[![Build](https://github.com/chainguard-dev/crow-registry/actions/workflows/build.yaml/badge.svg)](https://github.com/chainguard-dev/crow-registry/actions/workflows/build.yaml)

This is an experimental prototype OCI registry on Cloudflare Workers, aiming to use [Cloudflare's R2](https://blog.cloudflare.com/introducing-r2-object-storage/) for [egress-cost-free image distribution](https://blog.cloudflare.com/aws-egregious-egress/).

## This is an unsupported prototype

This repo was used to assess the feasibility of using Cloudflare R2 as the basis for an OCI registry, running the serving components on Cloudflare Workers written in TypeScript.

The experiment worked (yay!!), but we don't expect to proceed with this code, so it's available as open source for anybody interested in trying it out.

Feel free to send PRs -- there are some notable [TODOs](#todos)! -- but also feel free to fork it and use it however you want.

## 👩 💻 Developing

### You must use [`wrangler`](https://developers.cloudflare.com/workers/cli-wrangler/install-update) to develop this.

```
npm install -g wrangler
```

### Getting Started

Create a Cloudflare account, and purchase a pay-as-you-go R2 plan.

...and update [`wrangler.toml`](./wrangler.toml) to set your account ID.

Create two KV namespaces, for tags and manifests:

```
wrangler kv:namespace create TAGS
wrangler kv:namespace create MANIFESTS
```

...and update [`wrangler.toml`](./wrangler.toml) as described.

Create an R2 bucket:

```
wrangler r2 bucket create crow-testing-${USER}
```

...and update [`wrangler.toml`](./wrangler.toml) to bind to that bucket.

### 🧪 Testing

There are some jest tests. `npm install -g jest` and run `npm test` to run them.

### ✏️ Formatting

This template uses [`prettier`](https://prettier.io/) to format the project. To invoke, run `npm run format`.

### 👀 Previewing and Publishing

`wrangler dev` for local preview.

```
crane cp alpine 127.0.0.1:8787/alpine
crane manifest 127.0.0.1:8787/alpine
```

`wrangler publish` to deploy for real.

```
crane cp alpine crow.MY-USER.workers.dev/alpine
crane manifest crow.MY-USER.workers.dev/alpine
```

### 🚮 Teardown

```
wrangler delete
wrangler r2 bucket delete crow-testing-${USER}
wrangler kv:namespace delete TAGS
wrangler kv:namespace delete MANIFESTS
```

### TODOs

- [ ] Auth! Currently anybody can push or pull.
- [ ] Cross-repo blob mounting
- [ ] Observability / monitoring / alerting
- [ ] Blob GC? TTL?
- [ ] OCI conformance
- [ ] Backups?

Note: the R2 bindings for Cloudflare Workers don't support redirecting to [presigned URLs served by Cloudflare directly](https://developers.cloudflare.com/r2/data-access/s3-api/presigned-urls/), so this serves blob contents through the Worker, meaning it's billed for CPU-seconds used while serving blobs.
