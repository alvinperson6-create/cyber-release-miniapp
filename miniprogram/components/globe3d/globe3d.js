// 3D 地球组件（小程序端）
// 用 canvas 2D 做旋转点阵球（零依赖、低端机友好），WebGL 不可用时由页面回落到 SVG 地图
const { WATERS_GEO, GLOBE_ANIM } = require('../../utils/globe-config.js');

const TYPE_COLOR = {
  ocean: '#2c8a7a',
  lake: '#2c8a7a',
  river: '#2c8a7a',
  trench: '#ed7d5b'
};

// 经纬度 -> 单位球三维坐标
function latLngToXYZ(lat, lng) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lng + 180) * Math.PI / 180;
  return {
    x: -Math.sin(phi) * Math.cos(theta),
    y: Math.cos(phi),
    z: Math.sin(phi) * Math.sin(theta)
  };
}

// 球面点阵（纬度带采样）
function buildDots() {
  const dots = [];
  for (let lat = -75; lat <= 75; lat += 15) {
    const r = Math.cos(lat * Math.PI / 180);
    const count = Math.max(6, Math.round(24 * r));
    for (let i = 0; i < count; i++) {
      const lng = -180 + (360 / count) * i;
      dots.push(latLngToXYZ(lat, lng));
    }
  }
  return dots;
}

