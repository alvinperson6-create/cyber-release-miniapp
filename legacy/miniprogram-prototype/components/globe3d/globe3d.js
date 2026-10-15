// 3D 地球组件（小程序端）v2
// canvas 2D 旋转球体：真实大陆轮廓（Natural Earth）+ 球面明暗 + 光束标记 + 星空
// 零依赖、低端机友好；canvas 初始化失败时由页面回落 SVG 地图
const { WATERS_GEO, GLOBE_ANIM } = require('../../utils/globe-config.js');
const WORLD_LAND = require('../../utils/world-land.js');

const TYPE_COLOR = {
  ocean: '#35e0b8',
  lake: '#4ee6c0',
  river: '#4ee6c0',
  trench: '#ff8a5e'
};

function latLngToXYZ(lat, lng) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lng + 180) * Math.PI / 180;
  return {
    x: -Math.sin(phi) * Math.cos(theta),
    y: Math.cos(phi),
    z: Math.sin(phi) * Math.sin(theta)
  };
}

Component({
  properties: {
    selectedWater: { type: String, value: '' },
    disabled: { type: Boolean, value: false }
  },

  data: { ready: false },

  lifetimes: {
    attached() {
      this.rotY = 2.9;
      this.rotX = 0.32;
      this.velY = 0;
      this.dragging = false;
      this.moved = false;
      this.lastX = 0;
      this.lastY = 0;
      this.downPos = null;
      this.focusTween = null;
      this.anim = null;
      this.sparks = [];
      this.stars = [];
      for (let i = 0; i < 90; i++) {
        this.stars.push({
          x: Math.random(), y: Math.random() * 0.9,
          r: 0.4 + Math.random() * 1.1,
          phase: Math.random() * Math.PI * 2
        });
      }
      this.markers = Object.entries(WATERS_GEO).map(([id, w]) => ({
        id,
        name: w.name,
        color: TYPE_COLOR[w.type] || TYPE_COLOR.ocean,
        xyz: latLngToXYZ(w.lat, w.lng),
        selected: false,
        pulse: 0
      }));
    },
    detached() { this._stopped = true; },
    ready() { this.initCanvas(); }
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
            this.triggerEvent('fallback');
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
        const t = Math.min(1, (now - this.focusTween.t0) / (GLOBE_ANIM.FOCUS_MS || 900));
        const e = 1 - Math.pow(1 - t, 3);
        this.rotY = this.focusTween.fromY + (this.focusTween.toY - this.focusTween.fromY) * e;
        this.rotX = this.focusTween.fromX + (this.focusTween.toX - this.focusTween.fromX) * e;
        if (t >= 1) this.focusTween = null;
      } else if (!this.dragging) {
        this.rotY += (GLOBE_ANIM.AUTO_ROTATE_SPEED || 0.0004) * dt + this.velY;
        this.velY *= 0.94;
      }
      for (const m of this.markers) {
        if (m.selected) m.pulse += dt;
      }
      this.sparks = this.sparks.filter(s => now - s.born < s.ttl);
    },

    // 三维 -> 屏幕（正交投影 + 旋转），返回 {x, y, z}
    project(xyz) {
      const { x, y, z } = xyz;
      const cy = Math.cos(this.rotY), sy = Math.sin(this.rotY);
      const cx = Math.cos(this.rotX), sx = Math.sin(this.rotX);
      const x1 = x * cy + z * sy;
      const z1 = -x * sy + z * cy;
      const y1 = y * cx - z1 * sx;
      const z2 = y * sx + z1 * cx;
      const R = Math.min(this.w, this.h) * 0.36;
      return { x: this.w / 2 + x1 * R, y: this.h / 2 - y1 * R, z: z2 };
    },

    draw() {
      const ctx = this.ctx;
      if (!ctx) return;
      const now = Date.now();
      const R = Math.min(this.w, this.h) * 0.36;
      const cx = this.w / 2, cy2 = this.h / 2;

      // ---- 深空背景 ----
      const bg = ctx.createLinearGradient(0, 0, 0, this.h);
      bg.addColorStop(0, '#0b2b36');
      bg.addColorStop(0.55, '#08222e');
      bg.addColorStop(1, '#041018');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, this.w, this.h);

      // ---- 星空 ----
      const tt = now / 1000;
      for (const s of this.stars) {
        const a = 0.3 + 0.5 * (0.5 + 0.5 * Math.sin(tt * 1.3 + s.phase));
        ctx.fillStyle = `rgba(223,243,236,${a})`;
        ctx.beginPath();
        ctx.arc(s.x * this.w, s.y * this.h, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // ---- 球体底色（海洋径向渐变） ----
      const grad = ctx.createRadialGradient(cx - R * 0.35, cy2 - R * 0.35, R * 0.1, cx, cy2, R);
      grad.addColorStop(0, '#2a7a6b');
      grad.addColorStop(0.55, '#115550');
      grad.addColorStop(1, '#062127');
      ctx.beginPath();
      ctx.arc(cx, cy2, R, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // ---- 大气外光晕 ----
      ctx.strokeStyle = 'rgba(80,220,190,0.22)';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(cx, cy2, R + 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(80,220,190,0.35)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy2, R + 2, 0, Math.PI * 2);
      ctx.stroke();

      // ---- 真实大陆（只画朝向观察者的部分） ----
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy2, R, 0, Math.PI * 2);
      ctx.clip();
      for (const ring of WORLD_LAND.rings) {
        ctx.beginPath();
        let started = false;
        let prevOk = false;
        let prev = null;
        let anyOk = false;
        for (const [lng, lat] of ring) {
          const p = this.project(latLngToXYZ(lat, lng));
          const ok = p.z > 0.02;
          if (ok) anyOk = true;
          if (ok && !prevOk) { ctx.moveTo(p.x, p.y); started = true; }
          else if (ok && started) ctx.lineTo(p.x, p.y);
          prevOk = ok;
          prev = p;
        }
        if (!anyOk) continue;
        ctx.closePath();
        // 陆地：哑光青灰，边缘略亮
        const shade = 0.85;
        ctx.fillStyle = `rgba(94,118,108,${0.88 * shade})`;
        ctx.fill();
        // 荧光海岸线
        ctx.strokeStyle = 'rgba(80,240,200,0.5)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.restore();

      // ---- 球面明暗（右上来光，左下渐暗） ----
      const shade = ctx.createRadialGradient(cx + R * 0.45, cy2 - R * 0.45, R * 0.1, cx, cy2, R * 1.05);
      shade.addColorStop(0, 'rgba(255,250,235,0.10)');
      shade.addColorStop(0.5, 'rgba(0,0,0,0)');
      shade.addColorStop(1, 'rgba(2,10,16,0.5)');
      ctx.beginPath();
      ctx.arc(cx, cy2, R, 0, Math.PI * 2);
      ctx.fillStyle = shade;
      ctx.fill();

      // ---- 水域标记（光点 + 光柱 + 标签） ----
      this._markerScreen = [];
      const sorted = this.markers
        .map(m => ({ m, p: this.project(m.xyz) }))
        .sort((a, b) => a.p.z - b.p.z); // 远的先画
      for (const { m, p } of sorted) {
        if (p.z < 0) continue;
        this._markerScreen.push({ m, p });
        const vis = Math.min(1, p.z + 0.25);
        const pulse = 0.5 + 0.5 * Math.sin(tt * 2.2 + p.x * 0.05);
        const col = m.color;

        // 光柱（从表面向外的渐隐线）
        const beamLen = (m.selected ? 26 : 14) * vis;
        const bx = (p.x - cx) / R, by = (p.y - cy2) / R;
        const lg = ctx.createLinearGradient(p.x, p.y, p.x + bx * beamLen, p.y + by * beamLen);
        lg.addColorStop(0, this.rgba(col, 0.55 * vis));
        lg.addColorStop(1, this.rgba(col, 0));
        ctx.strokeStyle = lg;
        ctx.lineWidth = m.selected ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + bx * beamLen, p.y + by * beamLen);
        ctx.stroke();

        // 光晕
        const haloR = (m.selected ? 12 : 8) + pulse * 3;
        const hg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, haloR);
        hg.addColorStop(0, this.rgba(col, 0.55 * vis));
        hg.addColorStop(1, this.rgba(col, 0));
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.arc(p.x, p.y, haloR, 0, Math.PI * 2);
        ctx.fill();

        // 光点
        ctx.fillStyle = this.rgba(col, Math.min(1, 0.5 + vis));
        ctx.beginPath();
        ctx.arc(p.x, p.y, m.selected ? 5 : 3.2, 0, Math.PI * 2);
        ctx.fill();

        // 选中脉冲环 + 标签
        if (m.selected) {
          const pt = (m.pulse % 1500) / 1500;
          ctx.strokeStyle = `rgba(255,179,138,${0.9 * (1 - pt)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 6 + pt * 16, 0, Math.PI * 2);
          ctx.stroke();

          const fs = this.w > 500 ? 13 : 11;
          ctx.font = `600 ${fs}px sans-serif`;
          const tw = ctx.measureText(m.name).width;
          const lx = Math.min(this.w - tw / 2 - 8, Math.max(tw / 2 + 8, p.x));
          const ly = Math.max(fs + 6, p.y - 12);
          ctx.fillStyle = 'rgba(237,125,91,0.92)';
          this.roundRect(ctx, lx - tw / 2 - 7, ly - fs, tw + 14, fs + 9, (fs + 9) / 2);
          ctx.fill();
          ctx.fillStyle = '#fff7ee';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(m.name, lx, ly - fs / 2 + 1);
        }
      }

      // ---- 世界光点 ----
      for (const s of this.sparks) {
        const p = this.project(s.xyz);
        if (p.z < 0) continue;
        const t = (now - s.born) / s.ttl;
        const a = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
        ctx.fillStyle = `rgba(255,217,112,${a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,217,112,${0.8 * (1 - t)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4 + t * 14, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (this.anim) this.drawAnim(ctx, now);
    },

    rgba(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
    },

    roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    },

    drawAnim(ctx, now) {
      const a = this.anim;
      const t = Math.min(1, (now - a.t0) / GLOBE_ANIM.DIVE_MS);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const p0 = this.project(a.fromXyz);
      const p1 = this.project(a.ctrlXyz);
      const p2 = this.project(a.toXyz);
      const bez = (tt) => {
        const it = 1 - tt;
        return {
          x: it * it * p0.x + 2 * it * tt * p1.x + tt * tt * p2.x,
          y: it * it * p0.y + 2 * it * tt * p1.y + tt * tt * p2.y
        };
      };

      // 拖尾
      for (let k = 5; k >= 0; k--) {
        const tt = Math.max(0, eased - k * 0.045);
        const pos = bez(tt);
        ctx.fillStyle = `rgba(255,179,138,${0.45 - k * 0.07})`;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 9 - k, 0, Math.PI * 2);
        ctx.fill();
      }
      // 光灵
      const pos = bez(eased);
      const shrink = Math.max(0.15, 1 - Math.max(0, (eased - 0.78)) * 4);
      const g = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 16 * shrink);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.4, 'rgba(255,179,138,0.8)');
      g.addColorStop(1, 'rgba(255,179,138,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 16 * shrink, 0, Math.PI * 2);
      ctx.fill();

      // 溅落
      if (t >= 0.9) {
        const rt = now - a.t0 - GLOBE_ANIM.DIVE_MS * 0.9;
        const cx2 = this.w / 2, cy3 = this.h / 2;
        const R = Math.min(this.w, this.h) * 0.36;
        const bx = (p2.x - cx2) / R, by = (p2.y - cy3) / R;
        // 闪光
        const ft = Math.min(1, rt / 260);
        ctx.fillStyle = `rgba(255,255,255,${(1 - ft) * 0.85})`;
        ctx.beginPath();
        ctx.arc(p2.x, p2.y, 6 + ft * 22, 0, Math.PI * 2);
        ctx.fill();
        // 涟漪 x3
        for (let i = 0; i < 3; i++) {
          const lt = Math.min(1, Math.max(0, (rt - i * 240) / GLOBE_ANIM.RIPPLE_MS));
          if (lt <= 0) continue;
          ctx.strokeStyle = `rgba(191,255,240,${0.9 * (1 - lt)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(p2.x, p2.y, 6 + lt * 34, (6 + lt * 34) * 0.35, Math.atan2(by, bx), 0, Math.PI * 2);
          ctx.stroke();
        }
        // 光柱
        const bl = Math.min(1, rt / 400);
        ctx.strokeStyle = `rgba(255,179,138,${0.6 * (1 - bl)})`;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(p2.x, p2.y);
        ctx.lineTo(p2.x + bx * 46, p2.y + by * 46);
        ctx.stroke();
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

    playRelease(creatureColor) {
      if (!this.canvas) return Promise.resolve();
      const w = WATERS_GEO[this.data.selectedWater] || WATERS_GEO.pacific;
      const to = latLngToXYZ(w.lat, w.lng);
      const from = { x: to.x * 0.3 + 1.6, y: to.y * 0.3 + 1.1, z: to.z * 0.3 + 0.8 };
      const ctrl = {
        x: (to.x + from.x) / 2,
        y: (to.y + from.y) / 2 + 0.35,
        z: (to.z + from.z) / 2 + 0.4
      };
      return new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        this.anim = { t0: Date.now(), fromXyz: from, ctrlXyz: ctrl, toXyz: to, color: creatureColor || '#ed7d5b', done: finish };
        // 兜底：渲染帧被节流时回执仍按时出现
        setTimeout(finish, GLOBE_ANIM.DIVE_MS + 900);
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
      const t0 = e.touches[0];
      this.downPos = { x: t0.x !== undefined ? t0.x : t0.clientX, y: t0.y !== undefined ? t0.y : t0.clientY };
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
      if (!this.moved && this._markerScreen) {
        const sx = this.w / (this.cssW || this.w);
        const sy = this.h / (this.cssH || this.h);
        let best = null, bestD = 30 * Math.max(sx, sy);
        for (const { m, p } of this._markerScreen) {
          const d = Math.hypot(p.x - this.downPos.x * sx, p.y - this.downPos.y * sy);
          if (d < bestD) { bestD = d; best = m; }
        }
        if (best) this.triggerEvent('select', { water: best.id });
      }
    }
  }
});
