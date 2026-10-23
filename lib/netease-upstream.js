'use strict';



function upstreams(env) {
  const primary = String(env.NETEASE_API_URL || '').trim();
  if (!primary) throw Object.assign(new Error('NETEASE_API_URL has not been configured'), { statusCode: 503 });
  const backups = (env.NETEASE_API_FALLBACK_URLS || '').split(',');
  return [...new Set([primary, ...backups].map(value => value.trim().replace(/\/+$/, '')).filter(Boolean))];
}

// Only deployment-controlled base URLs are used; callers supply no arbitrary hosts.
async function neteaseJson(path, env, fetchImpl, defaultTimeout = 10000) {
  const configured = Number(env.NETEASE_API_TIMEOUT_MS);
  const timeout = Number.isFinite(configured) && configured >= 1000 && configured <= 20000 ? configured : defaultTimeout;
  const bases = upstreams(env);
  for (let i = 0; i < bases.length; i++) {
    try {
      const response = await fetchImpl(bases[i] + path, { signal: AbortSignal.timeout(timeout), redirect: 'error' });
      if (!response.ok) throw new Error('NetEase upstream HTTP failure');
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data) || Number(data.code) >= 400)
        throw new Error('NetEase upstream invalid response');
      if (env.NETEASE_UPSTREAM_LOG === '1')
        console.log('[NetEase upstream] ' + (i === 0 ? 'primary ' : 'backup ') + new URL(bases[i]).origin + ' ' + path.split('?')[0]);
      return data;
    } catch (error) {
      if (env.NETEASE_UPSTREAM_LOG === '1')
        console.warn('[NetEase upstream] failed ' + (i === 0 ? 'primary' : 'backup') + ' ' + path.split('?')[0]);
      if (i + 1 === bases.length)
        throw Object.assign(new Error('NetEase API unavailable'), { statusCode: 502 });
    }
  }
  throw Object.assign(new Error('NetEase API unavailable'), { statusCode: 502 });
}

module.exports = { upstreams, neteaseJson };
