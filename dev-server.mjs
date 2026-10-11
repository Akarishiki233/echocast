/**
 * EchoCast Local Development Server (dev-server.mjs)
 * 纯 Node.js 原生开发服务器 (零 npm 外部依赖，基于 Node 18+ Web API)
 * 可直接运行 `node dev-server.mjs` 进行本地调试与 curl 验证
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './_worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = parseInt(process.env.PORT || '8787', 10);

// MIME 类型字典
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// 静态资产代理对象（模拟 Cloudflare Pages env.ASSETS）
const assetsAdapter = {
  async fetch(webReq) {
    const url = new URL(webReq.url);
    let pathname = url.pathname;
    if (pathname === '/' || pathname === '') {
      pathname = '/index.html';
    }

    const filePath = path.join(__dirname, pathname);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return new Response('Not Found', { status: 404 });
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);

    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': contentType,
      },
    });
  },
};

// 本地环境环境变量聚合
const devEnv = {
  DEEPSEEK_KEY: process.env.DEEPSEEK_KEY || '',
  MINIMAX_KEY: process.env.MINIMAX_KEY || '',
  MINIMAX_GROUP_ID: process.env.MINIMAX_GROUP_ID || '',
  MOCK_EXTERNAL_APIS: process.env.MOCK_EXTERNAL_APIS || (!process.env.DEEPSEEK_KEY ? 'true' : 'false'),
  ASSETS: assetsAdapter,
  DB: null, // worker 内部自动启用高保真内存 DB 适配器
  BUCKET: null, // worker 内部自动启用高保真内存 R2 适配器
};

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || 'localhost:' + PORT}${req.url}`;
    
    // 收集请求体
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method || '') && bodyBuffer.length > 0;

    // 转换为 Web API Request
    const headers = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
      if (Array.isArray(val)) {
        val.forEach(v => headers.append(key, v));
      } else if (val !== undefined) {
        headers.set(key, val);
      }
    }

    const webRequest = new Request(url, {
      method: req.method,
      headers,
      body: hasBody ? bodyBuffer : undefined,
      duplex: 'half',
    });

    // 模拟 ctx
    const ctx = {
      waitUntil(promise) {
        promise.catch(err => console.error('[Background Task Error]', err));
      },
    };

    // 调用 Worker Fetch 处理逻辑
    const webResponse = await worker.fetch(webRequest, devEnv, ctx);

    // 将 Web Response 回写给 Node HTTP Server
    res.statusCode = webResponse.status;
    webResponse.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const responseBytes = await webResponse.arrayBuffer();
    res.end(Buffer.from(responseBytes));
  } catch (err) {
    console.error('[Dev Server Error]', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Internal Server Error: ' + err.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🎙️  EchoCast 本地开发服务器已启动`);
  console.log(`📍 Web 访问地址: http://127.0.0.1:${PORT}`);
  console.log(`⚙️  Mock 外部 API 模式: ${devEnv.MOCK_EXTERNAL_APIS === 'true' ? '已开启 (无须真实 API Key)' : '已关闭 (使用真实 API)'}`);
  console.log(`======================================================\n`);
});
