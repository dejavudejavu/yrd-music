#!/usr/bin/env node
/*
 * 皮卡丘的音乐站 · 本地静态服务器
 * ---------------------------------------------------------------------------
 * 零依赖，仅使用 Node.js 内置模块。
 *   node server.js                  # http://127.0.0.1:5173
 *   node server.js --port 8080      # 指定端口
 *   node server.js --host 0.0.0.0   # 同时允许局域网设备（手机）访问
 * 也可使用环境变量 PORT / HOST。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;

function parseArgs(argv) {
  const opts = {
    port: parseInt(process.env.PORT, 10) || 5173,
    host: process.env.HOST || '127.0.0.1'
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      opts.port = parseInt(argv[++i], 10) || opts.port;
    } else if (arg.startsWith('--port=')) {
      opts.port = parseInt(arg.split('=')[1], 10) || opts.port;
    } else if (arg === '--host' && argv[i + 1]) {
      opts.host = argv[++i];
    } else if (arg.startsWith('--host=')) {
      opts.host = arg.split('=')[1];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
皮卡丘的音乐站 · 本地服务器

用法:
  node server.js [选项]

选项:
  --port, -p <端口>   监听端口，默认 5173
  --host <地址>       监听地址，默认 127.0.0.1
                     手机调试可用 0.0.0.0
  --help, -h          显示帮助

示例:
  npm start
  node server.js --host 0.0.0.0 --port 8080
`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  }, headers || {}));
  res.end(body);
}

function isInsideRoot(filePath) {
  const rel = path.relative(ROOT, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function serveFile(req, res, filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Last-Modified': stat.mtime.toUTCString()
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, Object.assign({ 'Cache-Control': 'no-cache' }, headers));
    res.end();
    return;
  }

  res.writeHead(200, Object.assign({ 'Cache-Control': 'no-cache' }, headers));
  const stream = fs.createReadStream(filePath);
  stream.on('error', err => {
    console.error('[stream error]', err.message);
    res.destroy();
  });
  stream.pipe(res);
}

function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    });
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  // 阻止路径穿越
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(ROOT, safePath);

  if (!isInsideRoot(filePath)) {
    send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      fs.stat(filePath, (err2, stat2) => {
        if (!err2 && stat2.isFile()) {
          serveFile(req, res, filePath, stat2);
        } else {
          send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
        }
      });
      return;
    }

    if (!err && stat.isFile()) {
      serveFile(req, res, filePath, stat);
      return;
    }

    // 单页应用回退：未知路径返回 index.html
    const fallback = path.join(ROOT, 'index.html');
    fs.stat(fallback, (err3, stat3) => {
      if (!err3 && stat3.isFile()) serveFile(req, res, fallback, stat3);
      else send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    });
  });
}

function getLanIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function start(port, host, attemptsLeft) {
  const server = http.createServer(handleRequest);

  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0 && !process.env.PORT) {
      const nextPort = port + 1;
      console.log(`端口 ${port} 已被占用，尝试 ${nextPort} …`);
      start(nextPort, host, attemptsLeft - 1);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`\n端口 ${port} 已被占用。请用 --port 指定其他端口，例如：node server.js --port 8080\n`);
    } else {
      console.error('\n服务器启动失败：', err.message, '\n');
    }
    process.exit(1);
  });

  server.listen(port, host, () => {
    const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    console.log('\n  ⚡  皮卡丘的音乐站 · Pikachu Music\n');
    console.log(`  本机访问:   http://${shownHost}:${port}/`);
    if (host === '0.0.0.0' || host === '::') {
      const ips = getLanIPs();
      if (ips.length) {
        console.log('  局域网访问（手机与电脑需在同一 Wi-Fi）:');
        ips.forEach(ip => console.log(`              http://${ip}:${port}/`));
      } else {
        console.log('  未检测到局域网 IPv4 地址。');
      }
    } else {
      console.log('  手机调试:   node server.js --host 0.0.0.0');
    }
    console.log('\n  按 Ctrl+C 停止服务。\n');
  });
}

const opts = parseArgs(process.argv);
start(opts.port, opts.host, 20);
