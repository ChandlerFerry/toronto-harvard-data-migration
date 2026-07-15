export interface GitDvcEntry {
  md5: string;

  rootDir: string;

  path: string;

  commit: string;
}

export interface GitHistory {
  walk(repoDir: string, subdir: string): Promise<GitDvcEntry[]>;
}
