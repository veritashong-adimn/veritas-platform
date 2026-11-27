import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installSalesCacheInvalidation } from "./lib/salesListCache";
import { installSessionGuard } from "./lib/sessionGuard";

// 판매목록 메모리 캐시 — 저장성 요청(GET/HEAD 외) 시 즉시 무효화
installSalesCacheInvalidation();
// 로그인 세션 보호 — 세션 만료 응답 감지(즉시 로그아웃)·미저장 입력 감지(자동 로그아웃 안내 경고)
installSessionGuard();

createRoot(document.getElementById("root")!).render(<App />);
