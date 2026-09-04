/* ============================================================
 * Globe3D —— 赛博放生 3D 地球模块（网页版）
 * 依赖：全局 THREE（three.min.js）
 * 对外接口：
 *   Globe3D.init({ canvas, onSelect, onReady, size }) -> bool（false 表示需回落 2D）
 *   Globe3D.focusWater(waterId)
 *   Globe3D.setMarkersState(selectedId, disabled)
 *   Globe3D.playRelease({ creature, water }) -> Promise  // 动画完成 resolve
 *   Globe3D.addSpark({ lat, lng, color })               // 世界共时光点
 *   Globe3D.destroy()
 * 配置来自 /globe-config.json（与小程序共享，见 scripts/sync-globe-config.js）
 * ============================================================ */
(function () {
  const Globe3D = { destroy: function () {} };
  let G = null; // 内部实例

  // 大陆轮廓（与 2D 地图同源的简化 path，SVG 640x480 坐标）
  const CONTINENT_PATHS = [
    'M 50 70 Q 90 50 150 65 Q 190 80 195 120 Q 185 160 160 180 Q 120 195 85 180 Q 55 160 45 120 Q 40 90 50 70 Z',
    'M 130 230 Q 165 220 185 250 Q 195 290 185 330 Q 170 370 150 365 Q 125 340 120 300 Q 120 260 130 230 Z',
    'M 200 40 Q 230 30 250 45 Q 255 65 240 75 Q 215 75 200 60 Z',
    'M 260 75 Q 330 55 420 70 Q 500 85 545 120 Q 555 155 530 180 Q 480 195 420 190 Q 360 185 310 170 Q 270 155 255 125 Q 250 95 260 75 Z',
    'M 285 95 Q 300 88 308 100 Q 305 115 292 113 Q 283 105 285 95 Z',
    'M 540 130 Q 555 125 560 140 Q 555 155 545 150 Q 538 140 540 130 Z',
    'M 335 210 Q 370 200 395 225 Q 405 265 395 305 Q 380 340 360 340 Q 335 325 325 290 Q 320 250 335 210 Z',
    'M 500 220 Q 520 215 530 230 Q 525 245 510 243 Q 498 235 500 220 Z',
    'M 495 335 Q 535 325 560 345 Q 565 375 545 390 Q 515 392 498 378 Q 488 355 495 335 Z'
  ];

  // 经纬度 -> THREE.Vector3
  function latLngToV3(lat, lng, r) {
    const phi = (90 - lat) * Math.PI / 180;
    const theta = (lng + 180) * Math.PI / 180;
    return new THREE.Vector3(
      -r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta)
    );
  }

  // 生成等距圆柱投影贴图（海洋渐变 + 大陆 + 极淡经纬网格）
  function makeEarthTexture() {
    const W = 2048, H = 1024;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#8fc3b5');
    grad.addColorStop(0.5, '#a9d2c5');
    grad.addColorStop(1, '#7fb6a4');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 细微洋流噪声
    for (let i = 0; i < 2400; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.02 + Math.random() * 0.03})`;
      const x = Math.random() * W, y = Math.random() * H;
      ctx.beginPath();
      ctx.ellipse(x, y, 8 + Math.random() * 30, 2 + Math.random() * 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 大陆：SVG 640x480 线性映射到等距圆柱
    ctx.fillStyle = '#f0e6d0';
    ctx.strokeStyle = '#d6cdb8';
    ctx.lineWidth = 1.5;
    const sx = W / 640, sy = H / 480;
    for (const d of CONTINENT_PATHS) {
      const p = new Path2D();
      const m = new DOMMatrix().scaleSelf(sx, sy);
      p.addPath(new Path2D(d), m);
      ctx.fill(p);
      ctx.stroke(p);
    }

    // 极地
    ctx.fillStyle = 'rgba(240,246,244,0.85)';
    ctx.fillRect(0, 0, W, H * 0.06);
    ctx.fillRect(0, H * 0.94, W, H * 0.06);

    const tex = new THREE.CanvasTexture(c);
    return tex;
  }

  Globe3D.init = function (opts) {
    if (typeof THREE === 'undefined' || !opts || !opts.canvas) return false;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, alpha: true });
    } catch (e) {
      return false;
    }
    Globe3D.destroy();

    const canvas = opts.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0, 3.4);

    const globeGroup = new THREE.Group();
    scene.add(globeGroup);

    // —— 地球本体 ——
    const R = 1.15;
    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(R, 64, 64),
      new THREE.MeshStandardMaterial({ map: makeEarthTexture(), roughness: 0.9, metalness: 0.05 })
    );
    globeGroup.add(earth);

    // 生物发光边缘光（内菲涅尔壳）
    const rim = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.02, 64, 64),
      new THREE.ShaderMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        uniforms: { uColor: { value: new THREE.Color(0x9be0cd) } },
        vertexShader: `
          varying float vI;
          void main() {
            vec3 n = normalize(normalMatrix * normal);
            vec3 vPos = normalize((modelViewMatrix * vec4(position, 1.0)).xyz);
            vI = pow(1.0 - abs(dot(n, vPos)), 2.5);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 uColor;
          varying float vI;
          void main() { gl_FragColor = vec4(uColor, vI * 0.9); }`
      })
    );
    globeGroup.add(rim);

    // 外层大气辉光
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.16, 48, 48),
      new THREE.ShaderMaterial({
        transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide,
        uniforms: { uColor: { value: new THREE.Color(0x7fd8c0) } },
        vertexShader: `
          varying float vI;
          void main() {
            vec3 n = normalize(normalMatrix * normal);
            vI = pow(0.72 - dot(n, normalize(vec3(0,0,1))), 3.0);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 uColor; varying float vI;
          void main() { gl_FragColor = vec4(uColor, clamp(vI,0.,1.) * 0.55); }`
      })
    );
    scene.add(halo);

    scene.add(new THREE.AmbientLight(0xdff3ec, 0.75));
    const sun = new THREE.DirectionalLight(0xfff6e0, 1.0);
    sun.position.set(4, 2.5, 3);
    scene.add(sun);

    // —— 水域标记 ——
    const TYPE_COLOR = { ocean: 0x2c8a7a, lake: 0x2c8a7a, river: 0x2c8a7a, trench: 0xed7d5b };
    const markers = {};
    const markerRoot = new THREE.Group();
    globeGroup.add(markerRoot);

    for (const [id, w] of Object.entries(Globe3D.WATERS_GEO || {})) {
      const pos = latLngToV3(w.lat, w.lng, R * 1.005);
      const color = TYPE_COLOR[w.type] || 0x2c8a7a;

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.028, 16, 16),
        new THREE.MeshBasicMaterial({ color })
      );
      dot.position.copy(pos);
      dot.userData.waterId = id;

      // 命中半径（不可见的大球，方便点选）
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(0.085, 8, 8),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      hit.position.copy(pos);
      hit.userData.waterId = id;

      // 选中脉冲环（始终面向球面法线）
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.04, 0.055, 32),
        new THREE.MeshBasicMaterial({ color: 0xed7d5b, transparent: true, opacity: 0, side: THREE.DoubleSide })
      );
      ring.position.copy(pos).multiplyScalar(1.01);
      ring.lookAt(pos.clone().multiplyScalar(2));
      ring.userData.pulse = true;

      markerRoot.add(dot, hit, ring);
      markers[id] = { dot, hit, ring, pos, base: pos.clone() };
    }

    // —— 世界共时光点池 ——
    const sparks = [];
    function addSpark(spark) {
      const geo = new THREE.SphereGeometry(0.022, 10, 10);
      const mat = new THREE.MeshBasicMaterial({ color: spark.color || 0xffd970, transparent: true, opacity: 1 });
      const s = new THREE.Mesh(geo, mat);
      s.position.copy(latLngToV3(spark.lat, spark.lng, R * 1.01));
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.02, 0.03, 24),
        new THREE.MeshBasicMaterial({ color: spark.color || 0xffd970, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
      );
      ring.position.copy(s.position);
      ring.lookAt(s.position.clone().multiplyScalar(2));
      globeGroup.add(s, ring);
      sparks.push({ s, ring, born: performance.now(), ttl: 4200 });
    }
    Globe3D.addSpark = addSpark;

    // —— 交互：拖拽旋转 + 惯性 ——
    let targetRotY = 0.6, targetRotX = 0.28;
    let curRotY = targetRotY, curRotX = targetRotX;
    let velY = 0;
    let dragging = false, moved = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
    const raycaster = new THREE.Raycaster();
    const pointerNDC = new THREE.Vector2();
    let focusTween = null;

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
      targetRotX = Math.max(-1.1, Math.min(1.1, targetRotX + dy * 0.003));
      velY = dx * 0.005;
      lastX = e.clientX; lastY = e.clientY;
    }
    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      if (!moved) {
        // 点击 -> 射线拾取水域
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

    // 双指缩放
    let pinchStart = 0, camStartZ = 3.4;
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinchStart = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        camStartZ = camera.position.z;
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinchStart > 0) {
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        camera.position.z = Math.max(2.2, Math.min(5.5, camStartZ * pinchStart / d));
      }
    }, { passive: true });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      camera.position.z = Math.max(2.2, Math.min(5.5, camera.position.z + e.deltaY * 0.002));
    }, { passive: false });

    // 选水域 -> 球体平滑转向对准
    Globe3D.focusWater = function (waterId) {
      const w = (Globe3D.WATERS_GEO || {})[waterId];
      if (!w) return;
      const targetY = -((w.lng + 180) * Math.PI / 180) + Math.PI / 2;
      const targetX = (w.lat * Math.PI / 180) * 0.9;
      // 取与当前旋转最近的等价角，避免绕远路
      let ty = targetY;
      while (ty - curRotY > Math.PI) ty -= Math.PI * 2;
      while (ty - curRotY < -Math.PI) ty += Math.PI * 2;
      focusTween = { fromY: curRotY, toY: ty, fromX: curRotX, toX: targetX, t0: performance.now(), dur: Globe3D.GLOBE_ANIM ? Globe3D.GLOBE_ANIM.FOCUS_MS : 900 };
      // 选中标记高亮
      for (const [id, m] of Object.entries(markers)) {
        m.selected = (id === waterId);
      }
    };

    Globe3D.setMarkersState = function (selectedId) {
      for (const [id, m] of Object.entries(markers)) m.selected = (id === selectedId);
    };

    // —— 放生俯冲动画 ——
    Globe3D.playRelease = function (playOpts) {
      return new Promise((resolve) => {
        const conf = (Globe3D.CREATURE_3D || {})[playOpts.creature] || { color: 0xed7d5b, glow: 0xffb38a };
        const w = (Globe3D.WATERS_GEO || {})[playOpts.water] || { lat: 0, lng: -160 };
        const target = latLngToV3(w.lat, w.lng, R);
        const normal = target.clone().normalize();

        // 风格化生物：发光水滴形
        const body = new THREE.Mesh(
          new THREE.SphereGeometry(0.06, 20, 20),
          new THREE.MeshStandardMaterial({
            color: conf.color, emissive: conf.glow, emissiveIntensity: 0.8,
            roughness: 0.35, metalness: 0.1
          })
        );
        body.scale.set(1, 0.65, 1.5);
        const start = target.clone()
          .add(normal.clone().multiplyScalar(1.8))
          .add(new THREE.Vector3(0.9, 0.7, 0));
        const ctrl = target.clone()
          .add(normal.clone().multiplyScalar(1.15))
          .add(new THREE.Vector3(0.35, 0.25, 0));
        globeGroup.add(body);

        // 入水涟漪环 x3
        const ripples = [0, 1, 2].map(i => {
          const r = new THREE.Mesh(
            new THREE.RingGeometry(0.05, 0.062, 40),
            new THREE.MeshBasicMaterial({ color: 0xdff3ec, transparent: true, opacity: 0, side: THREE.DoubleSide })
          );
          r.position.copy(target).multiplyScalar(1.004);
          r.lookAt(target.clone().multiplyScalar(2));
          globeGroup.add(r);
          return { mesh: r, delay: i * 260 };
        });

        // 气泡
        const bubbleGeo = new THREE.SphereGeometry(0.012, 8, 8);
        const bubbles = [];
        for (let i = 0; i < (Globe3D.GLOBE_ANIM ? Globe3D.GLOBE_ANIM.BUBBLE_COUNT : 40); i++) {
          const b = new THREE.Mesh(bubbleGeo,
            new THREE.MeshBasicMaterial({ color: 0xeafaf4, transparent: true, opacity: 0 }));
          const jitter = new THREE.Vector3(
            (Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.25);
          b.userData = { jitter, rise: 0.3 + Math.random() * 0.5, delay: Math.random() * 500 };
          b.position.copy(target).multiplyScalar(0.985).add(jitter.clone().multiplyScalar(0.3));
          globeGroup.add(b);
          bubbles.push(b);
        }

        // 光柱
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.015, 0.05, 0.7, 16, 1, true),
          new THREE.MeshBasicMaterial({ color: conf.glow, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
        );
        beam.position.copy(target).add(normal.clone().multiplyScalar(0.35));
        beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
        globeGroup.add(beam);

        const DIVE = Globe3D.GLOBE_ANIM ? Globe3D.GLOBE_ANIM.DIVE_MS : 1600;
        const RIPPLE = Globe3D.GLOBE_ANIM ? Globe3D.GLOBE_ANIM.RIPPLE_MS : 2400;
        const t0 = performance.now();
        let resolved = false;
        const bez = (a, c, b, t) => {
          const it = 1 - t;
          return new THREE.Vector3()
            .addScaledVector(a, it * it)
            .addScaledVector(c, 2 * it * t)
            .addScaledVector(b, t * t);
        };
        animJobs.push(function (now) {
          const t = Math.min(1, (now - t0) / DIVE);
          const eased = t * t * (3 - 2 * t);
          // 前段弧线俯冲，后段沉入球内
          if (t < 1) {
            body.position.copy(bez(start, ctrl, target, eased));
            body.lookAt(target);
            const shrink = 1 - Math.max(0, (eased - 0.75)) * 4;
            body.scale.set(Math.max(0.05, shrink), Math.max(0.05, shrink * 0.65), Math.max(0.05, shrink * 1.5));
          } else {
            body.visible = false;
          }

          // 入水瞬间（t 接近 1）触发涟漪/气泡/光柱
          if (t >= 0.92) {
            const rt = (now - t0 - DIVE * 0.92);
            for (const rp of ripples) {
              const lt = Math.min(1, Math.max(0, (rt - rp.delay) / RIPPLE));
              rp.mesh.scale.setScalar(1 + lt * 5.5);
              rp.mesh.material.opacity = lt <= 0 ? 0 : 0.85 * (1 - lt);
            }
            for (const b of bubbles) {
              const bt = Math.min(1, Math.max(0, (rt - b.userData.delay) / 1400));
              if (bt <= 0) { b.material.opacity = 0; continue; }
              b.material.opacity = 0.7 * (1 - bt);
              b.position.copy(target).multiplyScalar(0.985)
                .add(b.userData.jitter.clone().multiplyScalar(0.3 + bt * 0.8))
                .add(normal.clone().multiplyScalar(bt * b.userData.rise));
            }
            beam.material.opacity = Math.max(0, 0.6 * (1 - rt / 1800));
          }

          if (!resolved && now - t0 > DIVE + 500) {
            resolved = true;
            resolve(); // 回执先出，涟漪余韵继续
          }
          if (now - t0 > DIVE + RIPPLE) {
            globeGroup.remove(body, beam);
            ripples.forEach(r => globeGroup.remove(r.mesh));
            bubbles.forEach(b => globeGroup.remove(b));
            resolve();
            return false; // 移除本 job
          }
          return true;
        });
      });
    };

    // —— 渲染循环 ——
    const animJobs = [];
    let running = true;
    let lastFrame = performance.now();

    function resize() {
      const parent = canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth, h = parent.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    resize();
    window.addEventListener('resize', resize);

    document.addEventListener('visibilitychange', onVis);
    function onVis() { /* 页签隐藏时 rAF 自动暂停，无需额外处理 */ }

    function loop(now) {
      if (!running) return;
      requestAnimationFrame(loop);
      const dt = Math.min(50, now - lastFrame);
      lastFrame = now;

      if (focusTween) {
        const t = Math.min(1, (now - focusTween.t0) / focusTween.dur);
        const e = 1 - Math.pow(1 - t, 3);
        targetRotY = curRotY = focusTween.fromY + (focusTween.toY - focusTween.fromY) * e;
        targetRotX = curRotX = focusTween.fromX + (focusTween.toX - focusTween.fromX) * e;
        if (t >= 1) focusTween = null;
      } else if (!dragging) {
        targetRotY += (Globe3D.GLOBE_ANIM ? Globe3D.GLOBE_ANIM.AUTO_ROTATE_SPEED : 0.0004) * dt;
        targetRotY += velY; velY *= 0.94; // 惯性衰减
      }

      globeGroup.rotation.y = curRotY;
      globeGroup.rotation.x = curRotX;

      // 标记脉冲
      const tt = now / 1000;
      for (const m of Object.values(markers)) {
        if (m.selected) {
          m.ring.material.opacity = 0.5 + 0.4 * Math.sin(tt * 4);
          m.ring.scale.setScalar(1.2 + 0.5 * (0.5 + 0.5 * Math.sin(tt * 4)));
          m.dot.scale.setScalar(1.6);
        } else {
          m.ring.material.opacity = 0.18 + 0.12 * Math.sin(tt * 1.6 + m.pos.x * 8);
          m.ring.scale.setScalar(1);
          m.dot.scale.setScalar(1);
        }
      }

      // 世界光点生命周期
      for (let i = sparks.length - 1; i >= 0; i--) {
        const sp = sparks[i];
        const t = (now - sp.born) / sp.ttl;
        if (t >= 1) {
          globeGroup.remove(sp.s, sp.ring);
          sparks.splice(i, 1);
        } else {
          sp.s.material.opacity = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
          sp.ring.scale.setScalar(1 + t * 4);
          sp.ring.material.opacity = 0.8 * (1 - t);
        }
      }

      for (let i = animJobs.length - 1; i >= 0; i--) {
        if (animJobs[i](now) === false) animJobs.splice(i, 1);
      }

      renderer.render(scene, camera);
    }
    requestAnimationFrame(loop);

    Globe3D.destroy = function () {
      running = false;
      window.removeEventListener('resize', resize);
      renderer.dispose();
      if (G === this) G = null;
    };

    G = { canvas };
    if (opts.onReady) opts.onReady();
    return true;
  };

  // 配置加载（同步注入或 fetch globe-config.json）
  Globe3D.loadConfig = function (cfg) {
    Globe3D.WATERS_GEO = cfg.WATERS_GEO;
    Globe3D.CREATURE_3D = cfg.CREATURE_3D;
    Globe3D.GLOBE_ANIM = cfg.GLOBE_ANIM;
  };

  window.Globe3D = Globe3D;
})();
