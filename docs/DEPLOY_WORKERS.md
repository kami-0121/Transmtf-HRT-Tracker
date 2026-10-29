# 部署到 Cloudflare Workers

此 fork 以 Cloudflare Workers（靜態資源 + 一個小 Worker）部署。Worker 會先處理每個請求：負責 SPA 路由，並在每個 HTML 頁面注入 `window.__ENV__`（執行期設定）。

## 預設：本機模式

`wrangler.toml` 預設 `CLOUD_ENABLED = "false"`：

- 不顯示登入／註冊，不還原舊登入、不刷新 token；
- 不連線到任何後端，也不讀取原專案的公告與使用統計；
- 所有紀錄（用藥、抽血報告、藥物方案）只存在使用者的瀏覽器，請用「設定 › 資料管理」匯出備份。

## 一次性設定（Cloudflare Workers Builds，Git 自動部署）

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Import a repository**，連結 GitHub 並選擇 `kami-0121/Transmtf-HRT-Tracker`。
2. Worker／專案名稱填 **`transmtf-hrt-tracker`**（必須與 `wrangler.toml` 的 `name` 相同）。
3. 建置設定：
   - Build command：`npm test && npm run build`（測試失敗就不部署）
   - Deploy command：`npx wrangler deploy`
4. Production branch：選要上線的分支（建議先把開發分支合併到 `main`，再以 `main` 為 production）。其他分支的推送會產生預覽版本。
5. 完成後網址為 `https://transmtf-hrt-tracker.<你的子網域>.workers.dev`；可在 Worker 的 **Settings → Domains & Routes** 綁定自己的網域。

之後每次推送到 production branch 都會自動建置與部署。

## 手動部署（本機）

```bash
npx wrangler login      # 第一次
npm run deploy          # = npm test && npm run build && npx wrangler deploy
```

## 啟用雲端功能（需要自己的後端）

雲端同步、帳號、分享需要相容 `docs/api.md` 的後端，以及綁定你網域的 Turnstile site key。原專案的後端與 Turnstile key 只接受原作者的網域，而且此 fork 的資料格式（抽血報告、藥物方案、同步雜湊 v5）不應上傳到原作者的伺服器。

在 `wrangler.toml` 的 `[vars]`（或 Dashboard → Worker → Settings → Variables）設定：

```toml
CLOUD_ENABLED = "true"
VITE_API_BASE_URL = "https://your-backend.example.com/api"
VITE_TURNSTILE_SITE_KEY = "your-turnstile-site-key"
```

這些值在執行期由 Worker 注入，修改後重新部署即可，前端不需重新建置。

## 注意

`run_worker_first = true` 是必要的：只設 `["/api/*"]` 時，HTML 會直接由靜態資源回應，`window.__ENV__` 不會被注入（原專案設定即有此問題）。
