// Assemble Argile en un seul fichier HTML : dist/argile.html (artefact) et dist/argile-standalone.html (à ouvrir localement)
const fs = require('fs');
const path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const scripts = ['core.js', 'sculpt.js', 'gp.js', 'curves.js', 'sdf.js', 'samples.js', 'io.js', 'renderer.js', 'app.js'].map((f) => `<script>\n${src(f).replace(/<\/script/gi, '<\\/script')}\n</script>`).join('\n');
const body = src('index.html') + '\n' + scripts + '\n';
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'argile.html'), body);
const standalone = '<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n' + body + '</body></html>\n';
fs.writeFileSync(path.join(__dirname, 'dist', 'argile-standalone.html'), standalone);
console.log('dist/argile.html', (body.length / 1024).toFixed(0) + ' Ko');

// Version installable (PWA) : dist/pwa/
const pwaDir = path.join(__dirname, 'dist', 'pwa');
fs.mkdirSync(pwaDir, { recursive: true });
const head = '<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">'
  + '<link rel="manifest" href="manifest.webmanifest"><meta name="theme-color" content="#171615"><meta name="mobile-web-app-capable" content="yes"><link rel="icon" href="icon-192.png">'
  + '</head><body>\n';
const reg = "<script>if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));</script>\n";
fs.writeFileSync(path.join(pwaDir, 'index.html'), head + body + reg + '</body></html>\n');
fs.copyFileSync(path.join(__dirname, 'pwa', 'manifest.webmanifest'), path.join(pwaDir, 'manifest.webmanifest'));
fs.writeFileSync(path.join(pwaDir, 'sw.js'), fs.readFileSync(path.join(__dirname, 'pwa', 'sw.js'), 'utf8').replace('__BUILD__', Date.now().toString(36)));
for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) { const src = path.join(__dirname, 'pwa', f); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pwaDir, f)); }
console.log('dist/pwa/ prêt');
