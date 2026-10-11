/**
 * EchoCast Frontend Client Application (app.js)
 * 纯静态 SPA，无需构建步骤，直接适配 Cloudflare Pages 部署
 */

// 当前活跃的任务 ID 与轮询定时器
let currentJobId = null;
let pollTimer = null;
let currentMode = 'url'; // 'url' | 'text'

// 预设体验示例
const SAMPLE_PRESETS = {
  'indie-dev': {
    url: 'https://example.com/indie-dev-pitfall',
    text: `【独立开发者的最大敌人不是技术，而是逃避商业验证】
很多工程师在开启独立开发项目时，往往习惯于把大量精力放在技术选型、微服务架构和代码极致优雅上。然而，技术复杂性往往成为了逃避直面真实用户反馈的心理避难所。真正的商业验证应该在第一周就发生，而不是写了三个月代码之后才发现根本无人愿意付费。产品壁垒从来不是代码行数，而是解决痛点的精准度。
作者痛陈：很多独立开发者沉迷于打磨后台管理界面、追求 100% 单元测试覆盖率，却不敢发一条推特或在社区公开寻找前10个种子用户。技术能力强反倒成了认知阻碍——因为写代码比被用户拒绝要舒服得多。`
  },
  'ai-bubble': {
    url: 'https://example.com/ai-app-reality',
    text: `【大模型落地潮中的自嗨与真相】
当前 AI 创业热潮中，90% 的所谓“颠覆性应用”本质上只是把大模型 API 做了一层浅显的套壳。当底层模型（如 GPT-4、Claude 3.5）下一次迭代直接原生支持对应能力时，这些创业公司的防御工事在一夜之间就会崩塌。
真正的商业壁垒不在 Prompt 工程，而在专有业务流沉淀、高频工作习惯绑定以及私有闭环数据。那些吹嘘“颠覆一切”的 PPT 狂热者，正在忽视企业客户对数据隐私、确定性输出以及幻觉容忍度为零的残酷现实。`
  }
};

/**
 * 切换输入模式 (URL vs 文本)
 */
function switchTab(mode) {
  currentMode = mode;
  const tabUrlBtn = document.getElementById('tab-url-btn');
  const tabTextBtn = document.getElementById('tab-text-btn');
  const panelUrl = document.getElementById('panel-url');
  const panelText = document.getElementById('panel-text');

  if (mode === 'url') {
    tabUrlBtn.classList.add('active');
    tabTextBtn.classList.remove('active');
    panelUrl.classList.add('active');
    panelText.classList.remove('active');
  } else {
    tabUrlBtn.classList.remove('active');
    tabTextBtn.classList.add('active');
    panelUrl.classList.remove('active');
    panelText.classList.add('active');
  }
}

/**
 * 快速填充示例内容
 */
function fillExample(key) {
  const sample = SAMPLE_PRESETS[key];
  if (!sample) return;

  if (currentMode === 'url') {
    document.getElementById('input-url').value = sample.url;
  } else {
    document.getElementById('input-text').value = sample.text;
  }
}

/**
 * 渲染情绪标签为带样式的胶囊
 */
function renderDialogueText(text) {
  if (!text) return '';
  return text
    .replace(/\[笑\]/g, '<span class="emotion-tag tag-laugh">😄 笑</span>')
    .replace(/\[打断\]/g, '<span class="emotion-tag tag-interrupt">⚡ 打断</span>')
    .replace(/\[停顿\]/g, '<span class="emotion-tag tag-pause">⏸️ 停顿</span>')
    .replace(/\[冷笑\]/g, '<span class="emotion-tag tag-smirk">😏 冷笑</span>')
    .replace(/\[叹气\]/g, '<span class="emotion-tag tag-pause">😮‍💨 叹气</span>')
    .replace(/\[(.*?)\]/g, '<span class="emotion-tag tag-generic">🏷️ $1</span>');
}

/**
 * 更新流水线进度指示器
 */
