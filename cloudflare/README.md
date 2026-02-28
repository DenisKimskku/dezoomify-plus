# Dezoomify Cloudflare Worker

This folder contains the Cloudflare Worker proxy for dezoomify.

## Requirements

- Node.js 18+
- Wrangler 3+

## Local development

```bash
cd cloudflare
npm install
npm run dev
```

## Deploy

```bash
cd cloudflare
npm run deploy
```

## Configuration

Edit [`wrangler.toml`](./wrangler.toml):

- `name`: your worker name
- `workers_dev`: keep `true` for workers.dev
- Optional `route`: uncomment and set your production route/zone
