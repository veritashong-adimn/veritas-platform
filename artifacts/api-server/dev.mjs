// api-server 개발용 watch 실행기
// esbuild context().watch() 로 src 변경을 감지해 자동 재빌드하고,
// 재빌드가 성공할 때마다 기존 node 프로세스를 완전히 종료한 뒤 새 프로세스를 기동한다.
// (프론트 Vite HMR 과 동일하게 백엔드 소스 수정이 자동 반영되도록 개발 실행 구조만 안정화)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { context as esbuildContext } from "esbuild";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createBuildOptions } from "./esbuild.config.mjs";

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(artifactDir, "dist");
const entry = path.resolve(distDir, "index.mjs");

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let restarting = false;
let shuttingDown = false;
// 재시작을 직렬화해 두 프로세스가 동시에 포트를 잡는 상황(EADDRINUSE)을 방지한다.
let restartQueue = Promise.resolve();

function stopChild() {
  return new Promise((resolve) => {
    const c = child;
    child = null;
    // 이미 없거나 종료된 프로세스면 즉시 완료
    if (!c || c.exitCode !== null || c.signalCode !== null) {
      resolve();
      return;
    }
    let killed = false;
    const done = () => {
      if (killed) return;
      killed = true;
      clearTimeout(forceTimer);
      resolve();
    };
    c.once("exit", done);
    // 정상 종료 요청 → OS 가 8080 포트를 반납할 때까지 exit 이벤트를 기다린다.
    c.kill("SIGTERM");
    // 만약 SIGTERM 에 응답하지 않으면 강제 종료 (포트 선점 방지)
    const forceTimer = setTimeout(() => {
      try {
        c.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 5000);
    forceTimer.unref?.();
  });
}

function startChild() {
  child = spawn(process.execPath, ["--enable-source-maps", entry], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV },
  });
  child.on("exit", (code, signal) => {
    // 의도적 재시작이 아닌데 종료됐다면(코드 오류로 크래시 등) 다음 저장 시 자동 복구됨을 안내
    if (!restarting && !shuttingDown) {
      console.log(
        `[dev] api-server exited (code=${code} signal=${signal}). ` +
          `소스를 수정하면 자동으로 재빌드/재기동됩니다.`,
      );
    }
  });
}

function scheduleRestart() {
  restartQueue = restartQueue
    .then(async () => {
      if (shuttingDown) return;
      restarting = true;
      await stopChild();
      startChild();
      restarting = false;
    })
    .catch((err) => {
      restarting = false;
      console.error("[dev] restart error:", err);
    });
  return restartQueue;
}

// 재빌드가 끝날 때마다 실행되는 훅
const restartPlugin = {
  name: "dev-restart",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) {
        console.error(
          `[dev] 빌드 실패 (${result.errors.length}건). 기존 서버를 유지합니다. 오류 수정 후 자동 재시도됩니다.`,
        );
        return;
      }
      console.log("[dev] 재빌드 완료 → api-server 재시작");
      await scheduleRestart();
    });
  },
};

// 이전 dist 잔재 제거 후 watch 시작 (초기 build 는 watch() 가 즉시 1회 수행 → onEnd 에서 첫 기동)
await rm(distDir, { recursive: true, force: true }).catch(() => {});
const ctx = await esbuildContext(createBuildOptions(artifactDir, [restartPlugin]));
await ctx.watch();
console.log("[dev] src/ 변경 감지 대기 중...");

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  restarting = true;
  await stopChild();
  await ctx.dispose();
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, shutdown);
}
