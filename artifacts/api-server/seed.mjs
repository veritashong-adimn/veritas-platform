import { createRequire } from "node:module";
import { build } from "esbuild";
import { spawn } from "node:child_process";

globalThis.require = createRequire(import.meta.url);

await build({
  entryPoints: ["src/seed.ts"],
  platform: "node",
  bundle: true,
  format: "esm",
  outfile: "dist/seed.mjs",
  logLevel: "info",
  external: ["*.node", "pg-native"],
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';
globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
`,
  },
});

const child = spawn("node", ["dist/seed.mjs"], { stdio: "inherit", env: process.env });
child.on("exit", code => process.exit(code ?? 0));
