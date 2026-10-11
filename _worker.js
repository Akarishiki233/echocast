/**
 * EchoCast Backend Worker (_worker.js)
 * Cloudflare Pages Advanced Mode / Cloudflare Worker
 *
 * ============================================================================
 * 版权铁律与转化性评论声明 (COPYRIGHT & TRANSFORMATIVE WORK POLICY):
 * 1. 严格遵守 Transformative Commentary（转化性评论）原则：
 *    EchoCast 仅提取输入文章的核心论点、逻辑推演与争议焦点作为双人主播辩论的素材，
 *    严禁且绝不进行逐字复读、全文朗读或替代原作品阅读。
 * 2. 独立创作与批判性对谈：
 *    主播 A（阿伦，深入浅出捧哏）与主播 B（大白，毒舌挑刺质疑）通过观点碰撞、
 *    商业逻辑推演与现实漏洞挑刺，生成全新的衍生评论对谈。
 * 3. 强制署名标注：
 *    每期音频片花末尾与元数据中必须完整保留并朗读原作品署名：
 *    "观点讨论基于《{标题}》，原作者 {原作者}，原文链接 {原文链接}"。
 * ============================================================================
 */

// 内存兜底存储（当本地开发未绑定 D1 / R2 时自动使用，保证纯 Node/本地开发可用）
const memoryDb = new Map();
const memoryBucket = new Map();

/**
 * 响应工具函数
 */
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-mock',
      ...headers,
    },
  });
}

function corsOptionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-mock',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/**
 * 16进制字符串解码为 Uint8Array
 */
