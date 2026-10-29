# AtDo HRT：部署到 Cloudflare Workers（D1 雲端存檔）

此 fork 由一個 Cloudflare Worker 同時提供：

- **App**：靜態資源（PWA，可安裝到主畫面）與 SPA 路由；每個 HTML 頁面注入 `window.__ENV__`（執行期設定）。
- **雲端存檔 API**：`/api/*`（`server/api.ts`），資料存在 **D1**。

## 資料怎麼存

- **本機存檔是主要副本**：所有紀錄先存在瀏覽器（localStorage），離線也能用。
- **雲端存檔是備份**：登入後自動備份到 D1，換裝置登入即可取回。
- **慢速同步（不再每 3 秒請求）**：
  - 修改後約 8 秒上傳（連續修改會合併成一次，最長等 60 秒）；離開或切到背景時立即上傳。
  - 開啟 App、PWA 回到前景、恢復連線時，若距上次檢查超過 1 分鐘就檢查雲端；使用中每 15 分鐘檢查一次。
  - 「設定 › 帳號 › 立即備份到雲端」可手動同步。
- **兩台裝置都改過時自動合併**（參考 AtDo 的三方合併）：以上次同步的版本為基準，逐筆比對紀錄（用藥、抽血、方案、凝膠）與設定。
  - 兩邊各自新增、修改不同欄位、一邊刪除另一邊沒動 → 全部保留／套用，不跳視窗。
  - 兩邊改了同一筆的同一欄位 → 以目前這台裝置為準。
  - 一邊刪除、另一邊修改了同一筆 → 保留修改（不會默默遺失）。
  - 只有找不到基準版本時（例如剛升級後第一次同步）才顯示衝突視窗讓你選。
- **版本號防覆蓋**：雲端存檔帶有版本號，上傳時附上「根據哪一版修改」；若另一台裝置剛好先上傳，伺服器回 409，App 會重新下載、合併後再上傳。
- **先問版本號再下載**（參考 AtDo 的增量同步）：定時檢查只送一個很小的請求問「雲端版本號」，跟本機記得的一樣就不下載整份資料；本機有修改就直接上傳。
- **多分頁不互搶**：同時開好幾個分頁／視窗時，以 Web Locks 確保同一時間只有一個在同步。
- **失敗自動重試**：連不上（顯示「無法連線到伺服器」）或伺服器忙碌（429／5xx，顯示「伺服器忙碌」）時，依 30 秒、1 分、2 分…最長 15 分鐘自動重試；恢復連線或回到 App 時會立即重試。
- 已安裝的 PWA 每小時檢查一次新版本，有新版會自動更新。
- 雲端快照以 gzip 壓縮；設定 6 位數「安全密碼」後，另以該密碼衍生的金鑰 AES-GCM 加密，伺服器不保存安全密碼。**忘記安全密碼將無法還原雲端備份**（本機資料不受影響）。

## 一次性設定（Cloudflare Workers Builds，Git 自動部署）

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Import a repository**，連結 GitHub 並選擇 `kami-0121/Transmtf-HRT-Tracker`。
2. Worker 名稱填 **`atdo-hrt`**（必須與 `wrangler.toml` 的 `name` 相同）。
3. 建置設定：
   - Build command：`npm test && npm run build`（測試失敗就不部署）
   - Deploy command：`npx wrangler deploy`
4. Production branch：選要上線的分支（建議合併到 `main` 後以 `main` 為 production）。
5. 第一次部署時 wrangler 會自動建立名為 `atdo-hrt` 的 D1 資料庫並綁定為 `DB`；資料表由 Worker 在第一次收到 API 請求時自動建立（`server/schema.ts`），不需手動 migration。
   - 若你的帳號不支援自動建立：先執行 `npx wrangler d1 create atdo-hrt`，把輸出的 `database_id` 加到 `wrangler.toml` 的 `[[d1_databases]]`。

網址：`https://atdo-hrt.<你的子網域>.workers.dev`（可在 Worker 的 **Settings → Domains & Routes** 綁定自己的網域）。

## 登入方式：只有 Google

和 AtDo 一樣，**只能用 Google 登入**，沒有帳號密碼的註冊／登入（不必保管、也不會外洩密碼）。第一次用 Google 登入時自動建立帳號。OAuth 2.0 授權碼 + PKCE，只要求 `openid` 權限，**不索取 email 或姓名**，資料庫只存 Google 帳號 id 的雜湊。

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → 建立憑證 → **OAuth 用戶端 ID** → 應用程式類型選「網頁應用程式」。
2. 「已授權的重新導向 URI」加入：`https://<你的網址>/auth/oidc/callback`（例如 `https://atdo-hrt.<子網域>.workers.dev/auth/oidc/callback`；有自訂網域就兩個都加）。
3. OAuth 同意畫面：範圍只需要 `openid`，不需要送審。
4. `GOOGLE_CLIENT_ID` 已寫在 `wrangler.toml`（用戶端 ID 本來就公開在 Google 授權網址上，不是祕密）。
   **用戶端密鑰不可放進 repo**：Cloudflare Dashboard → Worker → Settings → Variables and Secrets → 新增，類型選 **Secret**，名稱 `GOOGLE_CLIENT_SECRET`；或執行 `npx wrangler secret put GOOGLE_CLIENT_SECRET`。
5. 重新部署後，登入頁會出現「使用 Google 登入」。沒設定密鑰時，登入頁會顯示「Google 登入尚未設定」。

本機開發：在專案根目錄建 `.dev.vars`（已加入 .gitignore）寫入 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`。

## 其他設定（Dashboard → Worker → Settings → Variables and Secrets）

| 變數 | 用途 |
|---|---|
| `GOOGLE_CLIENT_SECRET`（Secret） | 啟用 Google 登入（必要） |
| `REGISTRATION_DISABLED = "true"` | 不再為第一次登入的 Google 帳號開戶（已有帳號照常使用），例如只想自己用時 |
| `CLOUD_ENABLED = "false"` | 改回純本機模式（不顯示帳號、不發任何請求） |

## 伺服器端保護

- 每位使用者每分鐘最多 30 次上傳（超過回 429，App 會稍後自動重試）。
- API 回應帶安全標頭（禁止嵌入、禁止 MIME 推測、不送 Referrer）；頁面禁止被嵌入 iframe。
- 每日排程（`wrangler.toml` 的 `[triggers]`，UTC 03:15）清除過期登入、未完成的 Google 授權與舊的限速紀錄。
- 資料表版本化升級（`server/schema.ts` 的 `MIGRATIONS`），舊資料庫第一次收到請求時自動升級，不需手動 migration。

## 本機開發與測試

```bash
npm run build
npx wrangler dev                      # App + API + 本機 D1（.wrangler/state）
npm run deploy                        # = npm test && npm run build && npx wrangler deploy
```

## 這個後端不提供的功能

分享連結、頭像上傳與使用統計（API 回 501，介面自動隱藏）。第三方登入改用 Google（原專案的 Transmtf 登入只在接外部後端時使用）。若要改接相容原專案 API 的完整後端，設定 `VITE_API_BASE_URL`。
