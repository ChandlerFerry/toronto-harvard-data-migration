export interface ObjectHead {
  size: number;

  etag: string;
}

export interface ListedObject {
  key: string;
  size: number;

  etag: string;
}

export interface CopySpec {
  sourceBucket: string;
  sourceKey: string;
  destBucket: string;
  destKey: string;

  sourceSize?: number;
}

export interface ObjectStore {
  ensureBucket(bucket: string): Promise<void>;
  put(bucket: string, key: string, body: Uint8Array | string): Promise<void>;
  head(bucket: string, key: string): Promise<ObjectHead>;

  list(bucket: string, prefix?: string): Promise<ListedObject[]>;
  getBytes(bucket: string, key: string): Promise<Uint8Array>;

  copy(spec: CopySpec): Promise<void>;

  deleteBatch(bucket: string, keys: string[]): Promise<void>;
}
