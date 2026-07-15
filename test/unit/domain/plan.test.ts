import { describe, expect, it } from "vitest";
import { md5ToKey } from "../../../src/domain/dvcKey.js";
import {
  type DestResolver,
  buildPlan,
  identityResolver,
  planDestBuckets,
} from "../../../src/domain/plan.js";

const A = "aa11111111111111111111111111111a";
const B = "bb22222222222222222222222222222b";

describe("buildPlan", () => {
  it("maps keys to identity destinations preserving the key", () => {
    const keys = [md5ToKey(A, "v2"), md5ToKey(B, "v2")];
    const plan = buildPlan("old", keys, identityResolver("new"));
    expect(plan.items).toEqual([
      { sourceBucket: "old", sourceKey: keys[0], destBucket: "new", destKey: keys[0], md5: A },
      { sourceBucket: "old", sourceKey: keys[1], destBucket: "new", destKey: keys[1], md5: B },
    ]);
  });

  it("routes per md5 via a custom resolver (provider split shape)", () => {
    const keys = [md5ToKey(A, "v2"), md5ToKey(B, "v2")];
    const resolve: DestResolver = ({ md5, sourceKey }) => ({
      destBucket: md5 === A ? "bucket-a" : "bucket-b",
      destKey: `files/md5/${sourceKey}`,
    });
    const plan = buildPlan("old", keys, resolve);
    expect(plan.items.map((i) => i.destBucket)).toEqual(["bucket-a", "bucket-b"]);
    expect(plan.items[0]!.destKey).toBe(`files/md5/${keys[0]}`);
  });

  it("skips non-DVC junk keys (prefix-collision) instead of throwing", () => {
    const good = md5ToKey(A, "v2");
    const junk = "aa/not-a-real-hash-just-junk";
    const plan = buildPlan("old", [good, junk], identityResolver("new"));
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toEqual({
      sourceBucket: "old",
      sourceKey: good,
      destBucket: "new",
      destKey: good,
      md5: A,
    });
  });
});

describe("planDestBuckets", () => {
  it("returns distinct destination buckets", () => {
    const keys = [md5ToKey(A, "v2"), md5ToKey(B, "v2")];
    const resolve: DestResolver = ({ md5 }) => ({
      destBucket: md5 === A ? "x" : "x",
      destKey: "k",
    });
    const plan = buildPlan("old", keys, resolve);
    expect(planDestBuckets(plan)).toEqual(["x"]);
  });
});
