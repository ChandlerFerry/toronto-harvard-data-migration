// Measure verify() memory as OBJECT COUNT grows (the real C1 axis), using a
// synthetic store so no bytes/LocalStack are involved — pure data-structure cost.
// Run: node --import tsx bench/scale-mem.mjs <N>
import { verify } from "../src/services/verify.ts";

const N = Number(process.argv[2] ?? 1_000_000);

function build(n) {
  const old = new Array(n);
  const neu = new Array(n);
  for (let i = 0; i < n; i++) {
    const h = i.toString(16).padStart(32, "0").slice(0, 32);
    const key = `${h.slice(0, 2)}/${h.slice(2)}`; // valid v2 DVC key
    const etag = ((i * 2654435761) >>> 0).toString(16).padStart(8, "0").repeat(4).slice(0, 32);
    old[i] = { key, size: 100, etag };
    neu[i] = { key, size: 100, etag };
  }
  return { old, neu };
}

const rej = () => Promise.reject(new Error("unsupported"));
const { old, neu } = build(N);
const store = {
  list: (b) => Promise.resolve(b === "old" ? old : neu),
  ensureBucket: () => Promise.resolve(),
  put: rej,
  head: rej,
  getBytes: rej,
  copy: rej,
  deleteBatch: rej,
};

const t = Date.now();
const rep = await verify(store, "old", store, "new", { deep: true });
const m = process.memoryUsage();
console.log(
  JSON.stringify({
    N,
    ok: rep.ok,
    matched: rep.matched.length,
    deepChecked: rep.deepChecked,
    rssMB: Math.round(m.rss / 1048576),
    heapMB: Math.round(m.heapUsed / 1048576),
    secs: +((Date.now() - t) / 1000).toFixed(1),
  }),
);