Component({
  properties: {
    selectedWater: { type: String, value: '' },
    disabled: { type: Boolean, value: false }
  },

  data: {
    ready: false
  },

  lifetimes: {
    attached() {
      this.rotY = 0.6;
      this.rotX = 0.32;
      this.velY = 0;
      this.dragging = false;
      this.lastX = 0;
      this.lastY = 0;
      this.moved = false;
      this.downPos = null;
      this.focusTween = null;
      this.anim = null; // 放生动画状态
      this.sparks = []; // 世界共时光点
      this.dots = buildDots();
      this.markers = Object.entries(WATERS_GEO).map(([id, w]) => ({
        id,
        name: w.name,
        color: TYPE_COLOR[w.type] || TYPE_COLOR.ocean,
        xyz: latLngToXYZ(w.lat, w.lng),
        selected: false,
        pulse: 0
      }));
    },
    detached() {
      this._stopped = true;
    },
    ready() {
      this.initCanvas();
    }
  },

  observers: {
    selectedWater(id) {
      this.markers.forEach(m => { m.selected = (m.id === id); });
      this.focusWater(id);
    }
  },

  methods: {
    initCanvas() {
      const query = this.createSelectorQuery();
      query.select('#globeCanvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          if (!res || !res[0] || !res[0].node) {
            this.triggerEvent('fallback'); // 降级到 2D 地图
            return;
          }
          try {
            const canvas = res[0].node;
            const dpr = Math.min(wx.getSystemInfoSync().pixelRatio || 2, 2);
            canvas.width = res[0].width * dpr;
            canvas.height = res[0].height * dpr;
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d');
            this.w = canvas.width;
            this.h = canvas.height;
            this.cssW = res[0].width;
            this.cssH = res[0].height;
            this.setData({ ready: true });
            this.startLoop();
          } catch (e) {
            console.error('[globe3d] init failed:', e);
            this.triggerEvent('fallback');
          }
        });
    },

    startLoop() {
      const loop = () => {
        if (this._stopped || !this.canvas) return;
        this.update();
        this.draw();
        this.canvas.requestAnimationFrame(loop);
      };
      this.canvas.requestAnimationFrame(loop);
    },

    update() {
      const now = Date.now();
      const dt = Math.min(50, now - (this._lastT || now));
      this._lastT = now;

      if (this.focusTween) {
        const t = Math.min(1, (now - this.focusTween.t0) / focusDur());
        const e = 1 - Math.pow(1 - t, 3);
        this.rotY = this.focusTween.fromY + (this.focusTween.toY - this.focusTween.fromY) * e;
        this.rotX = this.focusTween.fromX + (this.focusTween.toX - this.focusTween.fromX) * e;
        if (t >= 1) this.focusTween = null;
      } else if (!this.dragging) {
        this.rotY += (GLOBE_ANIM.AUTO_ROTATE_SPEED || 0.0004) * dt;
        this.rotY += this.velY;
        this.velY *= 0.94;
      }

      for (const m of this.markers) {
        if (m.selected) m.pulse = (m.pulse || 0) + dt;
      }
      // 光点生命周期
      this.sparks = this.sparks.filter(s => now - s.born < s.ttl);
    },

    // 三维 -> 屏幕（正交投影 + 旋转）
    project(xyz) {
      const { x, y, z } = xyz;
      const cy = Math.cos(this.rotY), sy = Math.sin(this.rotY);
      const cx = Math.cos(this.rotX), sx = Math.sin(this.rotX);
      // 先绕 Y，再绕 X
      const x1 = x * cy + z * sy;
      const z1 = -x * sy + z * cy;
      const y1 = y * cx - z1 * sx;
      const z2 = y * sx + z1 * cx;
      const R = Math.min(this.w, this.h) * 0.38;
      return {
        x: this.w / 2 + x1 * R,
        y: this.h / 2 - y1 * R,
        z: z2, // >0 朝向观察者
        R
      };
    },

    draw() {
      const ctx = this.ctx;
      if (!ctx) return;
      ctx.clearRect(0, 0, this.w, this.h);
      const R = Math.min(this.w, this.h) * 0.38;
      const cx = this.w / 2, cy2 = this.h / 2;

      // 球体底色（径向渐变）
      const grad = ctx.createRadialGradient(cx - R * 0.3, cy2 - R * 0.3, R * 0.1, cx, cy2, R);
      grad.addColorStop(0, '#cfe4dd');
      grad.addColorStop(0.7, '#a9d2c5');
      grad.addColorStop(1, '#7fb6a4');
      ctx.beginPath();
      ctx.arc(cx, cy2, R, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // 外圈辉光
      ctx.strokeStyle = 'rgba(127,216,192,0.35)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(cx, cy2, R + 8, 0, Math.PI * 2);
      ctx.stroke();

      // 点阵（背面淡化）
      for (const d of this.dots) {
        const p = this.project(d);
        const front = p.z > 0;
        ctx.fillStyle = front ? 'rgba(47,79,72,0.35)' : 'rgba(47,79,72,0.08)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, front ? 1.6 : 1.1, 0, Math.PI * 2);
        ctx.fill();
      }

      // 水域标记（只画面向观察者的）
      this._markerScreen = [];
      for (const m of this.markers) {
        const p = this.project(m.xyz);
        if (p.z < -0.05) continue;
        this._markerScreen.push({ m, p });
        const alpha = 0.35 + 0.65 * Math.min(1, p.z + 0.3);
        ctx.fillStyle = m.color;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, m.selected ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();

        if (m.selected) {
          const t = ((m.pulse || 0) % 1600) / 1600;
          ctx.strokeStyle = 'rgba(237,125,91,' + (0.8 * (1 - t)) + ')';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 6 + t * 16, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(237,125,91,' + alpha + ')';
          ctx.font = (this.w > 400 ? 13 : 11) + 'px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(m.name, p.x, p.y - 12);
        }
        ctx.globalAlpha = 1;
      }

      // 世界光点
      const now = Date.now();
      for (const s of this.sparks) {
        const p = this.project(s.xyz);
        if (p.z < 0) continue;
        const t = (now - s.born) / s.ttl;
        ctx.fillStyle = 'rgba(255,217,112,' + (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85) + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,217,112,' + 0.8 * (1 - t) + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 + t * 14, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 放生俯冲动画
      if (this.anim) this.drawAnim(ctx, now);
    },

    drawAnim(ctx, now) {
      const a = this.anim;
      const t = Math.min(1, (now - a.t0) / GLOBE_ANIM.DIVE_MS);
      const eased = t * t * (3 - 2 * t);
      // 二次贝塞尔：起点（外侧偏移）-> 控制点 -> 水域点
      const p0 = this.project(a.fromXyz);
      const p1 = this.project(a.ctrlXyz);
      const p2 = this.project(a.toXyz);
      const it = 1 - eased;
      const x = it * it * p0.x + 2 * it * eased * p1.x + eased * eased * p2.x;
      const y = it * it * p0.y + 2 * it * eased * p1.y + eased * eased * p2.y;

      // 生物光点 + 拖尾
      for (let k = 0; k < 5; k++) {
        const tt = Math.max(0, eased - k * 0.04);
        const i2 = 1 - tt;
        const tx = i2 * i2 * p0.x + 2 * i2 * tt * p1.x + tt * tt * p2.x;
        const ty = i2 * i2 * p0.y + 2 * i2 * tt * p1.y + tt * tt * p2.y;
        ctx.fillStyle = 'rgba(255,179,138,' + (0.5 - k * 0.09) + ')';
        ctx.beginPath();
        ctx.arc(tx, ty, 7 - k, 0, Math.PI * 2);
        ctx.fill();
      }

      // 入水后：涟漪 + 气泡
      if (t >= 0.9) {
        const rt = (now - a.t0 - GLOBE_ANIM.DIVE_MS * 0.9);
        for (let i = 0; i < 3; i++) {
          const lt = Math.min(1, Math.max(0, (rt - i * 260) / GLOBE_ANIM.RIPPLE_MS));
          if (lt <= 0) continue;
          ctx.strokeStyle = 'rgba(223,243,236,' + 0.85 * (1 - lt) + ')';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p2.x, p2.y, 4 + lt * 26, 0, Math.PI * 2);
          ctx.stroke();
        }
        // 气泡
        for (let i = 0; i < 14; i++) {
          const bt = ((rt + i * 97) % 1400) / 1400;
          ctx.fillStyle = 'rgba(234,250,244,' + 0.7 * (1 - bt) + ')';
          ctx.beginPath();
          ctx.arc(p2.x + Math.sin(i * 3.7) * 8, p2.y - bt * 22, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (now - a.t0 > GLOBE_ANIM.DIVE_MS + GLOBE_ANIM.RIPPLE_MS) {
        this.anim = null;
        if (a.done) a.done();
      }
    },

    focusWater(id) {
      const w = WATERS_GEO[id];
      if (!w || !this.canvas) return;
      let toY = -((w.lng + 180) * Math.PI / 180) + Math.PI / 2;
      const toX = (w.lat * Math.PI / 180) * 0.9;
      while (toY - this.rotY > Math.PI) toY -= Math.PI * 2;
      while (toY - this.rotY < -Math.PI) toY += Math.PI * 2;
      this.focusTween = { fromY: this.rotY, toY, fromX: this.rotX, toX, t0: Date.now() };
    },

    // 放生动画：生物从外侧俯冲潜入选定水域
    playRelease(creatureColor) {
      if (!this.canvas) return Promise.resolve();
      const w = WATERS_GEO[this.data.selectedWater] || WATERS_GEO.pacific;
      const to = latLngToXYZ(w.lat, w.lng);
      const from = {
        x: to.x * 0.3 + 1.6,
        y: to.y * 0.3 + 1.1,
        z: to.z * 0.3 + 0.8
      };
      const ctrl = {
        x: (to.x + from.x) / 2,
        y: (to.y + from.y) / 2 + 0.35,
        z: (to.z + from.z) / 2 + 0.4
      };
      return new Promise(resolve => {
        this.anim = {
          t0: Date.now(),
          fromXyz: from,
          ctrlXyz: ctrl,
          toXyz: to,
          color: creatureColor || '#ed7d5b',
          done: resolve
        };
      });
    },

    addSpark(waterId) {
      const w = WATERS_GEO[waterId];
      if (!w) return;
      this.sparks.push({ xyz: latLngToXYZ(w.lat, w.lng), born: Date.now(), ttl: 4200 });
    },

    // ---------- 触摸交互 ----------
    onTouchStart(e) {
      if (this.data.disabled) return;
      this.dragging = true;
      this.moved = false;
      this.downPos = { x: e.touches[0].x || e.touches[0].clientX, y: e.touches[0].y || e.touches[0].clientY };
      this.lastX = this.downPos.x;
      this.lastY = this.downPos.y;
      this.focusTween = null;
    },
    onTouchMove(e) {
      if (!this.dragging) return;
      const t = e.touches[0];
      const x = t.x !== undefined ? t.x : t.clientX;
      const y = t.y !== undefined ? t.y : t.clientY;
      const dx = x - this.lastX, dy = y - this.lastY;
      if (Math.abs(x - this.downPos.x) > 5 || Math.abs(y - this.downPos.y) > 5) this.moved = true;
      this.rotY += dx * 0.006;
      this.rotX = Math.max(-1.1, Math.min(1.1, this.rotX + dy * 0.004));
      this.velY = dx * 0.001;
      this.lastX = x; this.lastY = y;
    },
    onTouchEnd() {
      if (!this.dragging) return;
      this.dragging = false;
      // 未移动 = 点选：找最近的水域标记（屏幕距离 < 24px 且面向观察者）
      if (!this.moved && this._markerScreen) {
        const sx = this.w / (this.cssW || this.w);
        const sy = this.h / (this.cssH || this.h);
        let best = null, bestD = 26 * Math.max(sx, sy);
        for (const { m, p } of this._markerScreen) {
          const d = Math.hypot(p.x - this.downPos.x * sx, p.y - this.downPos.y * sy);
          if (d < bestD) { bestD = d; best = m; }
        }
        if (best) this.triggerEvent('select', { water: best.id });
      }
    }
  }
});

function focusDur() { return GLOBE_ANIM.FOCUS_MS || 900; }
