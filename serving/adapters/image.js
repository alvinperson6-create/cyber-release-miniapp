// 赛博放生 · 配图适配器
//
// 边界：非阻塞、受预算限制。配图失败绝不影响文字送达。
// 落盘目录由 runtime 注入（生产指向前端公开资源目录），导入本模块不建目录。

const fs = require('node:fs');
const path = require('node:path');

function detectImageExt(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 6) === 'GIF89a') return '.gif';
  return '.jpg';
}

function isVisualForImageComplete(vfi) {
  if (!vfi) return false;
  return !!(vfi.style && vfi.subject && vfi.place);
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

/**
 * 创建配图适配器实例。
 * @param deps.imageDir 落盘目录（注入，不在导入期创建）
 * @param deps.onCall 记账回调
 */
function createImageAdapter({ imageDir, clock, onCall = () => {}, logger = console } = {}) {
  function ensureDir() {
    if (imageDir && !fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });
    return imageDir;
  }

  function saveBuffer(buffer) {
    const dir = ensureDir();
    if (!dir) return null;
    const ext = detectImageExt(buffer);
    const filename = `letter-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
    fs.writeFileSync(path.join(dir, filename), buffer);
    return `/images/${filename}`;
  }

  /**
   * 生成来信配图。永远不抛异常：失败返回 null，由调用方标记 image_status='failed'。
   */
  async function generate({ feeling, creature, water, location, ending, visualForImage, journeyId = null, taskId = null, now }) {
    const apiKey = process.env.IMAGE_API_KEY;
    const baseURL = process.env.IMAGE_BASE_URL;
    const model = process.env.IMAGE_MODEL;
    if (!apiKey || !baseURL || !model) return null;

    let prompt = '';
    if (isVisualForImageComplete(visualForImage)) {
      prompt = buildImagePromptFromVisualForImage(visualForImage, creature, ending);
    }
    if (!prompt) {
      prompt = `${location || water || ''}，${creature}，${ending.slice(0, 80)}，画面有故事感，无文字，无UI。`;
    }

    const t0 = Date.now();
    try {
      const resp = await fetch(`${baseURL}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, prompt, n: 1, size: '1024x1024', quality: 'low', format: 'jpeg' })
      });
      if (!resp.ok) {
        onCall({
          journeyId, taskId, kind: 'image', provider: 'image', model,
          usage: null, latencyMs: Date.now() - t0, status: 'error',
          error: `image ${resp.status}`, now: now ?? (clock ? clock.now() : Date.now())
        });
        return null;
      }
      const data = await resp.json();
      const item = data.data?.[0];
      let url = null;
      if (item?.b64_json) {
        url = saveBuffer(Buffer.from(item.b64_json, 'base64'));
      } else if (item?.url) {
        const imgResp = await fetch(item.url);
        if (!imgResp.ok) throw new Error(`download image ${imgResp.status}`);
        url = saveBuffer(Buffer.from(await imgResp.arrayBuffer()));
      }
      onCall({
        journeyId, taskId, kind: 'image', provider: 'image', model,
        usage: null, latencyMs: Date.now() - t0, status: url ? 'ok' : 'error',
        error: url ? null : 'no image payload', now: now ?? (clock ? clock.now() : Date.now())
      });
      return url;
    } catch (err) {
      onCall({
        journeyId, taskId, kind: 'image', provider: 'image', model,
        usage: null, latencyMs: Date.now() - t0, status: 'error',
        error: err.message, now: now ?? (clock ? clock.now() : Date.now())
      });
      logger.warn?.('[image] generate failed:', err.message);
      return null;
    }
  }

  return { generate };
}

module.exports = { createImageAdapter, detectImageExt, buildImagePromptFromVisualForImage, isVisualForImageComplete };
