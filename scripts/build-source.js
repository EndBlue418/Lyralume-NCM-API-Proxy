const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = ['server.js', 'package.json', 'package-lock.json', 'vercel.json', 'vercel.same-domain.example.json', 'README.md', 'NOTICE.md', 'LICENSE', 'scripts/build-source.js'];
for (const folder of ['api', 'lib', 'test', 'docs']) for (const name of fs.readdirSync(path.join(root, folder))) {
  if (name.endsWith('.js') || name.endsWith('.md')) files.push(folder + '/' + name);
}
const bundle = { license: 'AGPL-3.0', instructions: 'npm ci; node --test; node scripts/build-source.js; deploy with Vercel Node runtime. Configure environment variables per README; no credentials are included.', files: {} };
for (const file of files.sort()) bundle.files[file] = fs.readFileSync(path.join(root, file), 'utf8');
fs.writeFileSync(path.join(root, 'api/source-bundle.json'), JSON.stringify(bundle));
console.log('Corresponding source snapshot: ' + files.length + ' files');
