export interface DvcStatusResult {
  clean: boolean;
  payload: unknown;
}

export interface DvcPushOptions {
  jobs?: number;
  remote?: string;
}

export interface DvcCli {
  version(): Promise<string>;

  ensureVersion3(): Promise<void>;

  status(target: string, opts?: { cloud?: boolean }): Promise<DvcStatusResult>;

  add(target: string): Promise<void>;

  push(opts?: DvcPushOptions): Promise<void>;
}
