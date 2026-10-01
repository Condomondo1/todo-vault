import { createRequire } from "node:module";

/**
 * The package version, read from this workspace's package.json at runtime so
 * the number is written in exactly one place. The MCP handshake and
 * `vault --version` both report it.
 *
 * `../package.json` resolves the same from `src/` (tsx) and `dist/` (built),
 * which is why this is a runtime read rather than an import: `rootDir` is
 * `src`, so tsc refuses a static import of a file outside it.
 *
 * Deliberately not re-exported from index.ts. The desktop bundles core into its
 * main process, where that relative path points nowhere; the desktop asks
 * Electron for its own version instead (`app.getVersion()`).
 */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;
