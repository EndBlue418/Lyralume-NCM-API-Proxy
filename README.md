# Lyralume NCM API Proxy

供 [Lyralume for VRC](https://github.com/EndBlue418/Lyralume-for-VRC) 使用的 Netease Cloud Music 歌詞、歌曲資料與封面代理。

Created by **EndBlue** · Assisted by Codex

**先 Fork、部署 NCM API，再 Fork、部署這個 Proxy。** 兩個專案分開運行，可用反向代理讓使用者從同一個網域存取。

本倉庫只包含 Proxy，不包含 NCM API 的實作。沒有預設可用的上游站點，也不附 Redis 帳密。

## 一、先 Fork 並部署 NCM API

1. 開啟官方上游 [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced)，按 **Fork**。
2. 在 Vercel 新建專案，匯入**自己的 API Fork**，依上游的 Vercel 部署說明完成部署。
3. 記下 API 專案的正式網址，例如 `https://your-ncm-api.vercel.app`。所有範例網址都要換成自己的。
4. 用已知有效的 NCM 歌曲 ID 測試 `/song/detail?ids=<ID>`。應收到 JSON，而不是 Vercel 登入頁。

API 專案的更新與授權依官方上游處理。使用新版上游前，先確認 `/song/detail`、`/lyric/new`、`/lyric` 仍相容。

## 二、再 Fork 並部署此 Proxy

1. **Fork 本倉庫**，再於 Vercel 新建另一個專案，匯入自己的 Proxy Fork。
2. Framework Preset 選 **Other**，Root Directory 使用倉庫根目錄。使用 Node.js 24，保留套件的 `vercel-build` 建置流程。
3. 為 Proxy 連接自己的 Upstash Redis；不同部署環境應使用分開的資料庫。
4. 在 **Proxy 專案**設定下表的環境變數，然後 Deploy。修改變數後須 Redeploy。

| 變數 | 內容 |
|---|---|
| `NETEASE_API_URL` | **API 專案**的正式網址，例如 `https://your-ncm-api.vercel.app`，不要填 Proxy 自己 |
| `UPSTASH_REDIS_REST_URL` | 自己的 Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | 自己的 Redis REST Token，只存於環境變數 |
| `LYRALUME_CACHE_MAX_SONGS` | 可選，例如 `100`，保留最近使用的 100 首歌曲資料 |

Marketplace 若提供 `KV_REST_API_URL`、`KV_REST_API_TOKEN`，亦可使用這組名稱，不需要同時設定兩組。

缺少上游設定時不會連到作者的服務。缺少 Redis 時，`/api/udon` 無法提供共享快取。資料庫需支援 EVAL、排序集合及一般 Redis 字串指令。

記下 **Proxy 專案**的正式網址，例如 `https://your-proxy.vercel.app`。在 Vercel Deployment Protection 設定中，確認實際使用的正式網址不要求 Vercel 帳號登入，否則 VRChat 無法讀取回應。

## 三、讓兩個專案共用對外網域

只把自訂網域綁到 **Proxy 專案**，不必把同一網域同時綁到 API 專案。沒有自訂網域，也可使用 Proxy 的 `.vercel.app` 網址。

1. 在自己的 Proxy Fork，把 [vercel.same-domain.example.json](vercel.same-domain.example.json) 的內容複製到 `vercel.json`。
2. 將其中兩個 `https://your-ncm-api.vercel.app` 都換成**第一步部署的 API 專案正式網址**，保留 `/:path*`。
3. Commit 後等待 Vercel 重新部署。範例檔未套用到 `vercel.json` 時不會生效。
4. `NETEASE_API_URL` 仍填 API 專案的直接位址；不要改成 Proxy 自己或自己的 `/netease`，避免繞路或遞迴請求。

最後的路由如下：

| 對外路徑（都在 Proxy 網域下） | 實際處理位置 |
|---|---|
| `/netease/song/detail?ids=<ID>` | 自己部署的 NCM API |
| `/api/proxy` | 一般歌詞代理 |
| `/api/udon` | Udon 固定網址與快取協定 |
| `/api/cover` | 封面代理 |
| `/api/source` | Proxy 對應原始碼快照 |

這是 [Vercel external rewrites](https://vercel.com/docs/routing/rewrites)：外部看到同一個網域，內部仍是兩個服務。Proxy 不儲存音樂檔。

## 四、填入 Lyralume

| 欄位 | 內容 |
|---|---|
| Base URL | `https://your-proxy.vercel.app`，或綁在 Proxy 的自訂網域 |
| Proxy Path | `/api/proxy` |
| Udon Path | `/api/udon` |

Base 不要加 `/api` 或 `/netease`。`/netease` 提供原始 NCM API，不能替代 Lyralume 的 Proxy／Udon 協定。

## 五、部署後檢查

- 開啟 `/api/source`：應看到 `license`、`instructions`、`files`，不能包含環境值或金鑰。
- 開啟 `/api/udon?op=catalogue`：應收到 JSON；剛部署時目錄為空是正常的。
- 用有效歌曲 ID 測試 `/api/proxy?url=<URL-encoded NCM song URL>`。
- 套用同網域設定後，測試 `/netease/song/detail?ids=<ID>`，確認同一網域可取得 API JSON。
- 最後在自己的世界執行 Build & Test，確認歌詞、翻譯與封面。

詳細端點與快取規則見 [API 說明](docs/API.md)，完整變數範例見 [.env.example](.env.example)。勿把 `.env` 或 Redis Token 提交到 GitHub。

## 本機與自架

```sh
npm ci
npm test
npm run vercel-build
npm start
```

先把 `.env.example` 複製成自己的設定並載入環境變數；`npm start` 不會自動讀取 `.env`。常駐 Node 服務可用 `REDIS_URL` 連接自己的 Redis；Vercel 使用 Redis REST 變數。不可用 Function 記憶體取代共享 Redis。

`LYRALUME_CACHE_MAX_SONGS=100` 保留最多 100 首最近使用的歌曲資料，不依一小時自動到期，超出數量時淘汰最久未使用者。快取不含音樂檔。未設定此變數時，保留原先一小時、最多 32 首的目錄策略。

## 授權與來源

Proxy 為 **AGPL-3.0-only**。QRC 解碼部分改作自 Folia Major，保留來源 commit 與授權聲明；詳見 [NOTICE.md](NOTICE.md) 與 [LICENSE](LICENSE)。`/api/source` 供應隨部署更新的對應原始碼，修改後重新部署請保留此來源供應。

NCM API 上游由其原作者維護，依其 MIT 授權使用；此倉庫不重新分發或宣稱擁有該 API 實作。

## English

Fork and deploy [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced) first. Then fork this proxy and deploy it as a separate Vercel project with your own upstream URL and Redis REST credentials. No author-hosted service is configured by default.

To share the proxy's public domain, copy `vercel.same-domain.example.json` to `vercel.json`, replace the example API origin, and redeploy. `/netease/*` forwards to your API; `/api/proxy` and `/api/udon` remain proxy endpoints. Configure Lyralume with the proxy's base URL.
