import { S3ObjectStore } from "../../src/adapters/s3ObjectStore.js";
import { startLocalStack } from "../localstack.js";
import { objectStoreContract } from "../support/objectStoreContract.js";

objectStoreContract("S3ObjectStore@LocalStack", async () => {
  const ls = await startLocalStack();
  const store = new S3ObjectStore(ls.client, { region: "us-east-2" });
  return { store, teardown: () => ls.stop() };
});
