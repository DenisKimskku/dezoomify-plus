# Dezoomify Cloudflare Worker

This folder contains the optional Cloudflare Worker proxy for dezoomify.

Primary production path for this fork is Vercel (`/api/proxy` + serverless APIs).
Use this worker only if you explicitly want a Cloudflare worker proxy tier.

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

## When to use this

Use this worker if you need one of these:

- A Cloudflare-native proxy entrypoint.
- A custom worker route independent from Vercel function routing.
- Regional traffic controls specific to your Cloudflare setup.

If your app is already deployed on Vercel and working, you do not need this worker.

## Configuration

Edit [`wrangler.toml`](./wrangler.toml):

- `name`: your worker name
- `workers_dev`: keep `true` for workers.dev
- Optional `route`: uncomment and set your production route/zone

## Cloudflare DNS with Vercel custom domains

If you are only using Cloudflare for DNS in front of Vercel:

1. Add your domain/subdomain in Vercel first.
2. In Cloudflare DNS, point the subdomain to `cname.vercel-dns.com`.
3. Remove conflicting records for the same host.
4. Start with DNS-only (gray cloud) until Vercel domain verification succeeds.
