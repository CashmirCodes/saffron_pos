// Animated WebGL gradient background for the auth screens.
//
// This is a vanilla JS/canvas port of the "Velaris" shader effect -- Saffron
// POS has no React/Next.js/Tailwind/shadcn toolchain (plain HTML/CSS/JS +
// Express, no build step), so rather than bolting on that whole stack for
// one background element, the same simplex-noise shader logic runs directly
// against a <canvas> here. Tinted to the app's amber/saffron theme, slowed
// down, and with grain turned down so it stays calm behind the login card.
(function () {
  const VERTEX_SRC = `
    attribute vec2 position;
    void main() {
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `;

  const FRAGMENT_SRC = `
    precision highp float;
    uniform vec2  u_resolution;
    uniform float u_time;
    uniform float u_grain;
    uniform vec3  u_colors[4];
    uniform vec3  u_bg;

    vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }

    float snoise(vec2 v) {
      const vec4 C = vec4(0.211324865405187, 0.366025403784439,
               -0.577350269189626, 0.024390243902439);
      vec2 i  = floor(v + dot(v, C.yy));
      vec2 x0 = v - i + dot(i, C.xx);
      vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = mod(i, 289.0);
      vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
        + i.x + vec3(0.0, i1.x, 1.0));
      vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
        dot(x12.zw, x12.zw)), 0.0);
      m = m * m;
      m = m * m;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
      vec3 g;
      g.x = a0.x * x0.x + h.x * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / u_resolution.xy;
      float ratio = u_resolution.x / u_resolution.y;
      vec2 p = uv - 0.5;
      p.x *= ratio;

      float t = u_time * 0.1;
      float n1 = snoise(p * 0.4 + vec2(t * 0.2, -t * 0.3));
      float n2 = snoise(p * 0.55 + vec2(-t * 0.15, t * 0.25) + n1 * 0.25);
      float n3 = snoise(p * 0.75 + vec2(t * 0.1, -t * 0.2) + n2 * 0.2);

      vec3 col = u_bg;
      float dist = length(p) * 1.5;
      float vignette = 1.0 - smoothstep(0.3, 1.2, dist);

      col = mix(col, u_colors[0], smoothstep(-0.2, 0.5, n1) * 0.85);
      col = mix(col, u_colors[1], smoothstep(-0.1, 0.6, n2) * 0.7);
      col = mix(col, u_colors[2], smoothstep(-0.3, 0.4, n3) * 0.6);
      col = mix(col, u_colors[3], smoothstep(0.0, 0.7, n1 * n2) * 0.5);

      float glow = smoothstep(0.8, 0.0, dist) * 0.3;
      col += u_colors[1] * glow;
      col = mix(col * 0.2, col, vignette);

      float grain = fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453 + u_time);
      col += (grain - 0.5) * u_grain * 0.1;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function hexToRgb(hex) {
    const h = hex.trim().replace('#', '');
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255
    ];
  }

  function compileShader(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('velaris-bg: shader compile error', gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  /**
   * Mounts the animated gradient onto `canvas`, sized to its parent element.
   * options: { bg, colors: [c0,c1,c2,c3], speed, grain }
   * Returns a cleanup function that stops the animation and releases observers.
   */
  function initVelarisBackground(canvas, options) {
    options = options || {};
    const bg = options.bg || '#000000';
    const colors = options.colors || ['#f7b733', '#ff7a52', '#d99400', '#241505'];
    const speed = options.speed !== undefined ? options.speed : 2.0;
    const grain = options.grain !== undefined ? options.grain : 0.3;

    const container = canvas.parentElement || canvas;
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return function noop() {};

    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC));
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const loc = {
      res: gl.getUniformLocation(program, 'u_resolution'),
      time: gl.getUniformLocation(program, 'u_time'),
      grain: gl.getUniformLocation(program, 'u_grain'),
      colors: gl.getUniformLocation(program, 'u_colors'),
      bg: gl.getUniformLocation(program, 'u_bg')
    };

    const bgRgb = hexToRgb(bg);
    const colorsFlat = new Float32Array(colors.slice(0, 4).flatMap(hexToRgb));

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();

    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(resize);
      ro.observe(container);
    } else {
      window.addEventListener('resize', resize);
    }

    const reduceMotion = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = null;
    function frame(t) {
      gl.uniform2f(loc.res, canvas.width, canvas.height);
      gl.uniform1f(loc.time, t * 0.001 * speed);
      gl.uniform1f(loc.grain, grain);
      gl.uniform3f(loc.bg, bgRgb[0], bgRgb[1], bgRgb[2]);
      gl.uniform3fv(loc.colors, colorsFlat);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(frame);
    }

    if (reduceMotion) {
      frame(0); // draw a single still frame, then stop
    } else {
      raf = requestAnimationFrame(frame);
    }

    return function cleanup() {
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      else window.removeEventListener('resize', resize);
    };
  }

  window.initVelarisBackground = initVelarisBackground;
})();
