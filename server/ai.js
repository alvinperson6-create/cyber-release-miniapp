// 赛博放生 · AI 服务（v2：模型调用边界）
//
// 职责收敛（handoff §4.3）：只保留「文本模型调用 + 图片生成」这一层边界。
// 旧四集提示词 / 回信模板 / 命运轨迹解析已随旧产品下线（历史版本见 legacy/story-v0/ 与 docs/jev-baseline/）。
// 导演层提示词契约在 director.js；JEV 判断在 jev.js / situations.js。
//
// 环境变量：
//   AI_PROVIDER = openai | claude | doubao | qianfan (默认 doubao)
//   AI_API_KEY / AI_BASE_URL / AI_MODEL
//   IMAGE_API_KEY / IMAGE_BASE_URL / IMAGE_MODEL（可选；未配置则无配图）

const fs = require('fs');
const path = require('path');

const IMAGE_DIR = path.join(__dirname, 'public', 'images');
if (!fs.existsSync(IMAGE_DIR)) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

const PROVIDERS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  claude: {
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-haiku-20241022'
  },
  doubao: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2-0-lite-260215'
  },
  qianfan: {
    // 百度千帆 OpenAI 兼容协议（与图像生成共用 key）
    baseUrl: 'https://qianfan.baidubce.com/v2',
    model: 'deepseek-v4-flash'
  }
};

function getConfig() {
  const provider = (process.env.AI_PROVIDER || 'doubao').toLowerCase();
  const preset = PROVIDERS[provider] || PROVIDERS.doubao;
  return {
    provider,
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL || preset.baseUrl,
    model: process.env.AI_MODEL || preset.model
  };
}

function isAIEnabled() {
  return !!getConfig().apiKey;
}

// ==================== 文本模型调用 (Node 原生 fetch, Node 18+) ====================
async function chatCompletion(messages, options = {}) {
  const cfg = getConfig();
  const url = cfg.baseUrl + '/chat/completions';
  const body = {
    model: cfg.model,
    messages,
    temperature: options.temperature ?? 0.85,
    max_tokens: options.max_tokens ?? 1200
  };

  // 千帆 DeepSeek-V4(如 -0731)是混合推理模型、默认开启深度思考：思考过程写入
  // reasoning_content，会挤占 max_tokens，预算不足时正式 content 反而为空。
  // 因此默认关闭思考(更快更省、结构化输出更稳)；仅当 options.thinking === true 时
  // 保留推理——此时调用方必须把 max_tokens 调到足以同时容纳思维链与最终答案。
  if (cfg.provider === 'qianfan' && options.thinking !== true) {
    body.thinking = { type: 'disabled' };
  }

  const t0 = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`AI API ${resp.status}: ${text.slice(0, 200)}`);
    err.latencyMs = Date.now() - t0;
    throw err;
  }
  const data = await resp.json();
  const msg0 = data.choices?.[0]?.message || {};
  const content = msg0.content || '';
  const finishReason = data.choices?.[0]?.finish_reason;
  console.log(`[ai] → ${cfg.provider}/${cfg.model} ← ${resp.status} ${Date.now() - t0}ms tokens=${data.usage?.total_tokens || '?'} finish=${finishReason} content=${content.length}字`);
  const rawUsage = data.usage || {};
  return {
    content,
    usage: {
      input_tokens: rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? 0,
      output_tokens: rawUsage.output_tokens ?? rawUsage.completion_tokens ?? 0,
      total_tokens: rawUsage.total_tokens ?? null
    },
    model: data.model || cfg.model,
    finishReason,
    latencyMs: Date.now() - t0
  };
}

// ==================== 图片：落盘与生成 ====================
function detectImageExt(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 6) === 'GIF89a') return '.gif';
  return '.jpg';
}

function saveBase64Image(b64Data) {
  try {
    const buffer = Buffer.from(b64Data, 'base64');
    const ext = detectImageExt(buffer);
    const filename = `letter-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
    const filepath = path.join(IMAGE_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    console.log(`[ai] image saved from b64: ${filename} (${buffer.length} bytes)`);
    return `/images/${filename}`;
  } catch (err) {
    console.warn('[ai] saveBase64Image failed:', err.message);
    return null;
  }
}

async function downloadImage(remoteUrl) {
  if (!remoteUrl) return null;
  const resp = await fetch(remoteUrl);
  if (!resp.ok) {
    throw new Error(`download image ${resp.status}: ${resp.statusText}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  const ext = detectImageExt(buffer);
  const filename = `letter-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
  const filepath = path.join(IMAGE_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  console.log(`[ai] image downloaded: ${filename} (${buffer.length} bytes)`);
  return `/images/${filename}`;
}

function buildImagePromptFromVisualForImage(vfi, creatureName, ending) {
  if (!vfi) return '';
  const parts = [
    vfi.style,
    `画面主体：${vfi.subject || creatureName + '，位于画面中心或前景，占比明显'}`,
    vfi.action ? `动作状态：${vfi.action}` : '',
    vfi.place ? `场景地点：${vfi.place}` : '',
    vfi.bgElements ? `背景元素：${vfi.bgElements}` : ''
  ].filter(Boolean);
  const base = parts.join('。');
  const storyContext = ending ? `\n故事背景（用于理解画面情绪，不要直接画成文字）：${ending.slice(0, 200)}` : '';
  return base ? `${base}。画面有故事感，让人一眼就想知道发生了什么。${storyContext}构图主体突出，无文字，无UI。` : '';
}

function isVisualForImageComplete(vfi) {
  if (!vfi) return false;
  return !!(vfi.style && vfi.subject && vfi.place);
}

async function fetchImageWithRetry(url, options, retries = 2) {
  const fetch = require('node-fetch');
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, { ...options, timeout: 300 * 1000 });
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise(r => setTimeout(r, (i + 1) * 3000));
    }
  }
  throw lastErr;
}

/**
 * 从已确认的来信文本与画面事实生成配图（非阻塞：失败返回 null，不影响文字送达）。
 */
async function generateReplyImage({ feeling, creature, water, destinySummary, replyText }) {
  const apiKey = process.env.IMAGE_API_KEY;
  const baseURL = process.env.IMAGE_BASE_URL;
  const model = process.env.IMAGE_MODEL;
  if (!apiKey || !baseURL || !model) return null;

  const ending = destinySummary?.ending || replyText || '';
  let prompt = '';
  const vfi = destinySummary?.visualForImage;
  if (isVisualForImageComplete(vfi)) {
    prompt = buildImagePromptFromVisualForImage(vfi, creature, ending);
  }
  if (!prompt) {
    prompt = `${destinySummary?.location || water || ''}，${creature}，${ending.slice(0, 80)}，画面有故事感，无文字，无UI。`;
  }

  console.log(`[ai] image prompt: ${prompt.slice(0, 220)}...`);

  try {
    const body = {
      model,
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'low',
      format: 'jpeg'
    };
    const t0 = Date.now();
    const resp = await fetchImageWithRetry(`${baseURL}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn(`[ai] ← image ${resp.status}: ${text.slice(0, 300)}`);
      return null;
    }

    const data = await resp.json();
    console.log(`[ai] ← image 200  ${Date.now() - t0}ms`);
    const item = data.data?.[0];
    if (item?.b64_json) return saveBase64Image(item.b64_json);
    if (item?.url) return await downloadImage(item.url);
    console.warn('[ai] no image url or b64_json in response');
    return null;
  } catch (err) {
    console.warn('[ai] generateReplyImage failed:', err.message);
    return null;
  }
}

module.exports = {
  isAIEnabled,
  getConfig,
  chatCompletion,
  generateReplyImage
};