function updateProgressStep(stage) {
  const stepExtract = document.getElementById('step-extract');
  const stepScript = document.getElementById('step-script');
  const stepTts = document.getElementById('step-tts');
  const statusTitle = document.getElementById('status-title');
  const statusSub = document.getElementById('status-sub');

  // 重置状态
  stepExtract.className = 'step-item';
  stepScript.className = 'step-item';
  stepTts.className = 'step-item';

  if (stage === 'pending' || stage === 'extracting') {
    stepExtract.classList.add('active');
    statusTitle.textContent = '第 1/3 步：提取核心观点与素材...';
    statusSub.textContent = '通过 Jina Reader 分析文章脉络，拒绝复读，提炼关键论点';
  } else if (stage === 'scripting') {
    stepExtract.classList.add('completed');
    stepScript.classList.add('active');
    statusTitle.textContent = '第 2/3 步：DeepSeek-V3 编排争辩剧本...';
    statusSub.textContent = '阿伦（深入浅出捧哏）vs 大白（毒舌挑刺），注入 [笑][打断] 戏剧冲突';
  } else if (stage === 'synthesizing') {
    stepExtract.classList.add('completed');
    stepScript.classList.add('completed');
    stepTts.classList.add('active');
    statusTitle.textContent = '第 3/3 步：MiniMax Speech-01 拟真语音合成...';
    statusSub.textContent = '双角色声线分段合成，拼接 90 秒完整辩论片花';
  } else if (stage === 'completed') {
    stepExtract.classList.add('completed');
    stepScript.classList.add('completed');
    stepTts.classList.add('completed');
    statusTitle.textContent = '生成完成！';
    statusSub.textContent = '90 秒辩论精华片花已就绪';
  }
}

/**
 * 轮询任务状态
 */
async function pollJobStatus(jobId) {
  try {
    const res = await fetch(`/api/status?job_id=${encodeURIComponent(jobId)}`);
    if (!res.ok) {
      throw new Error(`查询状态失败: HTTP ${res.status}`);
    }

    const data = await res.json();
    updateProgressStep(data.status);

    if (data.status === 'completed') {
      clearInterval(pollTimer);
      pollTimer = null;
      renderResult(data);
      resetGenerateButton();
    } else if (data.status === 'failed') {
      clearInterval(pollTimer);
      pollTimer = null;
      alert(`生成失败: ${data.error || '未知错误'}`);
      resetGenerateButton();
      document.getElementById('status-card').style.display = 'none';
    }
  } catch (err) {
    console.error('Poll error:', err);
  }
}

/**
 * 渲染生成结果
 */
function renderResult(data) {
  document.getElementById('status-card').style.display = 'none';
  const resultCard = document.getElementById('result-card');
  resultCard.style.display = 'block';

  // 基础元数据
  document.getElementById('result-title').textContent = data.title || '观点交锋辩论';
  document.getElementById('result-author').textContent = `原作者：${data.original_author || '原创创作者'}`;

  const sourceLink = document.getElementById('result-source-link');
  if (data.source_url && data.source_url.startsWith('http')) {
    sourceLink.href = data.source_url;
    sourceLink.style.display = 'inline';
  } else {
    sourceLink.style.display = 'none';
  }

  // 音频播放器
  const audioPlayer = document.getElementById('audio-player');
  const downloadLink = document.getElementById('download-audio-link');
  if (data.audio_url) {
    audioPlayer.src = data.audio_url;
    downloadLink.href = data.audio_url;
    downloadLink.style.display = 'inline-block';
  }

  // 逐字稿对谈
  const transcriptList = document.getElementById('transcript-list');
  transcriptList.innerHTML = '';

  const dialogue = data.script?.dialogue || [];
  dialogue.forEach(line => {
    const isA = line.speaker === 'A';
    const card = document.createElement('div');
    card.className = `transcript-line ${isA ? 'speaker-a' : 'speaker-b'}`;

    card.innerHTML = `
      <div class="speaker-header">
        <span class="speaker-title">${isA ? '🎙️ 阿伦（深入浅出捧哏）' : '⚡ 大白（毒舌挑刺质疑）'}</span>
      </div>
      <div class="dialogue-text">${renderDialogueText(line.text)}</div>
    `;
    transcriptList.appendChild(card);
  });

  // 署名尾声
  const outro = document.getElementById('attribution-outro');
  outro.textContent = data.script?.attribution || `观点讨论基于《${data.title}》，原作者 ${data.original_author}，原文链接 ${data.source_url}`;

  // 平滑滚动到结果区域
  resultCard.scrollIntoView({ behavior: 'smooth' });
}

