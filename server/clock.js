// 赛博放生 · 可控时钟
//
// 生产环境使用真实系统时间；测试与真实路径验证可注入虚拟时钟
// （setNow），让调度、信号截止、安静时段全部跟着虚拟时间走，
// 不需要写任何测试专用的决策逻辑（handoff §5）。

let nowFn = () => Date.now();

function now() {
  return nowFn();
}

// 注入时钟源（传 () => number）。传 undefined/null 恢复系统时间。
function setNow(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

// 虚拟时钟工厂：手动步进，供真实路径验证加速生产调度使用
function virtualClock(startAt) {
  let t = startAt ?? Date.now();
  return {
    now: () => t,
    step: (ms) => { t += ms; return t; },
    set: (v) => { t = v; return t; }
  };
}

module.exports = { now, setNow, virtualClock };
