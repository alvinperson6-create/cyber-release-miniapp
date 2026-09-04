/* ============================================================
 * Globe3D v2 —— 赛博放生 3D 水色地球（网页版）
 * 依赖：全局 THREE（three.min.js + 可选 postprocessing UMD）
 *
 * 视觉核心：
 *   - 着色器海洋：fbm 洋流动画 + 深度渐变 + 太阳高光 + 菲涅尔边缘
 *   - 真实大陆（world-land.json，Natural Earth 公共领域数据）
 *     + 发光海岸线 + 夜半球生物荧光海岸（赛博放生 signature）
 *   - 半透明云层（噪声生成，独立缓慢旋转）
 *   - 双层大气（内菲涅尔 + 外散射光晕）
 *   - 1500 星星星空（闪烁）
 *   - 水域标记：发光点 + 垂直光柱 + 光环 + 相机朝向渐隐标签
 *   - UnrealBloom 后处理（存在则启用，缺失自动降级）
 *   - 电影感放生俯冲：光灵 + 拖尾 + 相机推近 + 涟漪/气泡/光柱/闪光
 *
 * 对外接口（与 v1 兼容）：
 *   Globe3D.init({ canvas, onSelect, onReady, disabled }) -> bool
 *   Globe3D.loadConfig(cfg)
 *   Globe3D.focusWater(id) / setMarkersState(id)
 *   Globe3D.playRelease({ creature, water }) -> Promise
 *   Globe3D.addSpark({ lat, lng, color })
 *   Globe3D.destroy()
 * ============================================================ */