/**
 * 处理生成按钮点击
 */
async function handleGenerate() {
  const btn = document.getElementById('btn-generate');
  const btnText = btn.querySelector('.btn-text');
  const btnSpinner = btn.querySelector('.btn-spinner');

  const urlInput = document.getElementById('input-url').value.trim();
  const textInput = document.getElementById('input-text').value.trim();

  const payload = {};
  if (currentMode === 'url') {
    if (!urlInput) {
      alert('请输入有效的文章链接，或切换到“粘贴长文本”模式');
      return;
    }
    payload.url = urlInput;
  } else {
    if (!textInput) {
      alert('请粘贴文章核心段落或全文内容');
      return;
    }
    payload.text = textInput;
  }

  // UI 进入加载态
  btn.disabled = true;
  btnText.textContent = '启动生成任务...';
  btnSpinner.style.display = 'inline-block';

  document.getElementById('result-card').style.display = 'none';
  const statusCard = document.getElementById('status-card');
  statusCard.style.display = 'block';
  updateProgressStep('pending');
  statusCard.scrollIntoView({ behavior: 'smooth' });

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败 (${res.status})`);
    }

    const data = await res.json();
    currentJobId = data.job_id;

    // 启动轮询检查状态
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (currentJobId) {
        pollJobStatus(currentJobId);
      }
    }, 2000);

    // 立即查询一次
    pollJobStatus(currentJobId);
  } catch (err) {
    alert(`启动失败: ${err.message}`);
    resetGenerateButton();
    statusCard.style.display = 'none';
  }
}

function resetGenerateButton() {
  const btn = document.getElementById('btn-generate');
  const btnText = btn.querySelector('.btn-text');
  const btnSpinner = btn.querySelector('.btn-spinner');
  btn.disabled = false;
  btnText.textContent = '一键生成 90 秒辩论片花';
  btnSpinner.style.display = 'none';
}

/**
 * 付费墙 Modal 控制 (MVP Stub)
 */
function openPaywallModal() {
  const modal = document.getElementById('paywall-modal');
  modal.style.display = 'flex';
  document.getElementById('paywall-result-msg').style.display = 'none';
}

function closePaywallModal() {
  document.getElementById('paywall-modal').style.display = 'none';
}

async function handlePaywallSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('paywall-email').value.trim();
  const submitBtn = document.getElementById('btn-paywall-submit');
  const msgEl = document.getElementById('paywall-result-msg');

  if (!email) return;

  submitBtn.disabled = true;
  submitBtn.textContent = '正在登记...';

  try {
    const res = await fetch('/api/paywall/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: currentJobId || 'sample-job',
        email: email,
      }),
    });

    const data = await res.json();
    msgEl.textContent = data.message || '预约成功！已为您锁定优先内测名额。';
    msgEl.style.display = 'block';
    setTimeout(() => {
      closePaywallModal();
      submitBtn.disabled = false;
      submitBtn.textContent = '确认预约解锁 (免费内测席位)';
    }, 2500);
  } catch {
    msgEl.textContent = '预约提交成功！内测完整版上线后将第一时间发送至您的邮箱。';
    msgEl.style.display = 'block';
    setTimeout(() => {
      closePaywallModal();
      submitBtn.disabled = false;
      submitBtn.textContent = '确认预约解锁 (免费内测席位)';
    }, 2500);
  }
}
