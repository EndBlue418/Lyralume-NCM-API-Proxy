# Source and attribution

The QRC decoder in `lib/qrc-decrypt.js` is derived from Folia Major, commit
`7701347918a4177c1c57b538d7556db9606be67a`,
https://github.com/chthollyphile/folia-major/blob/7701347918a4177c1c57b538d7556db9606be67a/src/utils/lyrics/providers/qrcDecrypt.ts

Folia Major is licensed under GNU AGPL version 3. The modified decoder replaces
browser streaming decompression with bounded Node zlib decompression and exposes
a CommonJS entry point. The upstream algorithm and attribution are retained.

Lyralume NCM API Proxy is distributed under GNU AGPL version 3; see LICENSE.
Its corresponding source snapshot is offered at `/api/source`, including API,
library and test code, dependency lockfile and build and deployment instructions.
Run `node scripts/build-source.js` after every source change before deployment.
The endpoint contains no environment values, credentials, Redis contents or lyrics.

Dependencies retain their own licenses: node-fetch (MIT), jpeg-js (BSD-3-Clause),
pngjs (MIT), xml-js (MIT), and their dependencies as declared in package-lock.json.

Upstream music API
------------------
This proxy is separate from NeteaseCloudMusicApiEnhanced/api-enhanced:
https://github.com/neteasecloudmusicapienhanced/api-enhanced
Fork and deploy that project separately under its own license. Its implementation
is not bundled or relicensed here. A shared public domain is implemented with
reverse-proxy routing, not by merging the two codebases.

The self-hosted Redis adapter uses the redis package (MIT); dependency licenses
remain as declared by each dependency.

Proxy integration and public distribution: EndBlue. Assisted by Codex.
