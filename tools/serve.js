/* 零依赖静态服务器：npm start（默认 http://127.0.0.1:8080）。
   也可以直接用浏览器打开 index.html，游戏不依赖任何构建步骤或网络资源。 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 8080);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

http.createServer(function (req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (e) { res.writeHead(400).end('bad request'); return; }
  if (rel === '/') rel = '/index.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep) && file !== root) {
    res.writeHead(403).end('forbidden'); return;
  }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', function () {
  console.log('滚木归位 → http://127.0.0.1:' + port);
});
