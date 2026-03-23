#!/usr/bin/env node
/**
 * One-time setup script — creates Cloudflare KV namespaces and patches wrangler.toml.
 *
 * Usage:
 *   node scripts/setup.js <CF_API_TOKEN> [CF_ACCOUNT_ID]
 *
 * If CF_ACCOUNT_ID is omitted it will be fetched automatically from the token.
 *
 * What it does:
 *   1. Verify the API token
 *   2. Resolve the account ID
 *   3. Create "PREDICT_KV" (production) and "PREDICT_KV_preview" (preview/dev)
 *   4. Patch wrangler.toml with the real namespace IDs
 *
 * Run once before the first deploy. Safe to re-run — existing namespaces are reused.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const CF_BASE = "https://api.cloudflare.com/client/v4";
const WRANGLER_TOML = resolve("wrangler.toml");

// ── Args ──────────────────────────────────────────────────────────────────────

const [, , token, accountIdArg] = process.argv;

if (!token) {
  console.error("Usage: node scripts/setup.js <CF_API_TOKEN> [CF_ACCOUNT_ID]");
  process.exit(1);
}

const headers = {
  "Authorization": `Bearer ${token}`,
  "Content-Type": "application/json",
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Verify token
  const verify = await cfGet("/user/tokens/verify");
  if (!verify.success) {
    console.error("❌ Token invalid:", verify.errors);
    process.exit(1);
  }
  console.log("✓ Token verified:", verify.result.status);

  // 2. Resolve account ID
  let accountId = accountIdArg;
  if (!accountId) {
    const memberships = await cfGet("/memberships?status=accepted");
    if (!memberships.success || memberships.result.length === 0) {
      console.error("❌ No Cloudflare accounts found for this token");
      process.exit(1);
    }
    accountId = memberships.result[0].account.id;
    console.log(`✓ Account ID: ${accountId} (${memberships.result[0].account.name})`);
  }

  // 3. Create or retrieve KV namespaces
  const prodId = await ensureKvNamespace(accountId, "PREDICT_KV");
  const previewId = await ensureKvNamespace(accountId, "PREDICT_KV_preview");

  // 4. Patch wrangler.toml
  let toml = readFileSync(WRANGLER_TOML, "utf8");
  toml = toml
    .replace(/id\s*=\s*"REPLACE_WITH_PROD_KV_ID"/, `id = "${prodId}"`)
    .replace(/preview_id\s*=\s*"REPLACE_WITH_PREVIEW_KV_ID"/, `preview_id = "${previewId}"`);
  writeFileSync(WRANGLER_TOML, toml);

  console.log(`\n✅ wrangler.toml updated:`);
  console.log(`   KV production id : ${prodId}`);
  console.log(`   KV preview id    : ${previewId}`);
  console.log(`\nNext steps:`);
  console.log(`  1. git add wrangler.toml && git commit -m "chore: add KV namespace IDs"`);
  console.log(`  2. Set GitHub Secrets (Settings → Secrets → Actions):`);
  console.log(`       CLOUDFLARE_API_TOKEN = ${token.slice(0, 6)}…`);
  console.log(`       CLOUDFLARE_ACCOUNT_ID = ${accountId}`);
  console.log(`       TAOSTATS_API_KEY = <your key>`);
  console.log(`  3. git push  →  GitHub Actions will deploy the Worker automatically`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureKvNamespace(accountId, title) {
  // Check if it already exists
  const list = await cfGet(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  if (list.success) {
    const existing = list.result.find(ns => ns.title === title);
    if (existing) {
      console.log(`✓ KV namespace already exists: ${title} (${existing.id})`);
      return existing.id;
    }
  }

  // Create it
  const create = await cfPost(`/accounts/${accountId}/storage/kv/namespaces`, { title });
  if (!create.success) {
    console.error(`❌ Failed to create KV namespace "${title}":`, create.errors);
    process.exit(1);
  }
  console.log(`✓ KV namespace created: ${title} (${create.result.id})`);
  return create.result.id;
}

async function cfGet(path) {
  const res = await fetch(`${CF_BASE}${path}`, { headers });
  return res.json();
}

async function cfPost(path, body) {
  const res = await fetch(`${CF_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return res.json();
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
