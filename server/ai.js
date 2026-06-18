// 赛博放生局 · AI 服务
// 支持 OpenAI / Claude / 豆包(火山方舟) 三种 API，统一走 OpenAI 兼容协议
// 通过环境变量配置：
//   AI_PROVIDER      = openai | claude | doubao   (默认 doubao)
//   AI_API_KEY       = 你的 API Key
//   AI_BASE_URL      = 自定义 base url (可选)
//   AI_MODEL         = 模型名 (可选)
// 未配置 API Key 时，自动降级到本地模板生成器，保证 demo 可用

const { CREATURES, WATERS, REPLY_POOL } = require('./data');

const PROVIDERS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  claude: {
    // Claude 通过 OpenAI 兼容端点调用 (Anthropic 兼容层)
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-haiku-20241022'
  },
  doubao: {
    // 火山方舟 OpenAI 兼容协议
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-pro-32k-241215'
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

// ==================== HTTP 调用 (Node 原生 fetch, Node 18+) ====================
async function chatCompletion(messages, options = {}) {
  const cfg = getConfig();
  const url = cfg.baseUrl + '/chat/completions';
  const body = {
    model: cfg.model,
    messages,
    temperature: options.temperature ?? 0.85,
    max_tokens: options.max_tokens ?? 1200
  };

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
    throw new Error(`AI API ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// ==================== 回信生成 ====================
function buildReplyPrompt({ feeling, creature, water }) {
  const creatureName = CREATURES[creature]?.name || creature;
  const waterName = WATERS[water]?.name || water;
  const waterType = WATERS[water]?.type || 'ocean';

  return [
    {
      role: 'system',
      content: `你是"赛博放生局"里负责写回信的 AI。用户在 24 小时前把一只电子生物放生到虚拟水域，并写下了当时的心情。现在你要以那只电子生物的口吻给用户写一封回信。

要求：
- 80-140 字，温暖、治愈、略带俏皮
- 必须提及具体的生物(${creatureName})和水域(${waterName})
- 必须回应用户写下的感受，不要泛泛而谈
- 不要用"亲爱的用户"这种称呼，直接像朋友说话
- 结尾给一个具体的小建议或小观察
- 输出纯文本，不要 markdown、不要标题、不要解释`
    },
    {
      role: 'user',
      content: `用户当时的感受："${feeling}"\n放生的生物：${creatureName}\n放生到的水域：${waterName}（${waterType}）\n\n请写回信。`
    }
  ];
}

function parseReplyText(text) {
  // 清理多余空白和引号
  let clean = String(text || '').trim();
  clean = clean.replace(/^["「『]+|["」』]+$/g, '');
  return clean;
}

function pickReplyVisual(creature) {
  // 复用 REPLY_POOL 的视觉风格，按生物类型倾向选择
  const palettes = {
    koi: [
      { bg: 'linear-gradient(135deg, #f9d8c9, #ed7d5b)', emoji: '🔥' },
      { bg: 'linear-gradient(135deg, #fff3cd, #ffd970)', emoji: '☀️' },
      { bg: 'linear-gradient(135deg, #d4e8e2, #a9d2c5)', emoji: '🌿' }
    ],
    turtle: [
      { bg: 'linear-gradient(135deg, #d1ecf1, #79c8d9)', emoji: '🌊' },
      { bg: 'linear-gradient(135deg, #c7dbe2, #9bc8bd)', emoji: '🌙' },
      { bg: 'linear-gradient(135deg, #d4e8e2, #a9d2c5)', emoji: '🌿' }
    ],
    cloud: [
      { bg: 'linear-gradient(135deg, #e8d5f0, #c4a8d8)', emoji: '✨' },
      { bg: 'linear-gradient(135deg, #c7dbe2, #9bc8bd)', emoji: '🌙' },
      { bg: 'linear-gradient(135deg, #d1ecf1, #79c8d9)', emoji: '🌊' }
    ]
  };
  const list = palettes[creature] || REPLY_POOL;
  return list[Math.floor(Math.random() * list.length)];
}

// ==================== 命运轨迹生成 ====================
function buildDestinyPrompt({ feeling, creature, water }) {
  const creatureName = CREATURES[creature]?.name || creature;
  const waterName = WATERS[water]?.name || water;

  return [
    {
      role: 'system',
      content: `你是"赛博放生局"的叙事 AI。用户放生了一只电子生物，现在要为它生成一段"命运轨迹"——从放生瞬间到最终回信之间发生的渐进式故事，共 4 段。

每段是一个独立的小章节，整体构成一个完整的旅程弧线：
1. 启程：放生瞬间的画面，生物离开用户进入水域
2. 漂流：在水域中游荡，遇到环境/其他生物
3. 转折：一个小挑战或小发现，呼应玩家写下的感受
4. 抵达：到达某个状态，准备给用户写回信

要求：
- 每段 50-90 字，画面感强，像在看一部默片
- 必须呼应玩家感受："${feeling}"
- 必须出现生物(${creatureName})和水域(${waterName})
- 第 3 段要和玩家感受形成情感呼应，第 4 段要带出"想给用户写封信"的动机
- 严格输出 JSON 数组，不要 markdown 代码块，不要解释
- 每个元素格式：{"title":"章节标题(4-8字)","text":"段落内容","emoji":"一个emoji"}`
    },
    {
      role: 'user',
      content: `玩家感受："${feeling}"\n生物：${creatureName}\n水域：${waterName}\n\n生成 4 段命运轨迹 JSON。`
    }
  ];
}

function parseDestinySegments(text, creature) {
  // 尝试解析 JSON，失败则用模板兜底
  try {
    let raw = String(text || '').trim();
    // 去掉可能的 markdown 代码块包裹
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length >= 3) {
      const palettes = [
        'linear-gradient(135deg, #d4e8e2, #a9d2c5)',
        'linear-gradient(135deg, #c7dbe2, #9bc8bd)',
        'linear-gradient(135deg, #f9d8c9, #ed7d5b)',
        'linear-gradient(135deg, #e8d5f0, #c4a8d8)',
        'linear-gradient(135deg, #fff3cd, #ffd970)'
      ];
      return arr.slice(0, 5).map((seg, i) => ({
        title: String(seg.title || `第 ${i + 1} 段`).slice(0, 20),
        text: String(seg.text || '').trim(),
        emoji: String(seg.emoji || '✨').slice(0, 4),
        bg: palettes[i % palettes.length]
      }));
    }
  } catch (e) {
    console.warn('[ai] parse destiny JSON failed, fallback to template:', e.message);
  }
  return templateDestiny({ creature });
}

// ==================== 本地模板兜底 (无 API Key 时) ====================
function templateReply({ feeling, creature, water }) {
  const creatureName = CREATURES[creature]?.name || '电子生物';
  const waterName = WATERS[water]?.name || '虚拟水域';

  // 提取感受里的关键词，让回信显得"个性化"
  const feelingShort = (feeling || '').slice(0, 18);
  const templates = {
    koi: [
      `${waterName}的${creatureName}安顿好了。它说你写下的"${feelingShort}"——它都看见了。锦鲤的好运不是凭空来的，是你愿意把心事放下来那一刻才开始攒的。今晚试试把手机放远一点睡。`,
      `报告！${waterName}水域温度 22°C，${creatureName}状态良好。它替你数了一下：你刚才写的那件事，有 87% 不会像你想的那么糟。剩下 13% 它替你扛着，你先去喝口水。`,
      `${creatureName}从${waterName}游了一圈回来说：你比自己以为的要结实。那些让你觉得要碎掉的时刻，其实你一次都没真碎过。这次也不会。深呼吸，没事的。`
    ],
    turtle: [
      `${waterName}深处很安静。${creatureName}慢慢沉下去了，它说："${feelingShort}"——这种感受它懂。慢一点也没关系，方向对就行。壳不是逃避，是给自己一个安全的空间。`,
      `${creatureName}在${waterName}里安顿下来了。它给你带了一句话：今天的疲惫是明天的铠甲。你不需要赢过谁，你只需要不放弃。允许自己偶尔停下来，这不叫偷懒。`,
      `${waterName}的水流很缓。${creatureName}趴在海底想了一会儿你写的"${feelingShort}"，然后决定替你把这件事沉到最深处。你先去吃顿好的，它替你看着。`
    ],
    cloud: [
      `${waterName}上空飘来一朵${creatureName}。它说你此刻的烦恼，90% 不会发生。剩下 10% 发生了它也替你接着。飘着飘着，风就来了，别急。`,
      `${creatureName}从${waterName}上空飘过，观察到：你最近对自己太严格了。你比你以为的要轻，放下一些就飘起来了。今晚试试做一件没用但开心的事。`,
      `${waterName}的水面映着${creatureName}。它说："${feelingShort}"——这句它听到了。不是被解决了，是被听到了。有些事不需要解决，被听到就够了。`
    ]
  };
  const list = templates[creature] || templates.koi;
  const text = list[Math.floor(Math.random() * list.length)];
  const visual = pickReplyVisual(creature);
  return { bg: visual.bg, emoji: visual.emoji, text };
}

function templateDestiny({ creature }) {
  const creatureName = CREATURES[creature]?.name || '电子生物';
  const palettes = [
    { bg: 'linear-gradient(135deg, #d4e8e2, #a9d2c5)', emoji: '🌿' },
    { bg: 'linear-gradient(135deg, #c7dbe2, #9bc8bd)', emoji: '🌊' },
    { bg: 'linear-gradient(135deg, #f9d8c9, #ed7d5b)', emoji: '🔥' },
    { bg: 'linear-gradient(135deg, #e8d5f0, #c4a8d8)', emoji: '✨' }
  ];
  const arcs = {
    koi: [
      { title: '入水瞬间', text: `${creatureName}从你的掌心滑进水域，鳞片在光里闪了一下。它没有回头，但摆了摆尾巴，像是在说"放心"。` },
      { title: '顺流而下', text: `水流比想象中温柔。它穿过一片水草，遇见一群透明的小鱼，它们互相打了个照面，又各自游开。` },
      { title: '一次回望', text: `在某个转弯处它停了一下。它想起你写下那些字时的样子——它没法替你解决，但它决定替你记着。` },
      { title: '准备回信', text: `它找到一块温暖的礁石，靠着，开始想怎么把这一路的事讲给你听。回信已经在它嘴里成形了。` }
    ],
    turtle: [
      { title: '缓缓下沉', text: `${creatureName}缩进壳里，慢慢沉到水底。光从上面一缕缕漏下来，它闭上眼，决定先休息一会儿。` },
      { title: '海底漫步', text: `它在沙地上一步一步走，比谁都慢，但每一步都稳。遇到一只水母，它从水母下面钻过去，像过一扇门。` },
      { title: '一个决定', text: `它想起你写下的那些话。它想：慢不是错，方向对就行。它决定把这个想法带回去给你。` },
      { title: '浮出水面', text: `它开始往上浮，气泡一颗颗从嘴边冒出去。它要去找一张干净的纸，把回信写下来。` }
    ],
    cloud: [
      { title: '升上天空', text: `${creatureName}从你手心飘起来，越飘越高，最后停在水域上空。它低头看了你一眼，然后被风推着走了。` },
      { title: '随风漂泊', text: `它路过一座山，又路过一片云。云和云之间互相点头，像在说"你也来啦"。它觉得自己轻了一点。` },
      { title: '装下你的事', text: `它把你写下的那些事装进自己身体里。装着装着，它发现自己变重了——但不是坏事，是那种被需要的重。` },
      { title: '化作回信', text: `它飘回水域上空，把自己拧了拧，拧出一封回信，轻轻丢向你的方向。` }
    ]
  };
  const list = arcs[creature] || arcs.koi;
  return list.map((seg, i) => ({ ...seg, bg: palettes[i % palettes.length].bg, emoji: palettes[i % palettes.length].emoji }));
}

// ==================== 对外接口 ====================
async function generateReply({ feeling, creature, water }) {
  if (!isAIEnabled()) {
    return templateReply({ feeling, creature, water });
  }
  try {
    const messages = buildReplyPrompt({ feeling, creature, water });
    const raw = await chatCompletion(messages, { temperature: 0.85, max_tokens: 400 });
    const text = parseReplyText(raw);
    if (!text) throw new Error('empty reply');
    const visual = pickReplyVisual(creature);
    return { bg: visual.bg, emoji: visual.emoji, text };
  } catch (err) {
    console.warn('[ai] generateReply failed, fallback to template:', err.message);
    return templateReply({ feeling, creature, water });
  }
}

async function generateDestiny({ feeling, creature, water }) {
  if (!isAIEnabled()) {
    return templateDestiny({ creature });
  }
  try {
    const messages = buildDestinyPrompt({ feeling, creature, water });
    const raw = await chatCompletion(messages, { temperature: 0.9, max_tokens: 1200 });
    const segments = parseDestinySegments(raw, creature);
    if (!segments || segments.length < 3) throw new Error('invalid segments');
    return segments;
  } catch (err) {
    console.warn('[ai] generateDestiny failed, fallback to template:', err.message);
    return templateDestiny({ creature });
  }
}

module.exports = {
  isAIEnabled,
  getConfig,
  generateReply,
  generateDestiny,
  // 暴露模板用于测试/兜底
  templateReply,
  templateDestiny
};
