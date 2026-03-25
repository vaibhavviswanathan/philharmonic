#!/usr/bin/env npx tsx
/**
 * Generates wrangler.jsonc for the orchestrator from phil.config.json.
 * Usage: npx tsx scripts/generate-wrangler.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const config = JSON.parse(readFileSync(resolve(root, "phil.config.json"), "utf-8"));

const { subdomain, workerName } = config.cloudflare;
const { instanceType, maxInstances } = config.sandbox;

const wrangler = {
  name: workerName,
  main: "src/index.ts",
  compatibility_date: "2025-04-01",
  compatibility_flags: ["nodejs_compat"],

  durable_objects: {
    bindings: [
      { name: "TASK_COORDINATOR", class_name: "TaskCoordinator" },
      { name: "Sandbox", class_name: "Sandbox" },
    ],
  },

  containers: [
    {
      class_name: "Sandbox",
      image: "../../docker/Dockerfile.sandbox",
      instance_type: instanceType,
      max_instances: maxInstances,
    },
  ],

  migrations: [
    {
      tag: "v1",
      new_sqlite_classes: ["TaskCoordinator", "Sandbox"],
    },
  ],

  vars: {
    WORKER_URL: `https://${workerName}.${subdomain}.workers.dev`,
  },

  observability: {
    enabled: true,
  },
};

const outPath = resolve(root, "packages/orchestrator/wrangler.jsonc");
writeFileSync(outPath, JSON.stringify(wrangler, null, 2) + "\n");
console.log(`Generated ${outPath}`);
console.log(`  Worker URL: ${wrangler.vars.WORKER_URL}`);
