// 검증 하니스(testInquiryExtraction.ts)를 api-server 와 동일한 esbuild 옵션(native external + banner)으로 번들.
// 사용: node scripts/buildTestHarness.mjs  →  scripts/runTestInquiryExtraction.mjs 생성
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { createBuildOptions } from "../esbuild.config.mjs";

const artifactDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = createBuildOptions(artifactDir);

await esbuild({
  ...base,
  entryPoints: [path.resolve(artifactDir, "scripts/testInquiryExtraction.ts")],
  outdir: path.resolve(artifactDir, "scripts/dist-harness"),
  logLevel: "warning",
});
console.log("빌드 완료 → scripts/dist-harness/testInquiryExtraction.mjs");
