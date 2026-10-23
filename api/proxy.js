const fetch = require('node-fetch');
const { neteaseJson } = require('../lib/netease-upstream');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    const rawUrl = req.query.url; // 玩家輸入的完整網址
    if (!rawUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        // 從完整網址中自動用正则抓取 id (例如 id=3384000719)
        const match = rawUrl.match(/id=([0-9]+)/);
        if (!match) {
            return res.status(400).json({ error: 'Invalid NetEase Song ID in URL' });
        }
        const songId = match[1];

        const [detailData, lyricData] = await Promise.all([
            neteaseJson('/song/detail?ids=' + songId, process.env, fetch),
            neteaseJson('/lyric/new?id=' + songId, process.env, fetch)
        ]);

        // 合併回傳給 Unity
        return res.status(200).json({
            songs: detailData.songs || detailData,
            lrc: lyricData.lrc || {},
            yrc: lyricData.yrc || {}
        });

    } catch (error) {
        return res.status(502).json({ error: error.message });
    }
};