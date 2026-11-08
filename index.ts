/**
 * Root entrypoint for loading this checkout as a *local plugin directory*
 * (absolute path in opencode.jsonc `plugins`). OpenCode resolves
 * `<dir>/server` or `<dir>/index` for local directory plugins (see
 * @opencode/plugin `Host.resolve`); npm and git installs instead go
 * through package.json `exports["."]`, so this file is only used when the
 * directory is loaded directly (development installs).
 */
export { default } from "./src/index.js";
