// Instrumented full-data run against LocalStack to measure process memory.
// Run: node --import tsx --expose-gc bench/full-run.mjs
import { S3ObjectStore } from "../src/adapters/s3ObjectStore.ts";
import { deleteOld } from "../src/services/deleteOld.ts";
import { migrate } from "../src/services/migrate.ts";
import { startLocalStack } from "../test/localstack.ts";
import { collectSandboxEntries, seedSandbox } from "../test/support/seedSandbox.ts";

const mb = (b) => (b / 1048576).toFixed(1);
let peakRss = 0;
function mem(label) {
  const m = process.memoryUsage();
  if (m.rss > peakRss) peakRss = m.rss;
  console.log(
    `[MEM] ${label.padEnd(24)} rss=${mb(m.rss)}MB  heapUsed=${mb(m.heapUsed)}MB  ` +
      `external=${mb(m.external)}MB  arrayBuffers=${mb(m.arrayBuffers)}MB`,
  );
}
// in-process peak sampler (catches spikes between phase snapshots)
const sampler = setInterval(() => {
  const r = process.memoryUsage().rss;
  if (r > peakRss) peakRss = r;
}, 100);

mem("startup");
const ls = await startLocalStack();
const store = new S3ObjectStore(ls.client, { region: "us-east-2" });
mem("localstack up");

const entries = await collectSandboxEntries(); // ALL objects
const totalBytes = entries.reduce((s, e) => s + e.size, 0);
console.log(
  `\nentries=${entries.length}  totalData=${mb(totalBytes)}MB  (.dir=${entries.filter((e) => e.key.endsWith(".dir")).length})\n`,
);
mem("entries collected");

const tSeed = Date.now();
await seedSandbox(store, "old-bench", entries, Number(process.env.SEED_CONC ?? 8));
console.log(
  `-> seed OLD took ${((Date.now() - tSeed) / 1000).toFixed(1)}s (TEST HARNESS: reads each file into RAM)`,
);
mem("after seed OLD");
global.gc?.();
mem("after seed (post-gc)");

const tMig = Date.now();
const rep = await migrate({ store, oldBucket: "old-bench", newBucket: "new-bench", deep: true });
console.log(
  `-> migrate+verify took ${((Date.now() - tMig) / 1000).toFixed(1)}s  ` +
    `copied=${rep.transfer.copied} skipped=${rep.transfer.skipped} errors=${rep.transfer.errors.length} ` +
    `verifyOk=${rep.verify.ok} deepChecked=${rep.verify.deepChecked} deepEtagSkipped=${rep.verify.deepEtagSkipped}`,
);
mem("after migrate+verify");
global.gc?.();
mem("after migrate (post-gc)");

const tDel = Date.now();
const del = await deleteOld(store, "old-bench", rep.verify, { dryRun: false, env: {} });
console.log(
  `-> delete took ${((Date.now() - tDel) / 1000).toFixed(1)}s  deleted=${del.deleted.length}`,
);
mem("after delete");

clearInterval(sampler);
console.log(`\n===== PEAK process RSS over whole run: ${mb(peakRss)} MB =====`);
await ls.stop();
