import type { S3Client } from "@aws-sdk/client-s3";
import { LocalstackContainer, type StartedLocalStackContainer } from "@testcontainers/localstack";
import { createS3Client } from "../src/adapters/s3Client.js";

const IMAGE = process.env.LOCALSTACK_IMAGE ?? "localstack/localstack:4";

export interface LocalStackHandle {
  container: StartedLocalStackContainer;
  endpoint: string;
  client: S3Client;
  stop: () => Promise<void>;
}

export async function startLocalStack(): Promise<LocalStackHandle> {
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

  const container = await new LocalstackContainer(IMAGE).start();
  const endpoint = container.getConnectionUri();
  const client = createS3Client({
    region: "us-east-2",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

  return {
    container,
    endpoint,
    client,
    stop: async () => {
      await container.stop();
    },
  };
}