(function () {
  const Globe3D = { destroy: function () {} };
  let G = null;

  // ---------- 数学工具 ----------
  function latLngToV3(lat, lng, r) {
    const phi = (90 - lat) * Math.PI / 180;
    const theta = (lng + 180) * Math.PI / 180;
    return new THREE.Vector3(
      -r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta)
    );
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const easeInOut = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  // ---------- GLSL 公共噪声 ----------
  const GLSL_NOISE = `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    // x 方向按 period 周期化，保证贴图接缝连续
    float vnoise(vec2 p, float period) {
      vec2 i = floor(p), f = fract(p);
      float ix = mod(i.x, period);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(vec2(ix, i.y));
      float b = hash(vec2(mod(ix + 1.0, period), i.y));
      float c = hash(vec2(ix, i.y + 1.0));
      float d = hash(vec2(mod(ix + 1.0, period), i.y + 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    float fbm(vec2 p, float period) {
      float v = 0.0, amp = 0.5;
      for (int i = 0; i < 4; i++) {
        v += amp * vnoise(p, period);
        p *= 2.03; period *= 2.03; amp *= 0.5;
      }
      return v;
    }`;

  // ---------- 贴图生成 ----------
  // 大陆掩码：R=陆地(锐利) G=海岸带(膨胀) —— 在着色器里分别驱动陆地颜色与发光海岸
  function buildLandMask(worldLand) {
    const W = 2048, H = 1024;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    const drawRing = (ring, scale, blur) => {
      ctx.beginPath();
      let started = false;
      let prevX = null;
      for (const [lng, lat] of ring) {
        let x = ((lng + 180) / 360) * W;
        const y = ((90 - lat) / 180) * H;
        // 跨经度 180° 断线
        if (prevX !== null && Math.abs(x - prevX) > W / 2) {
          if (x > prevX) x -= W; else x += W;
        }
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
        prevX = x;
      }
      ctx.closePath();
      if (blur) { ctx.lineWidth = 9; ctx.strokeStyle = '#0f0'; ctx.stroke(); }
      else { ctx.fillStyle = '#f00'; ctx.fill(); }
    };

    const rings = (worldLand && worldLand.rings) || [];
    // G 通道：海岸发光带（粗描边）
    for (const r of rings) drawRing(r, 1, true);
    // R 通道：陆地本体
    for (const r of rings) drawRing(r, 1, false);

    // 合成到单张 texture（canvas 颜色即 mask：R/G 通道）
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }

  // 云层 alpha 噪声
  function buildCloudTexture() {
    const W = 1024, H = 512;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    const P = 8; // 噪声周期（横向平铺）
    const hash = (x, y) => {
      const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return s - Math.floor(s);
    };
    const noise = (x, y) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const sx = ((ix % P) + P) % P;
      const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
      const a = hash(sx, iy), b = hash((sx + 1) % P, iy);
      const c2 = hash(sx, iy + 1), d = hash((sx + 1) % P, iy + 1);
      return (a + (b - a) * u) * (1 - v) + (c2 + (d - c2) * u) * v;
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const nx = (x / W) * P, ny = (y / H) * 4;
        let v = 0, amp = 0.5, px = nx, py = ny, per = P;
        for (let o = 0; o < 4; o++) {
          // fbm（横向周期化）
          const ix = Math.floor(px), iy2 = Math.floor(py);
          const fx = px - ix, fy2 = py - iy2;
          const sx = ((ix % per) + per) % per;
          const u = fx * fx * (3 - 2 * fx), vv = fy2 * fy2 * (3 - 2 * fy2);
          const a = hash(sx, iy2), b = hash((sx + 1) % per, iy2);
          const c2 = hash(sx, iy2 + 1), d = hash((sx + 1) % per, iy2 + 1);
          v += amp * ((a + (b - a) * u) * (1 - vv) + (c2 + (d - c2) * u) * vv);
          px *= 2.03; py *= 2.03; per *= 2.03; amp *= 0.5;
        }
        // 带状拉伸（信风感）+ 阈值
        const band = 0.5 + 0.5 * Math.sin((y / H) * Math.PI * 5 + v * 2.0);
        let alpha = clamp((v * 0.8 + band * 0.4 - 0.62) * 3.2, 0, 1);
        // 极地少云
        const polar = Math.abs(y / H - 0.5) * 2;
        alpha *= clamp(1.4 - polar * 1.2, 0, 1);
        const i = (y * W + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
        img.data[i + 3] = Math.floor(alpha * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    return tex;
  }

  // 径向光晕贴图（sprite 通用）
  function buildGlowTexture(inner, outer) {
    const S = 128;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.35, outer);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return new THREE.CanvasTexture(c);
  }

  // 文字标签贴图
  function buildLabelTexture(text, selected) {
    const pad = 18, fs = 26;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = `600 ${fs}px "PingFang SC","Microsoft YaHei",sans-serif`;
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    c.width = w; c.height = fs + pad * 1.4;
    const ctx2 = c.getContext('2d');
    ctx2.font = `600 ${fs}px "PingFang SC","Microsoft YaHei",sans-serif`;
    // 胶囊底
    ctx2.fillStyle = selected ? 'rgba(237,125,91,0.92)' : 'rgba(8,38,44,0.62)';
    const r = c.height / 2;
    ctx2.beginPath();
    ctx2.moveTo(r, 0);
    ctx2.arcTo(c.width, 0, c.width, c.height, r);
    ctx2.arcTo(c.width, c.height, 0, c.height, r);
    ctx2.arcTo(0, c.height, 0, 0, r);
    ctx2.arcTo(0, 0, c.width, 0, r);
    ctx2.fill();
    ctx2.strokeStyle = selected ? 'rgba(255,220,190,0.9)' : 'rgba(169,210,197,0.55)';
    ctx2.lineWidth = 2;
    ctx2.stroke();
    ctx2.fillStyle = selected ? '#fff7ee' : '#dff3ec';
    ctx2.textAlign = 'center';
    ctx2.textBaseline = 'middle';
    ctx2.fillText(text, c.width / 2, c.height / 2 + 1);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    return { tex, aspect: c.width / c.height };
  }

  // ============================================================
  // init
  // ============================================================
  Globe3D.init = function (opts) {
    if (typeof THREE === 'undefined' || !opts || !opts.canvas) return false;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, alpha: true });
    } catch (e) { return false; }
    Globe3D.destroy();

    const canvas = opts.canvas;
    const hasBloom = !!(THREE.EffectComposer && THREE.RenderPass && THREE.UnrealBloomPass && THREE.ShaderPass);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, hasBloom ? 1.75 : 2));

    const scene = new THREE.Scene();

    // 深空渐变背景穹顶（自绘，保证经过 bloom 后仍有层次背景）
    const skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(80, 32, 32),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false,
        vertexShader: `varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          varying vec3 vP;
          void main() {
            float h = normalize(vP).y * 0.5 + 0.5;
            vec3 top = vec3(0.012, 0.055, 0.075);   // 深青
            vec3 mid = vec3(0.045, 0.13, 0.16);
            vec3 bot = vec3(0.006, 0.02, 0.035);    // 近黑
            vec3 col = h > 0.5 ? mix(mid, top, (h - 0.5) * 2.0) : mix(bot, mid, h * 2.0);
            gl_FragColor = vec4(col, 1.0);
          }`
      })
    );
    scene.add(skyDome);

    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 120);
    const CAM_BASE = new THREE.Vector3(0, 0.42, 3.55);
    camera.position.copy(CAM_BASE);
    camera.lookAt(0, 0, 0);

    const R = 1.15;
    const globeGroup = new THREE.Group();
    scene.add(globeGroup);

    const sunDir = new THREE.Vector3(4.5, 1.7, 3.4).normalize();
    const uniforms = {
      uTime: { value: 0 },
      uLand: { value: buildLandMask(Globe3D.WORLD_LAND) },
      uSunDir: { value: sunDir },
      uCamPos: { value: camera.position }
    };

    // ---------- 星空 ----------
    const starCount = 2200;
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(starCount * 3);
    const starAttr = new Float32Array(starCount * 2); // size, phase
    const starCol = new Float32Array(starCount * 3);
    const palette = [[1, 1, 1], [0.78, 1, 0.94], [1, 0.94, 0.78], [0.72, 0.9, 1]];
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(40 + Math.random() * 30);
      starPos.set([v.x, v.y, v.z], i * 3);
      starAttr.set([1.2 + Math.random() * 2.6, Math.random() * Math.PI * 2], i * 2);
      const col = palette[Math.floor(Math.random() * palette.length)];
      starCol.set(col, i * 3);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('aData', new THREE.BufferAttribute(starAttr, 2));
    starGeo.setAttribute('aColor', new THREE.BufferAttribute(starCol, 3));
    const stars = new THREE.Points(starGeo, new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: uniforms.uTime, uScale: { value: 62 } },
      vertexShader: `
        attribute vec2 aData; attribute vec3 aColor;
        varying float vAlpha; varying vec3 vColor;
        uniform float uTime; uniform float uScale;
        void main() {
          vColor = aColor;
          vAlpha = 0.45 + 0.55 * sin(uTime * (0.4 + aData.y * 0.15) + aData.y * 7.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aData.x * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vAlpha; varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.1, length(d)) * vAlpha;
          gl_FragColor = vec4(vColor, a);
        }`
    }));
    scene.add(stars);

    // ---------- 海洋本体（着色器） ----------
    const oceanMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `
        varying vec2 vUv; varying vec3 vNormal; varying vec3 vWorldPos;
        void main() {
          vUv = uv;
          vNormal = normalize(mat3(modelMatrix) * normal);
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime; uniform sampler2D uLand; uniform vec3 uSunDir; uniform vec3 uCamPos;
        varying vec2 vUv; varying vec3 vNormal; varying vec3 vWorldPos;
        ${GLSL_NOISE}
        void main() {
          vec2 uv = vec2(fract(vUv.x + uTime * 0.002), vUv.y);
          vec4 mask = texture2D(uLand, uv);
          float land = mask.r;
          float coast = mask.g;

          // ---- 海洋：深度渐变 + 洋流 fbm ----
          float lat = abs(vUv.y - 0.5) * 2.0;            // 0 赤道 1 极地
          float flow = fbm(uv * vec2(7.0, 4.0) + vec2(uTime * 0.008, 0.0), 7.0);
          float flow2 = fbm(uv * vec2(16.0, 9.0) - vec2(uTime * 0.015, uTime * 0.004), 16.0);
          vec3 deepCol  = vec3(0.023, 0.129, 0.153);     // #062127 深海
          vec3 midCol   = vec3(0.065, 0.335, 0.310);     // #115550
          vec3 shalCol  = vec3(0.33, 0.63, 0.53);        // #54a187 浅滩
          vec3 oceanCol = mix(deepCol, midCol, smoothstep(0.12, 0.8, flow));
          oceanCol = mix(oceanCol, shalCol, smoothstep(0.55, 0.92, flow2) * 0.62);
          oceanCol = mix(oceanCol, deepCol * 1.25, lat * 0.55); // 极地更深

          // ---- 陆地：哑光青灰 + 颗粒（避免过曝，只让海岸发光） ----
          float grain = vnoise(uv * 90.0, 90.0) * 0.06;
          vec3 landCol = vec3(0.337, 0.420, 0.388);      // #566b63 哑光
          landCol = mix(landCol, vec3(0.30, 0.42, 0.36), smoothstep(0.4, 0.9, lat));
          landCol += grain;

          vec3 col = mix(oceanCol, landCol, land);

          // ---- 光照 ----
          vec3 N = normalize(vNormal);
          vec3 V = normalize(uCamPos - vWorldPos);
          float diff = clamp(dot(N, uSunDir), 0.0, 1.0);
          float dayMix = smoothstep(-0.15, 0.25, dot(N, uSunDir));
          col *= 0.30 + 0.78 * diff;
          // 夜面月光底光：陆地隐约可见，配合荧光海岸
          col += mix(landCol * 0.16, vec3(0.0), dayMix) * land;
          col += mix(oceanCol * 0.10, vec3(0.0), dayMix) * (1.0 - land);

          // 海面太阳高光（仅海洋）：宽光 + 中心亮点双层
          vec3 H = normalize(uSunDir + V);
          float specCore = pow(clamp(dot(N, H), 0.0, 1.0), 120.0);
          float specWide = pow(clamp(dot(N, H), 0.0, 1.0), 18.0);
          float oceanOnly = 1.0 - land;
          col += vec3(1.0, 0.90, 0.72) * (specCore * 0.9 + specWide * 0.16) * oceanOnly;
          // 洋流高光提亮（波纹对阳光的漫反射，让水活起来）
          col += vec3(0.35, 0.75, 0.65) * flow2 * oceanOnly * dayMix * 0.10;

          // ---- 海岸线细发光（低强度 + 呼吸，内侧陆地保持暗） ----
          vec3 coastDay = vec3(0.25, 0.85, 0.68);
          vec3 coastNight = vec3(0.10, 0.75, 0.68);
          float breathe = 0.7 + 0.3 * sin(uTime * 1.2 + vUv.x * 20.0);
          col += mix(coastNight, coastDay, dayMix) * coast * (1.0 - land) * 0.42 * breathe;

          // ---- 菲涅尔边缘（大气散射内层） ----
          float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.6);
          col += vec3(0.38, 0.92, 0.80) * fres * (0.45 + 0.35 * dayMix);

          gl_FragColor = vec4(col, 1.0);
        }`
    });
    const earth = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 96), oceanMat);
    globeGroup.add(earth);

    // ---------- 云层 ----------
    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.028, 64, 64),
      new THREE.ShaderMaterial({
        transparent: true, depthWrite: false,
        uniforms: { uTime: uniforms.uTime, uMap: { value: buildCloudTexture() } },
        vertexShader: `
          varying vec2 vUv; varying vec3 vNormal;
          void main() {
            vUv = uv; vNormal = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform sampler2D uMap; uniform float uTime;
          varying vec2 vUv; varying vec3 vNormal;
          void main() {
            vec2 uv = vec2(fract(vUv.x + uTime * 0.0016), vUv.y);
            float a = texture2D(uMap, uv).a;
            float rim = pow(1.0 - abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0))), 1.5);
            gl_FragColor = vec4(vec3(0.94, 0.99, 0.97), a * 0.42 * (1.0 - rim * 0.6));
          }`
      })
    );
    globeGroup.add(clouds);

    // ---------- 大气：内层 + 外层光晕 ----------
    const atmoInner = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.075, 64, 64),
      new THREE.ShaderMaterial({
        transparent: true, side: THREE.BackSide, depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uSunDir: { value: sunDir } },
        vertexShader: `
          varying vec3 vNormal; varying vec3 vView;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vView = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform vec3 uSunDir; varying vec3 vNormal; varying vec3 vView;
          void main() {
            float rim = pow(1.0 - abs(dot(vNormal, vView)), 3.0);
            float sun = 0.55 + 0.45 * dot(vNormal, normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz));
            gl_FragColor = vec4(vec3(0.38, 0.9, 0.78), rim * 0.9 * clamp(sun, 0.15, 1.0));
          }`
      })
    );
    scene.add(atmoInner);

    const atmoHalo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.26, 48, 48),
      new THREE.ShaderMaterial({
        transparent: true, side: THREE.BackSide, depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          varying float vI;
          void main() {
            vec3 n = normalize(normalMatrix * normal);
            vI = pow(clamp(0.62 - dot(n, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 3.2);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying float vI;
          void main() { gl_FragColor = vec4(vec3(0.32, 0.88, 0.76), clamp(vI, 0.0, 1.0) * 0.72); }`
      })
    );
    scene.add(atmoHalo);

    // ---------- 水域标记 ----------
    const TYPE_COLOR = { ocean: 0x35e0b8, lake: 0x4ee6c0, river: 0x4ee6c0, trench: 0xff8a5e };
    const glowTex = buildGlowTexture('rgba(255,255,255,0.95)', 'rgba(120,255,220,0.35)');
    const markers = {};
    const markerRoot = new THREE.Group();
    globeGroup.add(markerRoot);

    for (const [id, w] of Object.entries(Globe3D.WATERS_GEO || {})) {
      const pos = latLngToV3(w.lat, w.lng, R);
      const normal = pos.clone().normalize();
      const color = TYPE_COLOR[w.type] || TYPE_COLOR.ocean;
      const mk = { pos, selected: false, beamT: Math.random() * Math.PI * 2 };

      // 发光点（bloom 抓亮）
      mk.dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.024, 14, 14),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.8) })
      );
      mk.dot.position.copy(pos);

      // 光环 sprite
      mk.halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      mk.halo.scale.setScalar(0.12);
      mk.halo.position.copy(pos);

      // 垂直光柱
      const beamH = 0.17;
      mk.beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.008, 0.021, beamH, 12, 1, true),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.5,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
        })
      );
      mk.beam.position.copy(pos).addScaledVector(normal, beamH / 2);
      mk.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);

      // 选中脉冲环（表面双环）
      mk.rings = [0, 1].map(i => {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(i === 0 ? 0.035 : 0.062, i === 0 ? 0.043 : 0.067, 40),
          new THREE.MeshBasicMaterial({
            color: 0xffb38a, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false
          })
        );
        ring.position.copy(pos).multiplyScalar(1.006);
        ring.lookAt(pos.clone().multiplyScalar(2));
        return ring;
      });

      // 标签 sprite（普通/选中两个贴图）
      mk.labels = {};
      for (const sel of [false, true]) {
        const { tex, aspect } = buildLabelTexture(w.name, sel);
        mk.labels[sel] = { tex, aspect };
      }
      mk.label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: mk.labels.false.tex, transparent: true, opacity: 0,
        depthWrite: false, depthTest: false
      }));
      const lw = 0.14;
      mk.label.scale.set(lw, lw / mk.labels.false.aspect, 1);
      mk.label.position.copy(pos).addScaledVector(normal, 0.115);

      // 射线命中体
      mk.hit = new THREE.Mesh(
        new THREE.SphereGeometry(0.095, 8, 8),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      mk.hit.position.copy(pos);
      mk.hit.userData.waterId = id;

      markerRoot.add(mk.dot, mk.halo, mk.beam, mk.label, mk.hit, ...mk.rings);
      markers[id] = mk;
    }

    // ---------- 世界光点 ----------
    const sparkGlow = buildGlowTexture('rgba(255,240,200,1)', 'rgba(255,200,90,0.4)');
    const sparks = [];
    Globe3D.addSpark = function (sp) {
      const pos = latLngToV3(sp.lat, sp.lng, R);
      const normal = pos.clone().normalize();
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: sparkGlow, color: 0xffd970, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false
      }));
      s.scale.setScalar(0.07);
      s.position.copy(pos);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.02, 0.028, 28),
        new THREE.MeshBasicMaterial({
          color: 0xffd970, transparent: true, opacity: 0.9,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false
        })
      );
      ring.position.copy(pos).multiplyScalar(1.005);
      ring.lookAt(pos.clone().multiplyScalar(2));
      globeGroup.add(s, ring);
      sparks.push({ s, ring, born: performance.now(), ttl: 4500 });
    };

    // ---------- 交互 ----------
    let targetRotY = 2.9, targetRotX = 0.35;
    let curRotY = targetRotY, curRotX = targetRotX;
    let velY = 0;
    let dragging = false, moved = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
    let focusTween = null;
    const raycaster = new THREE.Raycaster();
    const pointerNDC = new THREE.Vector2();

    function onDown(e) {
      if (opts.disabled && opts.disabled()) return;
      dragging = true; moved = false;
      lastX = downX = e.clientX; lastY = downY = e.clientY;
      focusTween = null;
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    }
    function onMove(e) {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5) moved = true;
      targetRotY += dx * 0.005;
      targetRotX = clamp(targetRotX + dy * 0.0032, -1.1, 1.1);
      velY = dx * 0.005;
      lastX = e.clientX; lastY = e.clientY;
    }
    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      if (!moved) {
        const rect = canvas.getBoundingClientRect();
        pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointerNDC, camera);
        const hits = raycaster.intersectObjects(Object.values(markers).map(m => m.hit));
        if (hits.length && opts.onSelect) opts.onSelect(hits[0].object.userData.waterId);
      }
    }
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', () => { dragging = false; });

    let pinchStart = 0, camStartZ = CAM_BASE.z;
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinchStart = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        camStartZ = camera.position.z;
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinchStart > 0) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        camera.position.z = clamp(camStartZ * pinchStart / d, 2.3, 5.5);
      }
    }, { passive: true });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      camera.position.z = clamp(camera.position.z + e.deltaY * 0.002, 2.3, 5.5);
    }, { passive: false });

    // ---------- 聚焦水域 ----------
    Globe3D.focusWater = function (waterId) {
      const w = (Globe3D.WATERS_GEO || {})[waterId];
      if (!w) return;
      let ty = -((w.lng + 180) * Math.PI / 180) + Math.PI / 2;
      const tx = (w.lat * Math.PI / 180) * 0.9;
      while (ty - curRotY > Math.PI) ty -= Math.PI * 2;
      while (ty - curRotY < -Math.PI) ty += Math.PI * 2;
      focusTween = { fromY: curRotY, toY: ty, fromX: curRotX, toX: tx, t0: performance.now(), dur: (Globe3D.GLOBE_ANIM && Globe3D.GLOBE_ANIM.FOCUS_MS) || 900 };
      for (const [id, m] of Object.entries(markers)) {
        m.selected = (id === waterId);
      }
      // 点击涟漪反馈
      spawnSelectRipple(waterId);
    };

    // 选中瞬间的水面涟漪（一次性）
    const selectRipples = [];
    function spawnSelectRipple(waterId) {
      const m = markers[waterId];
      if (!m) return;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.05, 0.062, 48),
        new THREE.MeshBasicMaterial({
          color: 0xffb38a, transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false
        })
      );
      ring.position.copy(m.pos).multiplyScalar(1.006);
      ring.lookAt(m.pos.clone().multiplyScalar(2));
      globeGroup.add(ring);
      selectRipples.push({ mesh: ring, born: performance.now(), dur: 900 });
    }
    Globe3D.setMarkersState = function (selectedId) {
      for (const [id, m] of Object.entries(markers)) m.selected = (id === selectedId);
    };

    // ---------- 放生俯冲动画 ----------
    Globe3D.playRelease = function (playOpts) {
      return new Promise((resolve) => {
        const conf = (Globe3D.CREATURE_3D || {})[playOpts.creature] || { color: 0xed7d5b, glow: 0xffb38a };
        const w = (Globe3D.WATERS_GEO || {})[playOpts.water] || { lat: 0, lng: -160 };
        const target = latLngToV3(w.lat, w.lng, R);
        const normal = target.clone().normalize();
        Globe3D.focusWater(playOpts.water);

        // 光灵：核心 + 白芯 + 双卫星
        const spirit = new THREE.Group();
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(0.034, 18, 18),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(conf.glow).multiplyScalar(1.5) })
        );
        const inner = new THREE.Mesh(
          new THREE.SphereGeometry(0.02, 12, 12),
          new THREE.MeshBasicMaterial({ color: 0xffffff })
        );
        const sat1 = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 8), new THREE.MeshBasicMaterial({ color: conf.color }));
        const sat2 = sat1.clone();
        spirit.add(core, inner, sat1, sat2);
        const spiritGlow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTex, color: conf.glow, transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending, depthWrite: false
        }));
        spiritGlow.scale.setScalar(0.22);
        globeGroup.add(spirit, spiritGlow);

        // 拖尾（软光斑池）
        const trailTex = buildGlowTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0.25)');
        const trail = [];
        for (let i = 0; i < 16; i++) {
          const p = new THREE.Sprite(new THREE.SpriteMaterial({
            map: trailTex, color: conf.glow, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false
          }));
          globeGroup.add(p);
          trail.push({ p, life: -1 });
        }

        // 路径：三次贝塞尔（从右上外侧俯冲）
        const tangent = new THREE.Vector3(0, 1, 0).cross(normal).normalize();
        const start = target.clone().addScaledVector(normal, 2.35).addScaledVector(tangent, 1.15).add(new THREE.Vector3(0, 0.55, 0));
        const c1 = target.clone().addScaledVector(normal, 1.45).addScaledVector(tangent, 0.55).add(new THREE.Vector3(0, 0.35, 0));
        const c2 = target.clone().addScaledVector(normal, 0.85).addScaledVector(tangent, 0.12);
        const bez = (t) => {
          const it = 1 - t;
          return new THREE.Vector3()
            .addScaledVector(start, it * it * it)
            .addScaledVector(c1, 3 * it * it * t)
            .addScaledVector(c2, 3 * it * t * t)
            .addScaledVector(target, t * t * t);
        };

        // 溅落特效
        const flash = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTex, color: 0xffffff, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false
        }));
        flash.position.copy(target);
        globeGroup.add(flash);

        const ripples = [0, 1, 2].map(i => {
          const r = new THREE.Mesh(
            new THREE.RingGeometry(0.045, 0.058, 48),
            new THREE.MeshBasicMaterial({
              color: 0xbffff0, transparent: true, opacity: 0,
              blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false
            })
          );
          r.position.copy(target).multiplyScalar(1.005);
          r.lookAt(target.clone().multiplyScalar(2));
          globeGroup.add(r);
          return { mesh: r, delay: i * 240 };
        });

        // 气泡 Points
        const BUB = 60;
        const bubGeo = new THREE.BufferGeometry();
        const bubPos = new Float32Array(BUB * 3);
        const bubSeed = [];
        for (let i = 0; i < BUB; i++) {
          bubSeed.push({
            j: new THREE.Vector3().randomDirection().multiplyScalar(0.05),
            up: 0.18 + Math.random() * 0.4,
            delay: Math.random() * 600,
            lat2: (Math.random() - 0.5) * 0.6
          });
          bubPos.set([target.x, target.y, target.z], i * 3);
        }
        bubGeo.setAttribute('position', new THREE.BufferAttribute(bubPos, 3));
        const bubbles = new THREE.Points(bubGeo, new THREE.PointsMaterial({
          color: 0xd8fff2, size: 0.026, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
        }));
        globeGroup.add(bubbles);

        // 光柱
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.012, 0.06, 0.85, 20, 1, true),
          new THREE.MeshBasicMaterial({
            color: conf.glow, transparent: true, opacity: 0,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
          })
        );
        beam.position.copy(target).addScaledVector(normal, 0.42);
        beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
        globeGroup.add(beam);

        const DIVE = (Globe3D.GLOBE_ANIM && Globe3D.GLOBE_ANIM.DIVE_MS) || 1600;
        const RIPPLE = (Globe3D.GLOBE_ANIM && Globe3D.GLOBE_ANIM.RIPPLE_MS) || 2400;
        const t0 = performance.now();
        let resolved = false, lastTrail = 0;
        const camSave = camera.position.clone();
        // 兜底：即使渲染帧被节流（后台页签/低端机），回执也必须按时出现
        const guard = setTimeout(() => {
          if (!resolved) { resolved = true; resolve(); }
        }, DIVE + 900);

        animJobs.push(function (now) {
          const t = clamp((now - t0) / DIVE, 0, 1);
          // 前段缓出接近 + 末段加速俯冲
          const eased = easeInOut(t < 0.85 ? t / 0.85 * 0.8 : 0.8 + (t - 0.85) / 0.15 * 0.2);

          if (t < 1) {
            const pos = bez(eased);
            spirit.position.copy(pos);
            spiritGlow.position.copy(pos);
            spirit.lookAt(pos.clone().add(normal));
            const shrink = 1 - Math.max(0, (eased - 0.78)) * 4.2;
            const s = Math.max(0.08, shrink);
            spirit.scale.setScalar(s);
            spiritGlow.scale.setScalar(0.22 * s);
            sat1.position.set(0.06, 0, 0).applyAxisAngle(normal, now * 0.006);
            sat2.position.set(-0.06, 0, 0).applyAxisAngle(normal, -now * 0.005);
            // 拖尾
            if (now - lastTrail > 34) {
              lastTrail = now;
              const tp = trail.find(x => x.life < 0) || trail[0];
              tp.life = 1; tp.p.position.copy(pos);
            }
          } else {
            spirit.visible = spiritGlow.visible = false;
          }
          for (const tp of trail) {
            if (tp.life > 0) {
              tp.life -= 0.028;
              tp.p.material.opacity = Math.max(0, tp.life) * 0.55;
              tp.p.scale.setScalar(0.05 + (1 - tp.life) * 0.06);
            } else tp.p.material.opacity = 0;
          }

          // 相机随动（推近 + 回位）
          const ct = clamp((now - t0) / (DIVE + 500), 0, 1);
          if (ct < 1) {
            const push = Math.sin(clamp(ct * 1.25, 0, 1) * Math.PI) * 0.42;
            camera.position.copy(camSave).lerp(new THREE.Vector3(0, 0.1, 0), push * 0.35);
          } else {
            camera.position.copy(camSave);
          }

          // 溅落
          if (t >= 0.88) {
            const rt = now - t0 - DIVE * 0.88;
            const ft = clamp(rt / 260, 0, 1);
            flash.material.opacity = (1 - ft) * 0.9;
            flash.scale.setScalar(0.08 + ft * 0.42);
            for (const rp of ripples) {
              const lt = clamp((rt - rp.delay) / RIPPLE, 0, 1);
              rp.mesh.scale.setScalar(1 + lt * 6.5);
              rp.mesh.material.opacity = lt <= 0 ? 0 : 0.9 * (1 - lt);
            }
            const posAttr = bubGeo.attributes.position;
            for (let i = 0; i < BUB; i++) {
              const sd = bubSeed[i];
              const bt = clamp((rt - sd.delay) / 1500, 0, 1);
              if (bt <= 0) { posAttr.setXYZ(i, target.x, target.y, target.z); continue; }
              const p = target.clone().multiplyScalar(0.985)
                .add(sd.j.clone().multiplyScalar(0.4 + bt * 1.4))
                .addScaledVector(normal, bt * sd.up);
              posAttr.setXYZ(i, p.x, p.y, p.z);
            }
            posAttr.needsUpdate = true;
            bubbles.material.opacity = rt < 1500 ? 0.85 : Math.max(0, 0.85 - (rt - 1500) / 600);
            beam.material.opacity = Math.max(0, 0.55 * (1 - rt / 2000));
          }

          if (!resolved && now - t0 > DIVE + 500) {
            resolved = true;
            clearTimeout(guard);
            resolve();
          }
          if (now - t0 > DIVE + RIPPLE) {
            clearTimeout(guard);
            globeGroup.remove(spirit, spiritGlow, flash, bubbles, beam);
            trail.forEach(tp => globeGroup.remove(tp.p));
            ripples.forEach(rp => globeGroup.remove(rp.mesh));
            return false;
          }
          return true;
        });
      });
    };

    // ---------- 渲染循环 ----------
    const animJobs = [];
    let composer = null;
    if (hasBloom) {
      composer = new THREE.EffectComposer(renderer);
      composer.addPass(new THREE.RenderPass(scene, camera));
      const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.55, 0.74);
      composer.addPass(bloom);
    }

    let running = true;
    let lastFrame = performance.now();

    function resize() {
      const parent = canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth, h = parent.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      if (composer) composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    resize();
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(resize);
      ro.observe(canvas.parentElement || canvas);
    }
    window.addEventListener('resize', resize);

    function loop(now) {
      if (!running) return;
      requestAnimationFrame(loop);
      const dt = clamp(now - lastFrame, 0, 60);
      lastFrame = now;
      uniforms.uTime.value = now / 1000;

      if (focusTween) {
        const t = clamp((now - focusTween.t0) / focusTween.dur, 0, 1);
        const e = 1 - Math.pow(1 - t, 3);
        targetRotY = curRotY = focusTween.fromY + (focusTween.toY - focusTween.fromY) * e;
        targetRotX = curRotX = focusTween.fromX + (focusTween.toX - focusTween.fromX) * e;
        if (t >= 1) focusTween = null;
      } else if (!dragging) {
        const AUTO = (Globe3D.GLOBE_ANIM && Globe3D.GLOBE_ANIM.AUTO_ROTATE_SPEED) || 0.0004;
        targetRotY += AUTO * dt + velY;
        velY *= 0.94;
      }
      // 阻尼跟随
      if (!focusTween) {
        curRotY += (targetRotY - curRotY) * 0.14;
        curRotX += (targetRotX - curRotX) * 0.14;
      }
      globeGroup.rotation.y = curRotY;
      globeGroup.rotation.x = curRotX;
      clouds.rotation.y = now * 0.0000045;
      camera.lookAt(0, 0.05, 0);

      // 标记动效
      const camDir = camera.position.clone().normalize();
      for (const m of Object.values(markers)) {
        const facing = m.pos.clone().normalize().dot(camDir); // 未考虑 globeGroup 旋转
        const worldNormal = m.pos.clone().applyQuaternion(globeGroup.quaternion).normalize();
        const f = worldNormal.dot(camDir);
        const vis = clamp((f - 0.05) / 0.35, 0, 1);
        const pulse = 0.5 + 0.5 * Math.sin(now / 1000 * 2.2 + m.beamT);

        m.halo.scale.setScalar(0.09 + pulse * 0.035);
        m.halo.material.opacity = 0.5 + 0.3 * pulse;
        m.dot.scale.setScalar(m.selected ? 1.9 + pulse * 0.5 : 1);
        m.beam.material.opacity = (0.4 + 0.4 * pulse) * vis;
        const beamScale = m.selected ? 1.8 + pulse * 0.3 : 1;
        m.beam.scale.set(1, beamScale, 1);
        m.beam.position.copy(m.pos).addScaledVector(m.pos.clone().normalize(), 0.085 * beamScale);

        // 标签：选中常显加大，其余朝前渐隐
        const sel = m.selected;
        const wantTex = mk2label(m, sel);
        if (m.label.material.map !== wantTex.tex) {
          m.label.material.map = wantTex.tex;
          m.label.material.needsUpdate = true;
          const lw = sel ? 0.19 : 0.13;
          m.label.scale.set(lw, lw / wantTex.aspect, 1);
        }
        m.label.material.opacity = sel ? clamp(0.35 + vis * 0.75, 0, 1) : vis * 0.66;
        m.label.position.copy(m.pos).addScaledVector(m.pos.clone().normalize(), sel ? 0.135 : 0.115);

        // 选中脉冲环
        const pt = (now / 1000 * 1.1) % 1;
        m.rings[0].material.opacity = sel ? (1 - pt) * 0.9 : 0;
        m.rings[0].scale.setScalar(1 + pt * 2.2);
        m.rings[1].material.opacity = sel ? 0.35 + 0.25 * Math.sin(now / 1000 * 3) : 0;
        m.dot.visible = m.halo.visible = vis > 0.02;
      }

      // 选中涟漪生命周期
      for (let i = selectRipples.length - 1; i >= 0; i--) {
        const rp = selectRipples[i];
        const t = (now - rp.born) / rp.dur;
        if (t >= 1) {
          globeGroup.remove(rp.mesh);
          selectRipples.splice(i, 1);
        } else {
          rp.mesh.scale.setScalar(1 + t * 3.2);
          rp.mesh.material.opacity = 0.95 * (1 - t);
        }
      }

      // 世界光点
      for (let i = sparks.length - 1; i >= 0; i--) {
        const sp = sparks[i];
        const t = (now - sp.born) / sp.ttl;
        if (t >= 1) {
          globeGroup.remove(sp.s, sp.ring);
          sparks.splice(i, 1);
        } else {
          sp.s.material.opacity = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
          sp.s.scale.setScalar(0.06 + Math.sin(t * Math.PI) * 0.03);
          sp.ring.scale.setScalar(1 + t * 4.5);
          sp.ring.material.opacity = 0.85 * (1 - t);
        }
      }

      for (let i = animJobs.length - 1; i >= 0; i--) {
        if (animJobs[i](now) === false) animJobs.splice(i, 1);
      }

      if (composer) composer.render();
      else renderer.render(scene, camera);
    }
    requestAnimationFrame(loop);

    function mk2label(m, sel) { return m.labels[sel ? 'true' : 'false']; }

    // 调试/截图钩子：立即渲染一帧并导出（带 CSS 深海背景合成）
    Globe3D.snapshot = function () {
      renderer.render(scene, camera);
      const src = canvas;
      const out = document.createElement('canvas');
      out.width = src.width; out.height = src.height;
      const ctx = out.getContext('2d');
      const g = ctx.createRadialGradient(out.width * 0.5, out.height * 0.3, out.height * 0.1, out.width * 0.5, out.height * 0.4, out.height);
      g.addColorStop(0, '#123c44'); g.addColorStop(0.5, '#08222e'); g.addColorStop(1, '#041018');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(src, 0, 0);
      return out.toDataURL('image/jpeg', 0.92);
    };

    Globe3D.destroy = function () {
      running = false;
      window.removeEventListener('resize', resize);
      renderer.dispose();
    };

    G = { canvas };
    if (opts.onReady) opts.onReady();
    return true;
  };

  Globe3D.loadConfig = function (cfg) {
    Globe3D.WATERS_GEO = cfg.WATERS_GEO;
    Globe3D.CREATURE_3D = cfg.CREATURE_3D;
    Globe3D.GLOBE_ANIM = cfg.GLOBE_ANIM;
  };
  Globe3D.setWorldLand = function (wl) { Globe3D.WORLD_LAND = wl; };

  window.Globe3D = Globe3D;
})();
