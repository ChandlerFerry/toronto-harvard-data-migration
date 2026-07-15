// Measure sustained CopyObject throughput (objects/sec) of our transfer engine.
// Run: node --import tsx bench/copy-throughput.mjs
import { S3ObjectStore } from "../src/adapters/s3ObjectStore.ts";
import { buildPlan, identityResolver } from "../src/domain/plan.ts";
import { transfer } from "../src/services/transfer.ts";
import { startLocalStack } from "../test/localstack.ts";

const K = Number(process.env.K ?? 3000); // objects
const ls = await startLocalStack();
const store = new S3ObjectStore(ls.client, { region: "us-east-2" });

// Seed K tiny content-addressed objects into OLD.
await store.ensureBucket("tp-old");
const keys = [];
for (let i = 0; i < K; i++) {
  const h = i.toString(16).padStart(32, "0").slice(0, 32);
  keys.push(`${h.slice(0, 2)}/${h.slice(2)}`);
}
const seedLimit = 128;
for (let i = 0; i < keys.length; i += seedLimit) {
  await Promise.all(keys.slice(i, i + seedLimit).map((k) => store.put("tp-old", k, "x")));
}

console.log(`seeded ${K} objects; measuring transfer throughput (server-side copy)\n`);
for (const c of [32, 64, 128, 256]) {
  const dest = `tp-new-${c}`;
  await store.ensureBucket(dest);
  const plan = buildPlan("tp-old", keys, identityResolver(dest));
  const t = Date.now();
  const rep = await transfer(store, plan, { concurrency: c });
  const secs = (Date.now() - t) / 1000;
  console.log(
    `concurrency=${String(c).padStart(3)}  copied=${rep.copied}  errors=${rep.errors.length}  ` +
      `${secs.toFixed(1)}s  => ${Math.round(rep.copied / secs)} copies/sec`,
  );
}

await ls.stop();