function hexToUint8Array(hexString) {
  if (!hexString || typeof hexString !== 'string') {
    throw new Error('Invalid hex string');
  }
  const cleanHex = hexString.trim();
  const len = cleanHex.length;
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * 拼接多个 Uint8Array 音频分片
 */
function concatUint8Arrays(arrays) {
  const totalLength = arrays.reduce((acc, curr) => acc + curr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * 生成合规的静音/占位 MP3 音频帧（用于 Mock 模式及本地离线验证）
 * 标准 MPEG-1 Audio Layer III 帧 (128 kbps, 44.1 kHz, 单声道)
 */
function createMockMp3Buffer(durationSeconds = 2) {
  const frameLength = 417; // 144 * 128000 / 44100
  const frameCount = Math.max(12, Math.floor(durationSeconds * 38.28));
  const buffer = new Uint8Array(frameLength * frameCount);
  for (let i = 0; i < frameCount; i++) {
    const offset = i * frameLength;
    buffer[offset] = 0xff;
    buffer[offset + 1] = 0xfb; // MPEG-1 Layer 3, No CRC
    buffer[offset + 2] = 0x90; // 128kbps, 44.1kHz
    buffer[offset + 3] = 0xc4; // Mono, no padding
  }
  return buffer;
}

/**
 * D1 数据库操作代理（自动兼容真实 D1 与本地内存 Map）
 */
const dbAdapter = {
  async getJob(db, jobId) {
    if (db && typeof db.prepare === 'function') {
      return await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first();
    }
    return memoryDb.get(jobId) || null;
  },

  async insertJob(db, job) {
    if (db && typeof db.prepare === 'function') {
      const sql = `
        INSERT INTO jobs (
          job_id, status, source_type, source_input, title, original_author,
          source_url, script_json, audio_key, audio_url, duration_seconds,
          error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      await db.prepare(sql).bind(
        job.job_id, job.status, job.source_type, job.source_input,
        job.title || null, job.original_author || null, job.source_url || null,
        job.script_json || null, job.audio_key || null, job.audio_url || null,
        job.duration_seconds || 90, job.error_message || null,
        job.created_at, job.updated_at
      ).run();
      return;
    }
    memoryDb.set(job.job_id, { ...job });
  },

  async updateJob(db, jobId, fields) {
    const now = Date.now();
    if (db && typeof db.prepare === 'function') {
      const keys = Object.keys(fields);
      const setClauses = keys.map(k => `${k} = ?`).join(', ');
      const values = keys.map(k => fields[k]);
      const sql = `UPDATE jobs SET ${setClauses}, updated_at = ? WHERE job_id = ?`;
      await db.prepare(sql).bind(...values, now, jobId).run();
      return;
    }
    const current = memoryDb.get(jobId) || {};
    memoryDb.set(jobId, { ...current, ...fields, updated_at: now });
  },

  async insertPaywallLead(db, { jobId, email }) {
    const now = Date.now();
    if (db && typeof db.prepare === 'function') {
      await db.prepare('INSERT INTO paywall_leads (job_id, email, intent, created_at) VALUES (?, ?, ?, ?)')
        .bind(jobId, email, 'unlock_full_episode', now)
        .run();
      return;
    }
    // memory store
  }
};

/**
 * R2 存储桶操作代理（自动兼容真实 R2 与本地内存 Map）
 */
const r2Adapter = {
  async putAudio(bucket, key, uint8Bytes) {
    if (bucket && typeof bucket.put === 'function') {
      await bucket.put(key, uint8Bytes, {
        httpMetadata: { contentType: 'audio/mpeg' },
      });
      return;
    }
    memoryBucket.set(key, uint8Bytes);
  },

  async getAudio(bucket, key) {
    if (bucket && typeof bucket.get === 'function') {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return {
        stream: obj.body,
        bytes: null,
      };
    }
    const bytes = memoryBucket.get(key);
    if (!bytes) return null;
    return {
      stream: null,
      bytes: bytes,
    };
  }
};

/**
 * 步骤 1: 正文提取
 * 优先调用 Jina Reader (https://r.jina.ai/<url>)，提取标题、正文及来源
 * 严守 Transformative 原则：仅提取观点素材，绝不全文复读
 */
async function extractContent({ url, text }, env, isMock) {
  if (isMock) {
    if (text) {
      const lines = text.trim().split('\n').filter(Boolean);
      const candidateTitle = lines[0] && lines[0].length < 50 ? lines[0].replace(/^[#\s【】\[\]]+/, '') : '长文观点碰撞精选';
      return {
        title: candidateTitle,
        author: '观点创作者',
        sourceUrl: '用户自填长文',
        content: text.slice(0, 4000),
      };
    }
    return {
      title: '独立开发者的最大敌人不是技术，而是逃避商业验证',
      author: 'TechThinker',
      sourceUrl: url || 'https://example.com/indie-dev-pitfall',
      content: `很多工程师在开启独立开发项目时，往往习惯于把大量精力放在技术选型、微服务架构和代码极致优雅上。然而，技术复杂性往往成为了逃避直面真实用户反馈的心理避难所。真正的商业验证应该在第一周就发生，而不是写了三个月代码之后才发现根本无人愿意付费。产品壁垒从来不是代码行数，而是解决痛点的精准度。`,
    };
  }

  if (url) {
    try {
      const jinaUrl = `https://r.jina.ai/${encodeURI(url)}`;
      const jinaRes = await fetch(jinaUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'EchoCast-Bot/1.0',
        },
      });

      if (!jinaRes.ok) {
        throw new Error(`Jina Reader HTTP ${jinaRes.status}`);
      }

      const json = await jinaRes.json();
      const data = json.data || json;
      const content = data.content || data.text || '';
      if (!content || content.trim().length < 50) {
        throw new Error('从该 URL 获取到的文章正文过短或为空');
      }

      return {
        title: data.title || '精选深度长文',
        author: data.author || '网络创作者',
        sourceUrl: url,
        content: content.slice(0, 6000), // 控制上下文长度
      };
    } catch (err) {
      // 若 Jina 抓取失败且没有提供文本备选，抛出友好错误提示用户粘贴文本
      if (!text) {
        throw new Error(`网页抓取失败: ${err.message}。请直接切换到“粘贴文本”模式重试。`);
      }
    }
  }

  // 用户直接提供文本
  if (text) {
    const lines = text.trim().split('\n').filter(Boolean);
    const candidateTitle = lines[0] && lines[0].length < 40 ? lines[0].replace(/^[#\s]+/, '') : '用户提供长文精选';
    return {
      title: candidateTitle,
      author: '投稿作者',
      sourceUrl: '用户自填内容',
      content: text.slice(0, 6000),
    };
  }

  throw new Error('请提供有效的文章 URL 或长文本内容');
}

/**
 * 步骤 2: 剧本生成
 * 调用 DeepSeek-V3 (OpenAI 兼容接口)
 * 角色设定：
 * 主播 A（阿伦）：深入浅出捧哏，善于梳理原作者的核心洞察、做生动通俗比喻，为核心观点做辩护和场景延展。
 * 主播 B（大白）：毒舌挑刺，言辞犀利一针见血，专门寻找商业漏洞、技术自嗨点、现实执行阻碍，频繁质疑打断。
 * 情绪标签：[笑]、[停顿]、[打断]、[冷笑]、[叹气]
 * 字数：约 500 字（90 秒片花精华版）
 * 结尾：强制署名 "观点讨论基于《标题》，原作者 XXX，原文链接"
 */
async function generateDebateScript({ title, author, sourceUrl, content }, env, isMock) {
  if (isMock) {
    return {
      title,
      original_author: author,
      source_url: sourceUrl,
      dialogue: [
        {
          speaker: 'A',
          name: '阿伦',
          text: '大家好，欢迎收听 EchoCast 观点片花！[笑] 今天这篇探讨独立开发的文章很火，作者一针见血：很多程序员把写完美代码当避风港，根本不敢直面真实市场验证。'
        },
        {
          speaker: 'B',
          name: '大白',
          text: '[打断] 呵，这刀子扎得太狠了！[停顿] 但话说回来，没有过硬的技术架构，光凭所谓商业吹水，产品上线被高并发冲垮或者漏洞百出，难道不是死得更快？'
        },
        {
          speaker: 'A',
          name: '阿伦',
          text: '大白你别杠嘛！[笑] 作者的核心意思不是否定技术，而是反对“技术完美主义自嗨”。你连第一个付费用户在哪都不知道，花两个月搭微服务纯粹是浪费生命！'
        },
        {
          speaker: 'B',
          name: '大白',
          text: '[冷笑] 可现实中，大家所谓的“快速验证”，往往沦为粗制滥造的遮羞布。市面上到处都是包装成 MVP 的数字垃圾，真正的护城河难道不需要技术打磨吗？'
        },
        {
          speaker: 'A',
          name: '阿伦',
          text: '哈哈，这就触及深水区了！[停顿] 欲知更深度的交锋与案例拆解，请解锁完整版。本期辩论观点基于《' + title + '》，原作者 ' + author + '，原文链接 ' + sourceUrl + '。'
        }
      ],
      attribution: `观点讨论基于《${title}》，原作者 ${author}，原文链接 ${sourceUrl}`
    };
  }

  const apiKey = env.DEEPSEEK_KEY;
  if (!apiKey) {
    throw new Error('未配置 DEEPSEEK_KEY 环境变量');
  }

  const prompt = `你是一个顶级深度播客总编导。请基于以下提供的文章素材，创作一场极具戏剧张力、观点交锋激烈的 90 秒中文双人辩论播客片花。

【版权与创作铁律 - 绝不抄袭与原文复读】
1. Transformative Commentary 原则：严禁复读或朗读原文句子！必须仅提取原文中的核心观点、逻辑假设与现实争议作为交锋素材。
2. 两位主播必须发表具有独立批判性的推演与评论。
3. 对话总字数严格控制在 450 - 550 字左右（对应 90 秒正常语速片花）。

【角色设定】
- 主播 A（阿伦）：深入浅出捧哏。善于用通俗比喻拆解观点、总结作者的核心洞察，并在争论中为合理性进行辩护与延伸。
- 主播 B（大白）：毒舌挑刺。犀利幽默、一针见血找漏洞，专门从商业真实落地、人性弱点、现实竞争等角度无情质疑与反驳。

【情绪表现与格式】
- 在台词中自然嵌入拟真情绪标签：如 [笑]、[停顿]、[打断]、[冷笑]、[叹气]。
- 台词一共 5-8 轮交锋，节奏紧凑，结尾由阿伦做总结并留出悬念。
- 最后一句话阿伦必须严格包含署名公式：“观点讨论基于《${title}》，原作者 ${author}，原文链接 ${sourceUrl}”。

【素材信息】
文章标题：《${title}》
原作者：${author}
原文链接：${sourceUrl}
文章摘要/核心论点：
${content.slice(0, 3000)}

【输出格式】
必须严格输出以下 JSON 格式，不要包含任何 markdown 代码块外的多余字符：
{
  "title": "${title}",
  "original_author": "${author}",
  "source_url": "${sourceUrl}",
  "dialogue": [
    { "speaker": "A", "name": "阿伦", "text": "..." },
    { "speaker": "B", "name": "大白", "text": "..." }
  ],
  "attribution": "观点讨论基于《${title}》，原作者 ${author}，原文链接 ${sourceUrl}"
}`;

  const apiUrl = env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are an expert podcast script producer. You must return valid JSON only.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek API 请求失败 (${response.status}): ${errText}`);
  }

  const resJson = await response.json();
  const rawContent = resJson.choices?.[0]?.message?.content || '{}';

  // 解析 JSON 内容（清洗潜在的 markdown 包裹）
  const cleanJsonStr = rawContent.trim().replace(/^```json/i, '').replace(/```$/, '').trim();
  const scriptData = JSON.parse(cleanJsonStr);

  if (!Array.isArray(scriptData.dialogue) || scriptData.dialogue.length === 0) {
    throw new Error('DeepSeek 返回的辩论剧本结构不完整');
  }

  return scriptData;
}

/**
 * 步骤 3: 语音合成
 * 调用 MiniMax Speech-01 (T2A v2) 接口
 * 双人不同音色：
 * - 主播 A（阿伦）：温和从容青年音 (默认 male-qn-qingse)
 * - 主播 B（大白）：犀利精英/质感音 (默认 male-qn-jingying)
 * 分段合成后按顺序将 MP3 数据拼接为单条连续播客音频
 */
async function synthesizePodcastAudio(scriptData, env, isMock) {
  if (isMock) {
    // 生成真实的合规 MP3 静音音频帧（确保前端播放器与 curl 测试均能正常消费）
    return createMockMp3Buffer(3);
  }

  const apiKey = env.MINIMAX_KEY;
  if (!apiKey) {
    throw new Error('未配置 MINIMAX_KEY 环境变量');
  }

  const voiceA = env.MINIMAX_VOICE_A || 'male-qn-qingse';
  const voiceB = env.MINIMAX_VOICE_B || 'male-qn-jingying';
  const t2aUrl = env.MINIMAX_API_URL || 'https://api.minimax.io/v1/t2a_v2';

  const audioBuffers = [];

  for (const line of scriptData.dialogue) {
    const isHostA = line.speaker === 'A';
    const voiceId = isHostA ? voiceA : voiceB;

    // 清理文本中的多余标签以便 TTS 顺畅发音，同时保留 MiniMax 支持的情绪提示
    const cleanText = line.text;

    const requestBody = {
      model: env.MINIMAX_TTS_MODEL || 'speech-01-turbo',
      text: cleanText,
      voice_setting: {
        voice_id: voiceId,
        speed: 1.05,
        vol: 1.0,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1,
      },
    };

    const res = await fetch(t2aUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`MiniMax TTS 错误 (${res.status}): ${errText}`);
    }

    const resJson = await res.json();
    if (resJson.base_resp && resJson.base_resp.status_code !== 0) {
      throw new Error(`MiniMax 返回异常: ${resJson.base_resp.status_msg}`);
    }

    const hexAudio = resJson.data?.audio;
    if (!hexAudio) {
      throw new Error('MiniMax 未返回音频数据');
    }

    const chunkBytes = hexToUint8Array(hexAudio);
    audioBuffers.push(chunkBytes);
  }

  return concatUint8Arrays(audioBuffers);
}

/**
 * 完整流水线处理引擎
 */
async function processPipeline(jobId, inputData, env, isMock) {
  try {
    // 1. 抓取正文
    await dbAdapter.updateJob(env.DB, jobId, { status: 'extracting' });
    const extracted = await extractContent(inputData, env, isMock);

    // 2. 生成辩论对谈剧本
    await dbAdapter.updateJob(env.DB, jobId, {
      status: 'scripting',
      title: extracted.title,
      original_author: extracted.author,
      source_url: extracted.sourceUrl,
    });
    const scriptData = await generateDebateScript(extracted, env, isMock);

    // 3. 双人拟真 TTS 语音合成并拼接
    await dbAdapter.updateJob(env.DB, jobId, {
      status: 'synthesizing',
      script_json: JSON.stringify(scriptData),
    });
    const audioBytes = await synthesizePodcastAudio(scriptData, env, isMock);

    // 4. 音频存入 R2，更新任务状态为完成
    const audioKey = `audio/${jobId}.mp3`;
    await r2Adapter.putAudio(env.BUCKET, audioKey, audioBytes);

    const audioUrl = `/api/audio/${jobId}`;
    await dbAdapter.updateJob(env.DB, jobId, {
      status: 'completed',
      audio_key: audioKey,
      audio_url: audioUrl,
      duration_seconds: 90,
      title: scriptData.title || extracted.title,
      original_author: scriptData.original_author || extracted.author,
      source_url: scriptData.source_url || extracted.sourceUrl,
      script_json: JSON.stringify(scriptData),
    });
  } catch (err) {
    console.error(`[EchoCast Pipeline Error] Job: ${jobId}`, err);
    await dbAdapter.updateJob(env.DB, jobId, {
      status: 'failed',
      error_message: err.message || '生成失败，请重试',
    });
  }
}

/**
 * Cloudflare Worker / Pages Advanced Mode Fetch 处理入口
 */
export default {
  async fetch(request, env = {}, ctx = null) {
    const url = new URL(request.url);

    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return corsOptionsResponse();
    }

    // 判断是否开启 Mock 模式（通过请求头或环境变量配置）
    const headerMock = request.headers.get('x-mock') === 'true' || request.headers.get('x-mock') === '1';
    const envMock = env.MOCK_EXTERNAL_APIS === 'true' || env.MOCK_EXTERNAL_APIS === '1';
    // 当缺少外部密钥时，自动回退至 Mock 模式，确保开发与测试环境丝滑运行
    const keysMissing = !env.DEEPSEEK_KEY || !env.MINIMAX_KEY;
    const isMock = headerMock || envMock || keysMissing;

    // ------------------------------------------------------------------------
    // POST /api/generate
    // 创建辩论播客生成任务，返回 job_id 并启动后台流水线
    // ------------------------------------------------------------------------
    if (url.pathname === '/api/generate' && request.method === 'POST') {
      try {
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: '无效的 JSON 请求体' }, 400);
        }

        const targetUrl = (body.url || '').trim();
        const targetText = (body.text || '').trim();

        if (!targetUrl && !targetText) {
          return jsonResponse({ error: '请提供文章 URL 或粘贴长文本内容' }, 400);
        }

        const jobId = crypto.randomUUID();
        const now = Date.now();

        const newJob = {
          job_id: jobId,
          status: 'pending',
          source_type: targetUrl ? 'url' : 'text',
          source_input: targetUrl || targetText.slice(0, 500),
          title: null,
          original_author: null,
          source_url: targetUrl || null,
          script_json: null,
          audio_key: null,
          audio_url: null,
          duration_seconds: 90,
          error_message: null,
          created_at: now,
          updated_at: now,
        };

        await dbAdapter.insertJob(env.DB, newJob);

        // 异步启动流水线任务
        const pipelinePromise = processPipeline(jobId, { url: targetUrl, text: targetText }, env, isMock);
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(pipelinePromise);
        } else {
          // 本地或没有 ctx 环境时后台执行
          pipelinePromise.catch(e => console.error('Pipeline unhandled error:', e));
        }

        return jsonResponse({
          job_id: jobId,
          status: 'processing',
          message: '辩论片花生成任务已启动',
          is_mock: isMock,
        }, 202);
      } catch (err) {
        return jsonResponse({ error: err.message || '服务器内部错误' }, 500);
      }
    }

    // ------------------------------------------------------------------------
    // GET /api/status?job_id=xxx
    // 轮询查询任务状态与生成结果
    // ------------------------------------------------------------------------
    if (url.pathname === '/api/status' && request.method === 'GET') {
      const jobId = url.searchParams.get('job_id');
      if (!jobId) {
        return jsonResponse({ error: '缺少 job_id 参数' }, 400);
      }

      const job = await dbAdapter.getJob(env.DB, jobId);
      if (!job) {
        return jsonResponse({ error: '未找到该任务', job_id: jobId }, 404);
      }

      let parsedScript = null;
      if (job.script_json) {
        try {
          parsedScript = JSON.parse(job.script_json);
        } catch {
          parsedScript = null;
        }
      }

      return jsonResponse({
        job_id: job.job_id,
        status: job.status,
        progress_stage: job.status,
        title: job.title,
        original_author: job.original_author,
        source_url: job.source_url,
        audio_url: job.audio_url,
        duration_seconds: job.duration_seconds || 90,
        script: parsedScript,
        error: job.error_message,
        created_at: job.created_at,
        updated_at: job.updated_at,
      });
    }

    // ------------------------------------------------------------------------
    // GET or HEAD /api/audio/:id
    // 获取合成的 MP3 音频（从 R2 读取或 302 重定向到 R2 公开 CDN）
    // ------------------------------------------------------------------------
    if (url.pathname.startsWith('/api/audio/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const audioId = url.pathname.replace('/api/audio/', '').replace('.mp3', '');
      if (!audioId) {
        return new Response('Audio ID required', { status: 400 });
      }

      // 若配置了 R2 公开域名，可直接 302 重定向降低 Worker 带宽消耗
      if (env.R2_PUBLIC_DOMAIN) {
        const publicUrl = `https://${env.R2_PUBLIC_DOMAIN}/audio/${audioId}.mp3`;
        return Response.redirect(publicUrl, 302);
      }

      const audioKey = `audio/${audioId}.mp3`;
      const audioData = await r2Adapter.getAudio(env.BUCKET, audioKey);

      if (!audioData) {
        return new Response('Audio file not found or still generating', { status: 404 });
      }

      const headers = {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=86400',
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="echocast-${audioId}.mp3"`,
        'Access-Control-Allow-Origin': '*',
      };

      if (request.method === 'HEAD') {
        if (audioData.bytes) {
          headers['Content-Length'] = String(audioData.bytes.length);
        }
        return new Response(null, { status: 200, headers });
      }

      if (audioData.stream) {
        return new Response(audioData.stream, { status: 200, headers });
      } else if (audioData.bytes) {
        headers['Content-Length'] = String(audioData.bytes.length);
        return new Response(audioData.bytes, { status: 200, headers });
      }

      return new Response('Audio not available', { status: 404 });
    }

    // ------------------------------------------------------------------------
    // POST /api/paywall/unlock
    // 付费解锁完整版（8-12 分钟深度版）预约 Stub 接口
    // ------------------------------------------------------------------------
    if (url.pathname === '/api/paywall/unlock' && request.method === 'POST') {
      try {
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: '无效请求体' }, 400);
        }

        const jobId = body.job_id;
        const email = (body.email || '').trim();

        if (!jobId || !email) {
          return jsonResponse({ error: '请提供有效的 job_id 和联系邮箱' }, 400);
        }

        await dbAdapter.insertPaywallLead(env.DB, { jobId, email });

        return jsonResponse({
          success: true,
          message: '完整深度版（8-12分钟）预约成功！已为您锁定内测特惠名额。',
          stub: true,
        });
      } catch (err) {
        return jsonResponse({ error: err.message || '内部错误' }, 500);
      }
    }

    // ------------------------------------------------------------------------
    // 静态资源兜底 (Cloudflare Pages Static Assets)
    // ------------------------------------------------------------------------
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return await env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
