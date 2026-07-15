// Prove sharded verify is memory-bounded: a generator store yields each md5-prefix
// shard on demand, so the whole bucket is never materialized.
// Run: node --import tsx bench/scale-mem-sharded.mjs <N>
import { verifySharded } from "../src/services/sharded.ts";

const N = Number(process.argv[2] ?? 10_000_000);
const SHARDS = 256; // shardLength 2
const perShard = Math.floor(N / SHARDS);

let peak = 0;
const sampler = setInterval(() => {
  const r = process.memoryUsage().rss;
  if (r > peak) peak = r;
}, 50);

// Generate a shard's objects on demand (v2 layout); v3 queries return [].
function objsForPrefix(prefix) {
  if (prefix.startsWith("files/md5/") || prefix.length !== 3) return []; // expect "<hh>/"
  const hh = prefix.slice(0, 2);
  const out = new Array(perShard);
  for (let i = 0; i < perShard; i++) {
    const tail = i.toString(16).padStart(30, "0").slice(0, 30);
    out[i] = { key: `${hh}/${tail}`, size: 100, etag: `${hh}${tail}` };
  }
  return out;
}

const store = { list: (_b, prefix) => Promise.resolve(objsForPrefix(prefix ?? "")) };

const t = Date.now();
const rep = await verifySharded(store, "old", store, "new", { deep: true, shardLength: 2 });
clearInterval(sampler);
console.log(
  JSON.stringify({
    N,
    perShard,
    shards: rep.shards,
    ok: rep.ok,
    matchedCount: rep.matchedCount,
    deepChecked: rep.deepChecked,
    peakRssMB: Math.round(peak / 1048576),
    secs: +((Date.now() - t) / 1000).toFixed(1),
  }),
);
