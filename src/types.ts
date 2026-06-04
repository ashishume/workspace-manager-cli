export type ProjectType = "auto" | "node" | "typescript" | "react" | "next" | "vite";

export type Repo = {
  name: string;
  url: string;
  branch?: string;
  /** Explicit project type; defaults to "auto" (detected from package.json). */
  type?: ProjectType;
  /** Force or suppress the post-install build step. Omit to auto-detect. */
  build?: boolean;
};
