# API 與資料格式

## 一般歌曲與歌詞

`GET /api/proxy?url=<URL-encoded NCM song URL>` 回傳歌曲資料及 `lrc`、`yrc`。由 `url` 取出數字歌曲 ID，再查詢設定的上游；這不是任意網址轉送服務。

## Udon 固定網址協定

`GET /api/udon?op=catalogue` 讀取共享歌曲快取。未命中時，客戶端將 1–12 位數歌曲 ID 補成 12 位、拆成四組三位數，依 `begin`／`part` 槽位流程提交，再取得完成資料。

共有 16 個提交槽位，租約 120 秒。遵守回應的等待狀態及 VRChat 字串下載限制，不需於執行期將任意字串轉成 VRCUrl。網址表與槽位規則見 `lib/udon-protocol.js`；Lyralume 安裝工具會建立相容網址表。

完成資料含 `songId`、`name`、`artist`、`lrc`、`yrc` 及可用封面資訊。可選欄位包括翻譯與羅馬音 `tlyric`、`romalrc`、`ytlrc`、`yromalrc`，逐字時間資料 `lyricTimeline`，輔助歌詞 `secondaryLyrics`，以及 `coverThumbnail`。

NCM 原始逐字歌詞優先。替代來源僅依明確歌曲 ID 對照或嚴格比對取用，不改變歌曲身分。`.env.example` 的擴充開關可停用這些功能；保留原變數名稱以相容既有部署。

## 封面與原始碼

`GET /api/cover?id=<song ID>&size=<supported size>` 回傳圖片。`HEAD` 查詢回應標頭；`OPTIONS` 支援跨來源預檢。只使用驗證過的音樂服務圖片來源與尺寸，不接受任意主機。

`GET /api/source` 回傳由 `scripts/build-source.js` 產生的程式、測試、鎖定檔、部署說明及授權，不含環境值、Redis 資料或播放紀錄。`npm test` 和 Vercel 的 `vercel-build` 都會更新快照；自架修改後須重新執行 `npm run vercel-build`。

## 儲存與備援

Vercel 設定 Redis REST URL／Token；常駐服務可使用 `REDIS_URL`。`LYRALUME_CACHE_MAX_SONGS` 支援 1–1000，啟用有數量上限的持久 LRU；目錄讀取不影響最近使用排名。目錄回應仍有約 3 MB 上限。

`NETEASE_API_FALLBACK_URLS` 可填逗號分隔的其他自建 API。新請求先試主要 API，失敗才依序試備援。不要填 Proxy 自己的位址。
