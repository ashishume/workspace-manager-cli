export type ProjectType =
  | "auto"
  | "node"
  | "typescript"
  | "react"
  | "next"
  | "vite"
  | "python"
  | "fastapi";

export type Repo = {
  name: string;
  url: string;
  branch?: string;
  /** Explicit project type; defaults to "auto" (detected from package.json / requirements.txt). */
  type?: ProjectType;
  /** Force or suppress the post-install build step (JS/TS only). Omit to auto-detect. */
  build?: boolean;
};
