import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installSalesCacheInvalidation } from "./lib/salesListCache";

// 판매목록 메모리 캐시 — 저장성 요청(GET/HEAD 외) 시 즉시 무효화
installSalesCacheInvalidation();

createRoot(document.getElementById("root")!).render(<App />);
