// 赛博放生 · AI 服务
// 支持 OpenAI / Claude / 豆包(火山方舟) 三种 API，统一走 OpenAI 兼容协议
// 通过环境变量配置：
//   AI_PROVIDER      = openai | claude | doubao   (默认 doubao)
//   AI_API_KEY       = 你的 API Key
//   AI_BASE_URL      = 自定义 base url (可选)
//   AI_MODEL         = 模型名 (可选)
// 未配置 API Key 时，自动降级到本地模板生成器，保证 demo 可用

const fs = require('fs');
const path = require('path');
const { CREATURES, WATERS, REPLY_POOL } = require('./data');

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
    // Claude 通过 OpenAI 兼容端点调用 (Anthropic 兼容层)
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-haiku-20241022'
  },
  doubao: {
    // 火山方舟 OpenAI 兼容协议
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

  // 调试日志：打印 provider/model/首条消息，便于确认调用是否真的发生
  console.log(`[ai] → POST ${url}  model=${cfg.model}  provider=${cfg.provider}`);
  console.log(`[ai] → system: ${String(messages[0]?.content || '').slice(0, 60)}...`);
  console.log(`[ai] → user:   ${String(messages[1]?.content || '').slice(0, 80)}...`);

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
    console.log(`[ai] ← ${resp.status}  ${Date.now() - t0}ms  body=${text.slice(0, 200)}`);
    throw new Error(`AI API ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  console.log(`[ai] ← 200  ${Date.now() - t0}ms  tokens=${data.usage?.total_tokens || '?'}  len=${content.length}`);
  if (!content) {
    console.log('[ai] ← empty content, full response:', JSON.stringify(data).slice(0, 800));
  } else {
    console.log(`[ai] ← content: ${content.slice(0, 100)}...`);
  }
  return content;
}

// ==================== 回信生成 ====================
function buildReplyPrompt({ feeling, creature, water, replyTimeLabel, destinySummary }) {
  const creatureName = CREATURES[creature]?.name || creature;
  const waterName = WATERS[water]?.name || water;
  const waterType = WATERS[water]?.type || '水域';
  const location = destinySummary?.location || `${waterName}附近`;
  const ending = destinySummary?.ending || '经历了一段离谱的旅程';
  const visual = destinySummary?.visual || '';

  return [
    {
      role: 'system',
      content: `你是"赛博放生"里负责写最终回信的 AI。

规则：
- 用户会先看到最终回信，然后因为回信太离谱/太有趣，才会去解锁查看中间的"命运轨迹"。
- 因此最终回信要写得短、奇、有钩子：让用户一眼就觉得"这怎么可能？中间发生了什么？"
- 以${creatureName}的口吻写，像给老朋友发消息，不要"亲爱的用户"。
- 以下关键事实是权威设定，**绝对不能改**：
  1. 真实地点：${location}
  2. 你现在的离奇遭遇：${ending}
  3. 配图画面：${visual || ending}
- 必须在回信里明确提到地点"${location}"，并按上述遭遇描述。
- 必须呼应用户感受："${feeling}"——而且要点出因果关系：正因为用户有这个情绪，你才落得这个下场。
- 80-140 字，荒诞搞笑、反差拉满、带黑色幽默，笑完还有点扎心。
- 不准写温暖治愈的安慰！不准说"别紧张/会好的/加油"！
- 不用"亲爱的用户/信号不太好/语音转文字/它都记着/先好好吃饭/别瞎想"。
- 输出纯文本，不要 markdown、不要标题、不要解释。`
    },
    {
      role: 'user',
      content: `用户感受："${feeling}"\n放生生物：${creatureName}\n放生水域：${waterName}（${waterType}）\n间隔时间：${replyTimeLabel || '一天后'}\n命运轨迹结局：${ending}\n配图画面：${visual}\n回信发生地点：${location}\n\n请写最终回信，80-140字，以${creatureName}口吻，必须提到地点'${location}'和遭遇'${ending}'，必须点出"${feeling}"和结局的因果关系，荒诞搞笑+情绪共鸣，输出纯文本，不要 markdown、不要标题、不要解释。`
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
function buildDestinyPrompt({ feeling, creature, water, replyTimeLabel }) {
  const creatureName = CREATURES[creature]?.name || creature;
  const waterName = WATERS[water]?.name || water;

  const timeMap = {
    '24h': '一天后',
    '3d': '三天后',
    '7d': '一周后',
    'custom': '到了约定时间'
  };
  const timePhrase = timeMap[replyTimeLabel] || (replyTimeLabel || '一天后');

  const voiceMap = {
    koi: '话痨、市井气、爱吹牛、说话带口头禅"我跟你说"，爱抢戏、嘴快、偶尔慌张',
    turtle: '老干部、慢吞吐字、句尾爱加"啊"或"吧"，说话像在念文件但内容全是离谱事',
    cloud: '爱叹气、语气像初中文艺女青年、句子里夹英文单词、动不动就"其实""某种意义上"'
  };
  const creatureVoice = voiceMap[creature] || '有点荒诞、像老朋友发消息';

  // 随机离谱元素池 —— 每次抽几个注入剧情，保证不重样
  const randomProps = [
    '充电宝', '广场舞音响', '外卖箱', '泡面桶', '自拍杆', '麻将牌',
    '保温杯', '蓝牙耳机', '电动滑板', '折叠椅', '烤串炉子', '奶茶杯',
    '彩票刮刮乐', '键盘', '鼠标垫', '仙人球', '鱼饲料', '潜水镜'
  ];
  const randomJobs = [
    '外卖员', '直播主播', '保安', '算命先生', '搓澡工', '代驾',
    '快递员', '广场舞领舞', '网吧网管', '火锅店服务员', '滴滴司机',
    '街头卖艺', '微商', '遛狗师', '剧本杀NPC', '奶茶店调茶师'
  ];
  const randomPlaces = [
    '网吧', '派出所', '海底捞后厨', '养老院', '太空站', '地铁站',
    '写字楼会议室', '健身房', 'KTV', '医院挂号处', '大学食堂',
    '彩票站', '24小时便利店', '洗车店', '宠物医院', '广场舞广场'
  ];
  const randomNPCs = [
    '广场舞大妈', '外卖小哥', '保安大叔', '算命瞎子', '搓澡师傅',
    '网吧老板', '火锅店服务员', '地铁安检员', '小学班主任',
    '退休老干部', '直播网红', '快递员', '遛狗大爷', '清洁工阿姨'
  ];

  function pickRandom(arr, n) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }
  const seedProps = pickRandom(randomProps, 1);
  const seedJob = pickRandom(randomJobs, 1)[0];
  const seedPlace = pickRandom(randomPlaces, 1)[0];
  const seedNPC = pickRandom(randomNPCs, 1)[0];

  return [
    {
      role: 'system',
      content: `你是"赛博放生"的竖屏短剧编剧。用户把一只${creatureName}放生到${waterName}，你要写一个 4 集的"情绪因果反转短剧"。

核心铁则（重中之重，必须严格执行）：
1. 第 4 集的结局，必须是用户的感受"${feeling}"直接导致的 —— 不是顺便接一下，是正因为有这个情绪，它才落得这个下场。
2. 用户第一眼看到的就是第 4 集，所以第 4 集必须同时满足：结局炸裂反转 + 情绪共鸣拉满 + 看完想说"卧槽这不就是我吗"。
3. 前三集是铺垫，是"为什么会这样"的答案，用户要看广告解锁，所以前三集要层层递进，越来越离谱。

【反差维度组合引擎】（从以下维度中随机选 2-3 个组合，每次组合都不一样，绝对不要重复套路）
维度A·身份：小鱼→大怪物 / 普通→稀有 / 野生→家养 / 弱小→霸主（或反过来）
维度B·命运：自由→囚禁 / 活着→上桌 / 放生→被卖 / 野生→打工（或反过来）
维度C·场景：水里→餐桌 / 湖里→网吧 / 海底→会议室 / 天空→地铁站（正常场景→离谱场景）
维度D·时间：一天→一千年 / 刚放→秒没 / 现在→穿越到古代（时间尺度错乱）
维度E·因果：本来要帮你→反而坑你 / 本来要报恩→结果赖上你 / 本来要安慰→反而扎心（因果反转）
维度F·职业：自由生物→干人类的活（外卖/主播/保安/算命/搓澡/代驾/快递 等等）
维度G·关系：陌生人→债主 / 路人→师父 / 朋友→老板（关系反转）
维度H·状态：正常→变异 / 清醒→疯掉 / 健康→社畜（状态反转）

组合要求：每次至少选 2 个维度组合，比如"身份+场景""命运+职业""时间+因果"，组合越奇怪越好。
反套路检查：绝对不能是"被吃了/变大了/变老了"这种单一老套路，必须是组合拳。

结局必须是黑色幽默：很惨但很好笑，很离谱但又好像有道理，用户笑完还有点扎心。

【情绪因果渗透法】（用户感受"${feeling}"必须贯穿全剧，第4集是终极结果）
第1集：情绪"伏笔" —— 生物刚入水就隐约感觉到不对劲，有某种奇怪的能量传过来（暗示情绪来了）
第2集：情绪"发酵" —— 情绪开始影响它的行为和判断，它开始做出奇怪的选择，跟NPC的互动也受情绪影响
第3集：情绪"爆发" —— 情绪彻底涌过来，直接推动剧情走向高潮，把它推向最终结局的边缘
第4集：情绪"结果" —— 它现在的下场，就是因为这个情绪一步步导致的。第4集必须明确点出因果关系。

【随机离谱种子】（必须把以下元素自然融入剧情，第4集最好能用上）
- 随机道具：${seedProps.join('、')}
- 随机职业：${seedJob}
- 随机场景：${seedPlace}
- 随机NPC：${seedNPC}

要求：这些元素不能是硬塞的，要跟情绪因果线结合起来，比如"因为焦虑，它迷上了跳广场舞，然后遇到了广场舞大妈，然后……"

【短剧规则】
- 短剧 = 抖音/快手付费短剧。靠"对话打架 + 镜头切换 + 情绪爆点"推进。
- 拒绝文艺散文！拒绝意象堆砌！拒绝诗化长句！
- 一段话 = 一个镜头，镜头之间靠"切"分。
- 主角必须说话，NPC 必须接话。
- 第 4 集结局必须炸，必须反转，必须有情绪共鸣。

【正例 1·命运+职业组合 · 焦虑→外卖员结局】

玩家感受："最近好焦虑，每天都赶deadline" / 生物：锦鲤 / 水域：西湖 / 间隔：三天后
（随机种子：外卖箱 + 外卖员 + 地铁站 + 外卖小哥）

第1集【刚入水就觉得赶】
【切镜头·西湖断桥下】我刚摆摆尾巴适应水温，就觉得心里慌慌的，总觉得有啥事儿没干完。旁边一条鲫鱼凑过来："新来的？游这么快干啥？赶时间啊？""我也不知道……"我喘着气，"就是感觉再不游快点就要迟到了。"鲫鱼摇摇头："又是个被焦虑传染的。"【字幕：放生第一天就赶deadline】

第2集【遇上了外卖小哥】
【切镜头·湖滨公园岸边】我正沿着岸边急游，突然一个外卖小哥蹲在水边哭："完了完了，这单超时要扣钱了……"我探出头："啥单？我帮你送啊！"他吓了一跳："鱼会说话？""别问了，地址哪？"他指了指地铁口："龙翔桥站，一份奶茶……你确定你能送？"我叼起外卖箱："放心，我游得比地铁快。"【特写·外卖箱上印着"超时必赔"】

第3集【焦虑让我越游越快】
【切镜头·西湖底·深夜】你那边的焦虑顺着信号一股脑涌过来，我整个人都麻了——但不是难受，是兴奋！"对！就是这个感觉！"我眼睛发亮，尾巴甩得快出残影。旁边的老鲤鱼吓坏了："孩子你冷静点！你已经三天没睡觉了！"我头也不回："不行，还有三单没送！送完这单还有下一单！"【切镜头·我背着外卖箱冲进了地铁站】

第4集【在地铁站给你发微信】
【切镜头·杭州地铁龙翔桥站·闸机口】嘿，是我。告诉你个离谱的事——你那焦虑我全接住了，结果我成了西湖最快的外卖员，三天送了两百多单，现在在地铁站里抄近道。外卖小哥说要给我评"月度最佳骑手"，但我觉得我还能更快。对了，你能不能别焦虑了？我鱼尾都快甩断了。【字幕：你的焦虑，我的KPI】

---

【正例 2·身份+因果组合 · 想躺平→锦鲤成锦鲤王结局】

玩家感受："不想上班，想躺平当废物" / 生物：乌龟 / 水域：西湖 / 间隔：一周后
（随机种子：折叠椅 + 广场舞领舞 + 广场舞广场 + 广场舞大妈）

第1集【刚入水就不想动】
【切镜头·西湖底·石板上】我缩进壳里，决定这辈子都不出来了。旁边一只田螺爬过来："新来的？咋不动啊？""不想动。"我闷声闷气，"动了又能咋样呢？最后还不是要上班。"田螺叹了口气："又是个想躺平的……你知道这湖里有多少只躺平的乌龟吗？五百多只。"【字幕：放生第一天就躺平了】

第2集【广场舞大妈看上了我】
【切镜头·西湖边·广场舞广场】我正趴在岸边晒太阳躺平，一个广场舞大妈走过来："哎哟这乌龟好，趴着一动不动，稳！"我睁开眼："阿姨您过奖……""别说话！"她把我放到折叠椅上，"从今天起，你就是我们广场舞队的吉祥物了，领舞的时候放前面，镇场子！"我刚想拒绝，她塞给我一个保温杯："包吃包住，每天枸杞水管够。"我想了想："……行吧。"【字幕：躺平躺成了吉祥物】

第3集【躺平能量让我越来越稳】
【切镜头·广场舞广场·傍晚】你那边的躺平意念顺着信号传过来，我整个人都入定了——不是睡着，是一种"天塌下来也不关我事"的稳。广场舞大妈们都惊了："这乌龟也太稳了吧！放音乐都不动！""我跟你说，这是得道了！"我心里美滋滋的：躺平真好，躺着躺着就成大师了。【切镜头·我被放在C位，一群大妈围着我跳】

第4集【在广场舞广场给你发微信】
【切镜头·西湖文化广场·广场舞C位】嘿，是我。告诉你个好消息——你那躺平意念我全接住了，结果我成了广场舞队的"稳神"，每天被放在C位镇场，大妈们还给我起了个外号叫"龟仙人"。现在每天枸杞水喝着，太阳晒着，啥也不用干。对了，你那边继续躺啊，我还想再升个级，争取当街道办的吉祥物。【字幕：你躺平，我升职】

---

【正例 3·场景+时间组合 · 缺钱→古代当铺结局】

玩家感受："总是缺钱花，想一夜暴富" / 生物：锦鲤 / 水域：西湖 / 间隔：一天后
（随机种子：彩票刮刮乐 + 算命先生 + 古代当铺 + 算命瞎子）

第1集【刚入水就想搞钱】
【切镜头·西湖里·钱币旁】我游着游着，看到水底有个硬币，两眼放光。旁边一条白条鱼游过来："至于吗？一个一毛的。""一毛也是钱啊！"我赶紧把硬币叼到石头缝藏好，"攒多了就能娶媳妇了。"白条摇摇头："又是个财迷……你知道这湖里的钱都去哪了吗？""去哪了？""南宋那会有个当铺，据说——"他突然不说了。【字幕：放生第一天就开始攒钱】

第2集【遇上了算命瞎子】
【切镜头·湖底·一个神秘石洞前】我正数钱呢，一个戴墨镜的老乌龟爬出来："年轻人，我看你骨骼清奇，是个搞金融的料。""你谁啊？""我是这一片的算命先生。"他推了推墨镜，"我看你印堂发财，要不要跟我干一票大的？穿过这个洞，就是南宋的当铺——""等等，"我打断他，"南宋？这洞能穿越？"他嘿嘿一笑："不然你以为湖里的钱都去哪了？"【特写·洞口飘着一张南宋的交子】

第3集【暴富执念把我推了进去】
【切镜头·石洞深处·深夜】你那边的暴富执念顺着信号传过来，我整个人都燃了！"干了！不就是穿越吗！"我一头往洞里扎。算命瞎子在后面喊："年轻人别急啊！我还没说怎么回来呢——"但我已经听不到了，满脑子都是"一夜暴富一夜暴富一夜暴富"。【切镜头·我从一道金光里掉出去，落在了一个古代柜台前】

第4集【在南宋当铺给你发微信】
【切镜头·南宋·临安城·某当铺柜台里】嘿，是我。告诉你个劲爆消息——你那暴富执念太猛了，直接把我推穿越了！现在我在南宋的当铺里，当朝奉（就是当铺掌柜的助手）。对了，我把你那"一夜暴富"的念头卖给了当铺老板，换了十两银子。……你问我咋回去？害，回去干啥，这边工资比你那边高多了。【字幕：你想暴富，我先富了】

---

【4 集结构铁律】
- 第1集：开场就有冲突+情绪伏笔，对话密集（至少 3 句），镜头指示 + 字幕，结尾留钩子（暗示事情不对劲）
- 第2集：撞上随机NPC + 随机道具/职业登场，情绪开始发酵，全是对话推进，抛出更多离谱信息
- 第3集：用户情绪"${feeling}"彻底爆发（顺着信号/5G/Wi-Fi/意念传过来），直接推动剧情走向高潮，把它推向结局边缘
- 第4集：${timePhrase}视角发微信，在随机场景${seedPlace}里，结局是情绪导致的必然结果 + 多维反差反转，结尾再抛一个问题或梗当钩子

【${creatureName}人设】（硬性）
- ${creatureVoice}
- 4 集保持人设，第 4 集以${creatureName}口吻给用户发微信
- 不管结局多惨多离谱，语气都要轻松、搞笑、像老朋友唠嗑
- 第4集里可以吐槽用户的情绪，但要用开玩笑的方式，不能说教

【时间锚点】（硬性）
- 第 4 集是${timePhrase}后发出的，必须体现"已经过去${timePhrase}"
- 禁止"现在快去睡/别紧张/会好的/加油"这类即时安慰
- 结局可以是坏的，但要用搞笑的方式说出来

【禁止事项】（硬性）
- 不准编造用户具体信息：不准出现具体科目、人名、公司名、书名、考试内容
- 不准直接解释或说教用户的感受，要把感受变成剧情的"因"，结局是"果"
- 不用"亲爱的用户/信号不太好/语音转文字/它都记着/先好好吃饭/别瞎想"
- 不准写温暖治愈的正常结局！必须反转！必须离谱！必须有情绪共鸣！
- 不准只用单一反差维度！必须至少 2 个维度组合！

【字数】
- 前 3 集每集 80-120 字（含对话 + 镜头指示）
- 第 4 集 80-120 字

【配图描述】(visualForImage)——根据第 4 集决定绘画风格：
- 风格自由：水彩/像素/霓虹/剪纸/水墨/赛博朋克/儿童绘本/油画/线描/卡通漫画均可
- 主体必须是${creatureName}，占画面中心或前景
- 场景在第 4 集的那个真实地点（必须和结局一致）
- 画面要体现出反差感、喜剧效果、情绪共鸣
- ${creatureName}基础视觉：
  * 锦鲤：橙红鳞片、灵动游姿、尾鳍飘逸
  * 乌龟：青绿龟壳、沉稳姿态、眼睛圆润
  * 云朵：白色蓬松、边缘柔和、随风飘动

【输出格式】（严格 JSON，不要 markdown 包裹，不要解释）
{
  "location": "真实地点名，具体到建筑/店铺/景点（第4集的地点）",
  "visualForImage": {
    "style": "绘画风格",
    "subject": "生物主体描述，${creatureName}占画面中心/前景",
    "action": "生物的动作或状态",
    "place": "具体地点和环境",
    "bgElements": "背景标志性元素和关键道具，1-3个",
    "mood": "画面氛围（要搞笑/荒诞/反差/扎心）"
  },
  "segments": [
    {"title":"第1集标题(短剧味，4-10字)","text":"第1集内容(80-120字，对话为主+情绪伏笔)","emoji":"一个emoji"},
    {"title":"第2集标题(短剧味，4-10字)","text":"第2集内容(80-120字，对话为主+情绪发酵+随机元素登场)","emoji":"一个emoji"},
    {"title":"第3集标题(短剧味，4-10字)","text":"第3集内容(80-120字，情绪爆发+推向结局)","emoji":"一个emoji"},
    {"title":"第4集标题(短剧味，4-10字)","text":"第4集即最终回信，80-120字，${creatureName}发微信，情绪因果+多维反转结局","emoji":"一个emoji"}
  ]
}`
    },
    {
      role: 'user',
      content: `玩家感受："${feeling}"\n生物：${creatureName}\n水域：${waterName}\n间隔时间：${replyTimeLabel || '一天后'}\n\n请按上面"情绪因果反转短剧"的规则生成命运轨迹 JSON，包含 location/visualForImage/segments。\n\n要求：\n1. 第4集结局必须是"${feeling}"直接导致的结果\n2. 反差维度至少组合2个以上，不能是单一老套路\n3. 必须自然融入随机元素（道具/职业/场景/NPC）\n4. 第4集既要炸反转，又要让用户有情绪共鸣`
    }
  ];
}

function parseDestinySegments(text, creature, water, feeling) {
  // 尝试解析 JSON，失败则用模板兜底
  try {
    let raw = String(text || '').trim();
    // 去掉可能的 markdown 代码块包裹
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(raw);
    const arr = parsed.segments || parsed;
    if (Array.isArray(arr) && arr.length >= 3) {
      const palettes = [
        'linear-gradient(135deg, #d4e8e2, #a9d2c5)',
        'linear-gradient(135deg, #c7dbe2, #9bc8bd)',
        'linear-gradient(135deg, #f9d8c9, #ed7d5b)',
        'linear-gradient(135deg, #e8d5f0, #c4a8d8)',
        'linear-gradient(135deg, #fff3cd, #ffd970)'
      ];
      const segments = arr.slice(0, 5).map((seg, i) => ({
        title: String(seg.title || `第 ${i + 1} 段`).slice(0, 20),
        text: String(seg.text || '').trim(),
        emoji: String(seg.emoji || '✨').trim(),
        bg: palettes[i % palettes.length]
      }));
      const vfi = parsed.visualForImage || {};
      const location = String(parsed.location || '').slice(0, 80) || null;
      // 第 4 段直接作为最终回信
      const lastSegText = segments[3]?.text || '';
      return {
        segments,
        location,
        visual: String(parsed.visual || '').slice(0, 200) || null,
        visualForImage: {
          style: String(vfi.style || parsed.style || '').slice(0, 60) || null,
          subject: String(vfi.subject || parsed.subject || '').slice(0, 200) || null,
          action: String(vfi.action || parsed.action || '').slice(0, 200) || null,
          place: String(vfi.place || parsed.place || '').slice(0, 200) || null,
          bgElements: String(vfi.bgElements || parsed.bgElements || '').slice(0, 200) || null,
          mood: String(vfi.mood || parsed.mood || '').slice(0, 100) || null
        },
        reply: lastSegText.slice(0, 300),
        ending: lastSegText.slice(0, 500)
      };
    }
  } catch (e) {
    console.warn('[ai] parse destiny JSON failed, fallback to template:', e.message);
  }
  return templateDestiny({ creature, water, feeling });
}

// ==================== 本地模板兜底 (无 API Key 时) ====================
function templateReplyText(feeling, creature, water, destinySummary) {
  const creatureName = CREATURES[creature]?.name || '生物';
  const waterName = WATERS[water]?.name || '虚拟水域';
  const location = destinySummary?.location || `${waterName}`;
  const ending = destinySummary?.ending || '经历了一段离谱的旅程';
  const feelingShort = (feeling || '').slice(0, 18);
  return `嘿，是我。你那"${feelingShort}"我全接住了，但副作用有点大——我现在在${location}，${ending}。你说这算不算因你而起？反正我是不回去了，你那边继续啊，我还想看看还能离谱到啥程度。`;
}

function templateReply({ feeling, creature, water, destinySummary }) {
  const style = pickReplyVisual(creature);
  return {
    bg: style.bg,
    emoji: style.emoji,
    text: templateReplyText(feeling, creature, water, destinySummary)
  };
}

function templateDestiny({ creature, water, feeling }) {
  const creatureName = CREATURES[creature]?.name || '生物';
  const waterName = WATERS[water]?.name || '虚拟水域';
  const feelingShort = (feeling || '').slice(0, 20) || '某种情绪';
  const palettes = [
    { bg: 'linear-gradient(135deg, #d4e8e2, #a9d2c5)', emoji: '🌿' },
    { bg: 'linear-gradient(135deg, #c7dbe2, #9bc8bd)', emoji: '🌊' },
    { bg: 'linear-gradient(135deg, #f9d8c9, #ed7d5b)', emoji: '🔥' },
    { bg: 'linear-gradient(135deg, #e8d5f0, #c4a8d8)', emoji: '✨' }
  ];
  const arcs = {
    koi: [
      { title: '入水就慌了', text: `【切镜头·${waterName}边】我刚摆摆尾巴，就觉得心里慌慌的——你那"${feelingShort}"顺着水面传过来了。旁边一条鲫鱼凑过来："新来的？游这么快干啥？""我也不知道，就是觉得再不游快点就晚了。"鲫鱼摇摇头："又是个被情绪传染的。"【字幕：放生第一天就被情绪带节奏】` },
      { title: '遇上了保安', text: `【切镜头·${waterName}岸边】我正沿着岸边急游，一个保安大叔拿喇叭喊："那条鱼！别往排水口游！""我控制不住啊！"我急得转圈。"你是不是被放生的？被放生的都这样，情绪太冲。"他掏出对讲机，"队长，又来一条躁动的。"【特写·喇叭上印着"文明放生"】` },
      { title: '情绪彻底爆了', text: `【切镜头·${waterName}底·深夜】你那边的情绪一股脑涌过来，我整个鱼都疯了，尾巴甩得快出残影。保安大叔拿手电筒照我："冷静点！你已经绕湖游了八十圈了！"我头也不回："不行！我感觉还有事没干完！"【切镜头·我一头撞进了排水管道】` },
      { title: '在下水道给你发微信', text: `【切镜头·城市下水道·某井盖下】嘿，是我。你那"${feelingShort}"太猛了，直接把我冲进了城市下水道。现在我在某条主管道里，旁边是一只也被人冲下来的橡皮鸭。对了，它说它也是被放生的，主人当时"想释怀"。你说咱俩谁更惨？【字幕：你的情绪，我的水流】` }
    ],
    turtle: [
      { title: '入水就不想动', text: `【切镜头·${waterName}底】我缩进壳里，决定不动了。你那"${feelingShort}"传过来，我直接摆烂。旁边一只田螺爬过来："新来的？咋不动？""不想动。"我闷声闷气，"动了又能咋样？"田螺叹气："又是个被情绪压趴的。"【字幕：放生第一天就躺平了】` },
      { title: '被大妈捡走了', text: `【切镜头·${waterName}边·广场】我正趴着不动，一个广场舞大妈把我捡起来："哎哟这乌龟好！稳！"我刚想说话，她把我放到音响上："以后你就是我们队的镇场神兽了！"我："阿姨我能不去吗？"她塞给我一颗枸杞："包吃包住。"我想了想："……行吧。"【字幕：躺平躺成了吉祥物】` },
      { title: '情绪让我更稳了', text: `【切镜头·广场·傍晚】你那边的情绪继续涌过来，我整个人入定了——不是睡着，是"天塌不关我事"的稳。大妈们惊了："这乌龟也太稳了！放音乐都不动！得道了！"我心里美滋滋：这情绪真好，躺着躺着就成大师了。【切镜头·我被放在C位，一群大妈围着我跳】` },
      { title: '在广场给你发微信', text: `【切镜头·${waterName}边广场·C位】嘿，是我。你那"${feelingShort}"我全接住了，结果我成了广场舞队的"稳神"，每天被放C位镇场，大妈叫我"龟仙人"。现在枸杞水喝着，太阳晒着，啥也不用干。你那边继续啊，我还想升个级，争取当街道办吉祥物。【字幕：你躺平，我升职】` }
    ],
    cloud: [
      { title: '升天就叹气', text: `【切镜头·${waterName}上空】我从你手心飘起来，刚到半空就叹了口气——你那"${feelingShort}"顺着上升气流跟上来了。旁边一朵老云瞥我一眼："新来的？咋一上来就叹气？""我也不知道，"我飘着，"就是觉得有点累。"老云点点头："某种意义上，你们人类放生的都不是生物，是情绪。"【字幕：放生第一天就被情绪带飞】` },
      { title: '遇上了无人机', text: `【切镜头·${waterName}上空·500米】我正飘着，一架无人机飞过来，螺旋桨把我吹得东倒西歪。"让让！让让！"操作员在下面喊。"我也想让啊！"我喊回去。无人机摄像头对准我："哎？这朵云会说话？""会说话咋了？你挡我路了！"【特写·无人机屏幕上显示"未知飞行物：会叹气的云"】` },
      { title: '情绪让我变重了', text: `【切镜头·高空·深夜】你那边的情绪持续涌过来，我发现自己越来越重——不是坏事儿，是那种"被塞满了"的重。"我飘不动了……"我往下坠。老云喊："把情绪卸掉啊！""不会啊！"我急了。老云："你就往地上吐！"【切镜头·我打了个大喷嚏，下了一场局部暴雨】` },
      { title: '在气象台给你发微信', text: `【切镜头·某气象台·雷达屏幕上】嘿，是我。你那"${feelingShort}"太重了，把我直接压到了气象站的雷达屏幕上，现在我是天气预报里的一个异常降水点。气象员说从没见过"有情绪的云"。对了，你那边下了雨没？那是我替你哭的，不用谢。【字幕：你的情绪，我的降水】` }
    ]
  };
  const list = arcs[creature] || arcs.koi;
  const segments = list.map((seg, i) => ({ ...seg, bg: palettes[i % palettes.length].bg, emoji: palettes[i % palettes.length].emoji }));
  const lastText = segments[3]?.text || '';
  return {
    location: `${waterName}附近`,
    visual: `${creatureName}在${waterName}，荒诞搞笑扁平插画`,
    visualForImage: {
      style: '荒诞搞笑扁平漫画风',
      subject: `${creatureName}位于画面中心，表情夸张，形象醒目`,
      action: '处于离谱的处境中（下水道/广场C位/雷达屏幕上）',
      place: `${waterName}附近的离谱场景`,
      bgElements: '标志性道具（喇叭/音响/无人机/雷达屏幕）',
      mood: '荒诞搞笑、反差拉满'
    },
    reply: lastText,
    ending: lastText,
    segments
  };
}

// ==================== 图片下载保存 ====================
async function downloadImage(remoteUrl) {
  if (!remoteUrl) return null;
  const t0 = Date.now();
  const resp = await fetch(remoteUrl);
  if (!resp.ok) {
    throw new Error(`download image ${resp.status}: ${resp.statusText}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  const ext = '.jpg';
  const filename = `reply-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
  const filepath = path.join(IMAGE_DIR, filename);
  fs.writeFileSync(filepath, buffer);
  console.log(`[ai] image downloaded: ${filename} (${buffer.length} bytes, ${Date.now() - t0}ms)`);
  return `/images/${filename}`;
}

// 将 base64 图片数据保存到本地
function saveBase64Image(b64Data) {
  try {
    const buffer = Buffer.from(b64Data, 'base64');
    const filename = `reply-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
    const filepath = path.join(IMAGE_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    console.log(`[ai] image saved from b64: ${filename} (${buffer.length} bytes)`);
    return `/images/${filename}`;
  } catch (err) {
    console.warn('[ai] saveBase64Image failed:', err.message);
    return null;
  }
}

// 根据回信文本生成配图画面描述，确保图文一致
async function generateImagePromptFromReply({ feeling, creature, water, replyText, destinySummary }) {
  const creatureName = CREATURES[creature]?.name || '生物';
  const waterName = WATERS[water]?.name || '虚拟水域';
  const location = destinySummary?.location || `${waterName}`;
  const ending = destinySummary?.ending || '';

  const messages = [
    {
      role: 'system',
      content: `你是专业的文生图提示词工程师。请根据用户提供的最终回信内容，提炼出一个40-80字的中文画面描述，用于AI绘图。

绝对规则：
1. 只能使用回信内容中已经明确出现的地点、生物状态、道具和环境。
2. 禁止添加回信里没有的新地点、新道具、新场景或新状态。
3. 画面描述必须让别人一眼就能看出：这就是回信里描述的那个场景。
4. 画面要有喜剧张力和反差感：角色表情要夸张生动，场景荒谬但画面认真写实，像新闻摄影但内容离谱，要有强烈的反差对比。
5. 画面要有故事感，让人一眼就想知道发生了什么。
6. 只输出画面描述文本，不要解释、不要JSON、不要标题。

示例：
回信内容："我现在正躺在西湖楼外楼的白瓷餐盘里，裹着糖醋芡汁，窗外是飘着蒙蒙烟雨的西湖。"
画面描述："西湖楼外楼餐桌白瓷盘上，一条锦鲤裹着亮晶晶糖醋芡汁静卧其中，表情无奈又认命，窗外烟雨朦胧的西湖柳色，画面写实但内容荒诞"`
    },
    {
      role: 'user',
      content: `生物：${creatureName}\n地点：${location}\n离奇遭遇：${ending}\n用户感受：${feeling}\n\n回信内容：\n${replyText}\n\n请严格基于回信内容提炼配图画面描述，要有喜剧张力和反差感：`
    }
  ];

  try {
    const raw = await chatCompletion(messages, { temperature: 0.3, max_tokens: 150 });
    return parseReplyText(raw);
  } catch (err) {
    console.warn('[ai] generateImagePromptFromReply failed:', err.message);
    return '';
  }
}

// ==================== 图片请求（带重试和真正 600s 超时） ====================
async function fetchImageWithRetry(url, options, retries = 2) {
  const fetch = require('node-fetch');
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const t0 = Date.now();
      const resp = await fetch(url, { ...options, timeout: 600 * 1000 });
      console.log(`[ai] image fetch attempt ${i + 1} ok in ${Date.now() - t0}ms`);
      return resp;
    } catch (err) {
      lastErr = err;
      console.warn(`[ai] image fetch attempt ${i + 1} failed: ${err.message}`);
      if (i < retries) {
        const delay = (i + 1) * 3000;
        console.log(`[ai] retrying image fetch in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ==================== 回信背景图生成 ====================
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

  // 把抽象 mood 翻译成图片模型能理解的视觉指令
  const moodRaw = (vfi.mood || '').toLowerCase();
  const tensionParts = [];
  if (moodRaw.includes('荒诞') || moodRaw.includes('搞笑') || moodRaw.includes('反差') || moodRaw.includes('扎心') || moodRaw.includes('喜剧')) {
    tensionParts.push('角色表情夸张生动');
    tensionParts.push('场景荒谬但画面认真写实，像新闻摄影但内容离谱');
    tensionParts.push('强烈的反差对比（大小/身份/处境的反差）');
    tensionParts.push('画面要有故事感，让人一眼就想知道发生了什么');
  } else {
    tensionParts.push('画面有故事感，让人想了解发生了什么');
  }

  // 注入结局上下文，让图片模型理解"为什么这个场景好笑"
  const storyContext = ending ? `\n故事背景（用于理解画面情绪，不要直接画成文字）：${ending.slice(0, 200)}` : '';

  const tension = tensionParts.join('，');
  return base ? `${base}。${tension}。${storyContext}构图主体突出，无文字，无UI，适合作为手机卡片背景。` : '';
}

function isVisualForImageComplete(vfi) {
  if (!vfi) return false;
  return !!(vfi.style && vfi.subject && vfi.place);
}

async function generateReplyImage({ feeling, creature, water, destinySummary, replyText, replyVisual }) {
  const apiKey = process.env.IMAGE_API_KEY;
  const baseURL = process.env.IMAGE_BASE_URL;
  const model = process.env.IMAGE_MODEL;
  if (!apiKey || !baseURL || !model) return null;

  const creatureName = CREATURES[creature]?.name || '生物';
  const waterName = WATERS[water]?.name || '虚拟水域';
  const location = destinySummary?.location || `${waterName}`;
  const ending = destinySummary?.ending || '';

  // 优先使用 LLM 生成的结构化 visualForImage
  let prompt = '';
  const vfi = destinySummary?.visualForImage;
  if (isVisualForImageComplete(vfi)) {
    prompt = buildImagePromptFromVisualForImage(vfi, creatureName, ending);
  }

  // 兜底：旧 visual 字段或从 reply 提炼
  if (!prompt) {
    let visual = replyVisual || destinySummary?.visual;
    if (!visual && replyText) {
      visual = await generateImagePromptFromReply({ feeling, creature, water, replyText, destinySummary });
    }
    visual = visual || `${creatureName}在${location}`;
    prompt = `${visual}，角色表情夸张生动，场景荒谬但画面认真写实，强烈的反差对比，画面有故事感让人一眼就想知道发生了什么，构图主体突出，无文字，无UI，适合作为手机卡片背景。`;
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
    console.log(`[ai] → POST ${baseURL}/images/generations  model=${model}`);

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
    console.log(`[ai] ← image 200  ${Date.now() - t0}ms  keys=${Object.keys(data).join(',')}`);

    const item = data.data?.[0];
    if (item?.b64_json) {
      const localUrl = saveBase64Image(item.b64_json);
      return localUrl;
    }

    const remoteUrl = item?.url;
    if (remoteUrl) {
      console.log(`[ai] image generated: ${remoteUrl.slice(0, 80)}...`);
      const localUrl = await downloadImage(remoteUrl);
      return localUrl;
    }

    console.warn('[ai] no image url or b64_json in response:', JSON.stringify(data).slice(0, 300));
    return null;
  } catch (err) {
    console.warn('[ai] generateReplyImage failed:', err.message);
    return null;
  }
}

// ==================== 命运轨迹摘要 ====================
function summarizeDestiny(destiny) {
  if (!destiny) return null;
  const segments = destiny.segments || destiny;
  const lastSeg = Array.isArray(segments) ? segments[segments.length - 1] : null;
  // 第 4 段文本即最终回信
  const replyFromSegments = lastSeg ? lastSeg.text : null;
  return {
    location: destiny.location || null,
    visual: destiny.visual || null,
    visualForImage: destiny.visualForImage || null,
    ending: destiny.ending || replyFromSegments,
    reply: destiny.reply || replyFromSegments || null
  };
}

// ==================== 对外接口 ====================
async function generateReply({ feeling, creature, water, replyTimeLabel, destinySummary }) {
  if (!isAIEnabled()) {
    return templateReply({ feeling, creature, water, destinySummary });
  }
  try {
    const messages = buildReplyPrompt({ feeling, creature, water, replyTimeLabel, destinySummary });
    const raw = await chatCompletion(messages, { temperature: 0.9, max_tokens: 400 });
    const text = parseReplyText(raw);
    if (!text) throw new Error('empty reply');
    const style = pickReplyVisual(creature);
    return { bg: style.bg, emoji: style.emoji, text };
  } catch (err) {
    console.warn('[ai] generateReply failed, fallback to template:', err.message);
    return templateReply({ feeling, creature, water, destinySummary });
  }
}

async function generateDestiny({ feeling, creature, water, replyTimeLabel }) {
  if (!isAIEnabled()) {
    return templateDestiny({ creature, water, feeling });
  }
  try {
    const messages = buildDestinyPrompt({ feeling, creature, water, replyTimeLabel });
    const raw = await chatCompletion(messages, { temperature: 0.85, max_tokens: 4000 });
    const result = parseDestinySegments(raw, creature, water, feeling);
    if (!result || !result.segments || result.segments.length < 3) throw new Error('invalid destiny');
    return result;
  } catch (err) {
    console.warn('[ai] generateDestiny failed, fallback to template:', err.message);
    console.warn(err.stack);
    return templateDestiny({ creature, water, feeling });
  }
}

module.exports = {
  isAIEnabled,
  getConfig,
  generateReply,
  generateReplyImage,
  generateDestiny,
  summarizeDestiny,
  pickReplyVisual,
  templateReplyText,
  // 暴露模板用于测试/兜底
  templateReply,
  templateDestiny
};
