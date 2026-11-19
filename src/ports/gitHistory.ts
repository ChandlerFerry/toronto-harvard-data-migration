export interface GitDvcEntry {
  md5: string;

  rootDir: string;

  path: string;

  commit: string;
}

export interface GitHistory {
  resolveCommit(repoDir: string, commit: string): Promise<string>;

  walk(repoDir: string, subdir: string, commit?: string): Promise<GitDvcEntry[]>;
}
