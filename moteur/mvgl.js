/* ============================================================
   Magot Voyage — moteur de rendu WebGL (mvgl.js)
   Autonome, sans dépendance. Chargé à la demande depuis le dépôt.
   Si WebGL n'est pas disponible : MVGL.init() renvoie false
   et l'application garde son moteur 2D. Aucun bouton mort.
   ============================================================ */
(function (root) {
  "use strict";

  var VS = [
    "attribute vec2 aPos;",
    "attribute vec2 aUV;",
    "uniform mat4 uMVP;",
    "varying vec2 vUV;",
    "void main(){ vUV = aUV; gl_Position = uMVP * vec4(aPos, 0.0, 1.0); }"
  ].join("\n");

  /* Fragment : image + réglages (luminosité, contraste, saturation, teinte,
     vignettage, voile lumineux) — tout ce que le moteur 2D faisait à la main. */
  var FS = [
    "precision mediump float;",
    "varying vec2 vUV;",
    "uniform sampler2D uTex;",
    "uniform float uAlpha;",
    "uniform float uBright;",
    "uniform float uContrast;",
    "uniform float uSat;",
    "uniform vec3  uTint;",
    "uniform float uTintAmt;",
    "uniform float uVignette;",
    "uniform float uBlur;",      /* rayon de flou (0 = net) */
    "uniform vec2  uTexel;",
    "uniform float uGray;",
    "uniform sampler2D uMask;",
    "uniform int uMaskMode;",   /* 0 = tout, 1 = la personne seulement, 2 = le fond seulement */
    "uniform vec2 uFadeY;",     /* estompage vertical : garde l'overlay dans le ciel */
    "uniform int uFadeOn;",
    "void main(){",
    "  vec4 c;",
    "  if(uBlur > 0.0){",
    "    vec4 s = vec4(0.0); float w = 0.0;",
    "    for(int i=-2;i<=2;i++){ for(int j=-2;j<=2;j++){",
    "      vec2 o = vec2(float(i), float(j)) * uTexel * uBlur * 2.5;",
    "      s += texture2D(uTex, vUV + o); w += 1.0; } }",
    "    c = s / w;",
    "  } else { c = texture2D(uTex, vUV); }",
    "  c.rgb = (c.rgb - 0.5) * uContrast + 0.5;",       /* contraste */
    "  c.rgb *= uBright;",                               /* luminosité */
    "  float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));",
    "  c.rgb = mix(vec3(l), c.rgb, uSat);",              /* saturation */
    "  c.rgb = mix(c.rgb, vec3(l), uGray);",             /* noir & blanc */
    "  c.rgb = mix(c.rgb, uTint, uTintAmt);",            /* étalonnage */
    "  float d = distance(vUV, vec2(0.5));",
    "  c.rgb *= 1.0 - uVignette * smoothstep(0.35, 0.85, d);",
    "  float mk = 1.0;",
    "  if(uMaskMode == 1){ mk = texture2D(uMask, vUV).r; mk = smoothstep(0.35, 0.65, mk); }",
    "  else if(uMaskMode == 2){ mk = 1.0 - smoothstep(0.35, 0.65, texture2D(uMask, vUV).r); }",
    "  if(uFadeOn == 1){ mk *= 1.0 - smoothstep(uFadeY.x, uFadeY.y, vUV.y); }",
    "  gl_FragColor = vec4(c.rgb, c.a * uAlpha * mk);",
    "}"
  ].join("\n");


  /* ============================================================
     PASSE D'EFFETS SUR GPU
     La scène est dessinée dans une mémoire graphique (framebuffer),
     puis retraitée en une seule passe par ce nuanceur : c'est ce qui
     permettra à terme de supprimer la recopie image par image.
     ============================================================ */
  var FS_POST = [
    "precision mediump float;",
    "varying vec2 vUV;",
    "uniform sampler2D uTex;",
    "uniform vec2 uTexel;",
    "uniform float uAmt;",
    "uniform float uTime;",
    "uniform float uDrop;",
    "uniform int uFx;",
    "uniform float uVig;",
    "uniform float uAsp;",     /* largeur/hauteur : garde les particules RONDES */
    "uniform vec3 uTint;",
    "uniform float uTintAmt;",
    "uniform float uGrain;",
    "uniform float uSepia;",
    "uniform float uSat2;",
    "uniform float uCon2;",
    "uniform float uBri2;",
    "uniform vec3 uShadow;",   /* teinte des ombres */
    "uniform vec3 uHigh;",     /* teinte des lumières */
    "uniform float uSplit;",   /* dosage du split-toning (signature Magot) */
    "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
    "vec3 blurAt(vec2 uv, float r){",
    "  vec3 s = vec3(0.0);",
    "  for(int i=-2;i<=2;i++){ for(int j=-2;j<=2;j++){",
    "    s += texture2D(uTex, uv + vec2(float(i), float(j)) * uTexel * r).rgb; } }",
    "  return s / 25.0; }",
    /* Une couche de particules rondes. "soft" = flou de mise au point :
       plus il est grand, plus le flocon est diffus (comme au premier plan
       d'une vraie prise de vue). */
    "float flakes(vec2 uv, float cells, float speed, float size, float seed, float dir, float soft){",
    "  vec2 st = uv * vec2(cells * uAsp, cells);",
    "  st.y -= uTime * speed * dir;",
    "  float best = 0.0;",
    "  for(int oy=-1; oy<=1; oy++){ for(int ox=-1; ox<=1; ox++){",
    "    vec2 id = floor(st) + vec2(float(ox), float(oy));",
    "    float h = hash(id + seed);",
    "    if(h > 0.42){",
    "      float sway = sin(uTime * 0.9 + h * 25.0) * 0.32;",
    "      vec2 c = id + vec2(0.5 + sway, 0.5 + hash(id + seed + 3.0) * 0.4 - 0.2);",
    "      float d = distance(st, c);",
    "      float r = size * (0.55 + h * 0.9);",
    "      float v = smoothstep(r, r * soft, d);",
    "      best = max(best, v); } } }",
    "  return best; }",
    "void main(){",
    "  vec4 c;",
    "  if(uBlur > 0.0){",
    "    vec4 s = vec4(0.0); float w = 0.0;",
    "    for(int i=-2;i<=2;i++){ for(int j=-2;j<=2;j++){",
    "      vec2 o = vec2(float(i), float(j)) * uTexel * uBlur * 2.5;",
    "      s += texture2D(uTex, vUV + o); w += 1.0; } }",
    "    c = s / w;",
    "  } else { c = texture2D(uTex, vUV); }",
    "  c.rgb = (c.rgb - 0.5) * uContrast + 0.5;",       /* contraste */
    "  c.rgb *= uBright;",                               /* luminosité */
    "  float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));",
    "  c.rgb = mix(vec3(l), c.rgb, uSat);",              /* saturation */
    "  c.rgb = mix(c.rgb, vec3(l), uGray);",             /* noir & blanc */
    "  c.rgb = mix(c.rgb, uTint, uTintAmt);",            /* étalonnage */
    "  float d = distance(vUV, vec2(0.5));",
    "  c.rgb *= 1.0 - uVignette * smoothstep(0.35, 0.85, d);",
    "  float mk = 1.0;",
    "  if(uMaskMode == 1){ mk = texture2D(uMask, vUV).r; mk = smoothstep(0.35, 0.65, mk); }",
    "  else if(uMaskMode == 2){ mk = 1.0 - smoothstep(0.35, 0.65, texture2D(uMask, vUV).r); }",
    "  if(uFadeOn == 1){ mk *= 1.0 - smoothstep(uFadeY.x, uFadeY.y, vUV.y); }",
    "  gl_FragColor = vec4(c.rgb, c.a * uAlpha * mk);",
    "}"
  ].join("\n");


  /* ============================================================
     PASSE D'EFFETS SUR GPU
     La scène est dessinée dans une mémoire graphique (framebuffer),
     puis retraitée en une seule passe par ce nuanceur : c'est ce qui
     permettra à terme de supprimer la recopie image par image.
     ============================================================ */
  var FS_POST = [
    "precision mediump float;",
    "varying vec2 vUV;",
    "uniform sampler2D uTex;",
    "uniform vec2 uTexel;",
    "uniform float uAmt;",
    "uniform float uTime;",
    "uniform float uDrop;",
    "uniform int uFx;",
    "uniform float uVig;",
    "uniform float uAsp;",     /* largeur/hauteur : garde les particules RONDES */
    "uniform vec3 uTint;",
    "uniform float uTintAmt;",
    "uniform float uGrain;",
    "uniform float uSepia;",
    "uniform float uSat2;",
    "uniform float uCon2;",
    "uniform float uBri2;",
    "uniform vec3 uShadow;",   /* teinte des ombres */
    "uniform vec3 uHigh;",     /* teinte des lumières */
    "uniform float uSplit;",   /* dosage du split-toning (signature Magot) */
    "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
    "vec3 blurAt(vec2 uv, float r){",
    "  vec3 s = vec3(0.0);",
    "  for(int i=-2;i<=2;i++){ for(int j=-2;j<=2;j++){",
    "    s += texture2D(uTex, uv + vec2(float(i), float(j)) * uTexel * r).rgb; } }",
    "  return s / 25.0; }",
    /* Une couche de flocons ronds : cellules carrées, chute, balancement latéral. */
    "float flakes(vec2 uv, float cells, float speed, float size, float seed, float dir){",
    "  vec2 st = uv * vec2(cells * uAsp, cells);",
    "  st.y -= uTime * speed * dir;",
    "  vec2 id = floor(st); vec2 f = fract(st);",
    "  float h = hash(id + seed);",
    "  if(h < 0.62) return 0.0;",
    "  float sway = sin(uTime * 1.1 + h * 25.0) * 0.30;",
    "  vec2 c = vec2(0.5 + sway, 0.5);",
    "  float d = distance(f, c);",
    "  float r = size * (0.45 + h * 0.75);",
    "  return smoothstep(r, r * 0.15, d); }",
    "void main(){",
    "  vec2 uv = vUV;",
    "  vec3 c = texture2D(uTex, uv).rgb;",
    "  float lum = dot(c, vec3(0.299, 0.587, 0.114));",
    /* --- Lumière --- */
    "  if(uFx == 1){ vec3 b = blurAt(uv, 7.0);",
    "    vec3 hi = max(b - 0.55, 0.0);",
    "    c += hi * 0.85; }",                                                    /* Éclat doux : seulement les hautes lumières */
    "  else if(uFx == 2){ vec3 b = blurAt(uv, 6.0);",
    "    c = mix(c, b, 0.42); c = (c - 0.5) * 1.10 + 0.5;",
    "    c += max(b - 0.60, 0.0) * 0.45; }",                                    /* Flou de rêve : doux mais pas mou */
    "  else if(uFx == 3){ float h = 1.0 - uv.y;",
    "    c += vec3(0.20, 0.19, 0.17) * h * h * 0.9; }",                         /* Brume : monte du bas */
    "  else if(uFx == 4){ float d = distance(uv, vec2(0.5, 0.42));",
    "    c += vec3(0.34, 0.29, 0.18) * pow(1.0 - smoothstep(0.0, 0.80, d), 2.0); }", /* Halo */
    "  else if(uFx == 5){ float a = uv.x * 0.8 + uv.y * 0.5 + sin(uTime * 0.45) * 0.10;",
    "    float b1 = smoothstep(0.62, 1.05, a);",
    "    float b2 = smoothstep(0.30, 0.02, a) * 0.6;",
    "    c += vec3(1.0, 0.62, 0.24) * b1 * 0.75;",
    "    c += vec3(0.35, 0.55, 1.0) * b2 * 0.30; }",                            /* Fuite de lumière : chaude d'un côté, froide de l'autre */
    "  else if(uFx == 6){ vec2 fp = vec2(0.28 + sin(uTime * 0.4) * 0.04, 0.26);",
    "    vec2 dv = (uv - fp) * vec2(uAsp, 1.0); float d = length(dv);",
    "    c += vec3(1.0, 0.88, 0.62) * pow(1.0 - smoothstep(0.0, 0.50, d), 2.0) * 0.95;",
    "    float st = max(0.0, 1.0 - abs(dv.y) * 34.0);",
    "    c += vec3(1.0, 0.90, 0.70) * st * 0.30;",
    "    float ring = 1.0 - smoothstep(0.02, 0.05, abs(d - 0.34));",
    "    c += vec3(0.9, 0.75, 0.45) * ring * 0.18; }",                          /* Lens flare : halo + traînée + anneau */
    "  else if(uFx == 7){ float sp = 0.0;",
    "    for(int L=0;L<3;L++){ float fl = float(L);",
    "      vec2 st = uv * vec2(30.0 * uAsp + fl * 12.0, 30.0 + fl * 12.0);",
    "      vec2 id = floor(st); vec2 f = fract(st);",
    "      float h = hash(id + fl * 7.3);",
    "      if(h > 0.955){",
    "        float tw = 0.5 + 0.5 * sin(uTime * 4.0 + h * 40.0);",
    "        vec2 q = (f - 0.5) * vec2(uAsp, 1.0);",
    "        float star = max(0.0, 1.0 - abs(q.x) * 26.0) + max(0.0, 1.0 - abs(q.y) * 26.0);",
    "        star *= 1.0 - smoothstep(0.0, 0.42, length(q));",
    "        sp += star * tw; } }",
    "    c += vec3(1.0, 0.96, 0.85) * sp * 0.9 * (0.35 + lum); }",              /* Scintillement : petites étoiles qui pulsent */
    "  else if(uFx == 8){ float bk = 0.0;",
    "    for(int L=0;L<2;L++){ float fl = float(L);",
    "      float cells = 9.0 + fl * 6.0;",
    "      vec2 st = uv * vec2(cells * uAsp, cells) + vec2(uTime * (0.03 + fl * 0.02), 0.0);",
    "      vec2 id = floor(st); vec2 f = fract(st);",
    "      float h = hash(id + fl * 3.1);",
    "      if(h > 0.80){",
    "        float d = distance(f, vec2(0.5));",
    "        float r = 0.20 + h * 0.22;",
    "        bk += (1.0 - smoothstep(r * 0.55, r, d)) * (0.35 + h * 0.5); } }",
    "    c += vec3(1.0, 0.94, 0.80) * bk * 0.42 * smoothstep(0.35, 0.9, lum); }", /* Bokeh : disques doux sur les lumières */
    /* --- Rétro & écran --- */
    "  else if(uFx == 9){ float jit = (hash(vec2(floor(uTime * 12.0), 1.0)) - 0.5) * 0.004;",
    "    float r = texture2D(uTex, uv + vec2(0.0030 + jit, 0.0)).r;",
    "    float b = texture2D(uTex, uv - vec2(0.0030 + jit, 0.0)).b;",
    "    c = vec3(r, c.g, b);",
    "    c += sin(uv.y * 800.0) * 0.05;",
    "    c += (hash(uv * 500.0 + uTime) - 0.5) * 0.07;",
    "    float band = smoothstep(0.06, 0.0, abs(fract(uv.y - uTime * 0.12) - 0.5));",
    "    c += band * 0.06; }",                                                  /* VHS : décalage couleur, bruit, bande qui défile */
    "  else if(uFx == 10){ c = mix(c, vec3(lum), 0.35);",
    "    c -= step(0.5, fract(uv.y * 260.0)) * 0.13;",
    "    float roll = smoothstep(0.05, 0.0, abs(fract(uv.y - uTime * 0.25) - 0.5));",
    "    c += roll * 0.10;",
    "    c += (hash(uv * 700.0 + uTime * 2.0) - 0.5) * 0.06;",
    "    float d = distance(uv, vec2(0.5));",
    "    c *= 1.0 - smoothstep(0.30, 0.95, d) * 0.70; }",                       /* Vieille TV */
    "  else if(uFx == 11){ c *= vec3(1.06, 1.0, 0.90);",
    "    c -= step(0.5, fract(uv.y * 200.0)) * 0.05;",
    "    c += (hash(uv * 900.0 + uTime) - 0.5) * 0.08;",
    "    float d = distance(uv, vec2(0.5));",
    "    c *= 1.0 - smoothstep(0.45, 1.0, d) * 0.45; }",                        /* Camescope */
    "  else if(uFx == 12){ c = vec3(lum); c = (c - 0.5) * 1.25 + 0.48;",
    "    c += (hash(uv * 600.0) - 0.5) * 0.03; }",                              /* Noir & blanc contrasté */
    "  else if(uFx == 13){ float b = smoothstep(0.55, 1.0, uAmt);",
    "    float edge = smoothstep(0.55, 1.0, uv.x * 0.6 + (1.0 - uv.y) * 0.7);",
    "    float n = hash(uv * 26.0 + floor(uTime * 10.0));",
    "    float burn = b * edge * (0.55 + n * 0.75);",
    "    c += vec3(1.0, 0.42, 0.08) * burn;",
    "    c = mix(c, vec3(1.0, 0.92, 0.75), clamp(burn - 0.75, 0.0, 1.0)); }",   /* Film burn : part d'un coin */
    /* --- Particules --- */
    "  else if(uFx == 14){ float p = 0.0; float g2 = 0.0;",
    "    g2 += flakes(uv, 3.5, 0.045, 0.62, 1.0, -1.0, 0.02) * 0.30;",
    "    p  += flakes(uv, 8.0, 0.060, 0.30, 5.0, -1.0, 0.25) * 0.75;",
    "    p  += flakes(uv, 15.0, 0.045, 0.16, 9.0, -1.0, 0.45) * 0.60;",
    "    p  += flakes(uv, 26.0, 0.030, 0.10, 13.0, -1.0, 0.60) * 0.40;",
    "    float tw = 0.65 + 0.35 * sin(uTime * 2.5 + uv.x * 24.0);",
    "    c += vec3(1.0, 0.80, 0.30) * (p * tw + g2) * 1.35; }",
    "  else if(uFx == 15){ float p = 0.0; float g2 = 0.0;",
    "    g2 += flakes(uv, 2.6, 0.10, 0.75, 2.0, 1.0, 0.02) * 0.34;",
    "    g2 += flakes(uv, 4.5, 0.13, 0.50, 4.0, 1.0, 0.05) * 0.42;",
    "    p  += flakes(uv, 8.0, 0.16, 0.30, 6.0, 1.0, 0.28) * 0.85;",
    "    p  += flakes(uv, 14.0, 0.12, 0.18, 11.0, 1.0, 0.50) * 0.65;",
    "    p  += flakes(uv, 24.0, 0.08, 0.11, 17.0, 1.0, 0.65) * 0.45;",
    "    c += vec3(1.0) * (p + g2) * 1.45; }",
    /* ---- Étalonnage (ambiance) : contraste, saturation, luminosité, sépia ---- */
    "  c = (c - 0.5) * uCon2 + 0.5;",
    "  c *= uBri2;",
    "  float l2 = dot(c, vec3(0.299, 0.587, 0.114));",
    "  c = mix(vec3(l2), c, uSat2);",
    "  if(uSepia > 0.0){ vec3 sp = vec3(dot(c, vec3(0.393,0.769,0.189)), dot(c, vec3(0.349,0.686,0.168)), dot(c, vec3(0.272,0.534,0.131)));",
    "    c = mix(c, sp, uSepia); }",
    "  if(uSplit > 0.0){",
    "    float lm = dot(c, vec3(0.299, 0.587, 0.114));",
    "    c = mix(c, uShadow, pow(1.0 - lm, 2.0) * uSplit);",
    "    c = mix(c, uHigh, pow(lm, 1.6) * uSplit * 0.85); }",
    "  c = mix(c, uTint, uTintAmt);",
    "  if(uGrain > 0.0){ float gn = hash(uv * 850.0 + uTime * 3.0) - 0.5; c += gn * uGrain; }",
    "  float dv = distance(uv, vec2(0.5));",
    "  c *= 1.0 - uVig * smoothstep(0.35, 0.9, dv);",
    "  gl_FragColor = vec4(c, 1.0);",
    "}"
  ].join("\n");

  /* Correspondance nom d'effet -> numéro dans le nuanceur */
  var FX_ID = { softGlow:1, dreamBlur:2, haze:3, glow:4, leak:5, flare:6, sparkle:7, bokeh:8,
                vhs:9, oldtv:10, camcorder:11, bw:12, burn:13, dustGold:14, snow:15 };

  var gl = null, prog = null, canvas = null;
  var bufPos = null, bufUV = null, loc = {};
  var ready = false;
  var progPost = null, locP = {}, fbo = null, fboTex = null, fboW = 0, fboH = 0, inScene = false;

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error("shader: " + gl.getShaderInfoLog(s));
    }
    return s;
  }

  /* ---- Matrices (perspective + transformations) ---------------- */
  function mat4Identity() {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  }
  /* a * b, en colonnes (convention WebGL). L'ordre compte : P * T * R * S. */
  function mat4Multiply(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        o[c*4+r] = a[0*4+r]*b[c*4+0] + a[1*4+r]*b[c*4+1]
                 + a[2*4+r]*b[c*4+2] + a[3*4+r]*b[c*4+3];
      }
    }
    return o;
  }
  function mat4Perspective(fovy, aspect, near, far) {
    var f = 1.0 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([
      f/aspect,0,0,0,  0,f,0,0,
      0,0,(far+near)*nf,-1,  0,0,2*far*near*nf,0
    ]);
  }
  function mat4Translate(x, y, z) {
    var m = mat4Identity(); m[12]=x; m[13]=y; m[14]=z; return m;
  }
  function mat4Scale(x, y, z) {
    var m = mat4Identity(); m[0]=x; m[5]=y; m[10]=z; return m;
  }
  function mat4RotateY(a) {
    var c = Math.cos(a), s = Math.sin(a), m = mat4Identity();
    m[0]=c; m[2]=-s; m[8]=s; m[10]=c; return m;
  }
  function mat4RotateZ(a) {
    var c = Math.cos(a), s = Math.sin(a), m = mat4Identity();
    m[0]=c; m[1]=s; m[4]=-s; m[5]=c; return m;
  }
  function mat4RotateX(a) {
    var c = Math.cos(a), s = Math.sin(a), m = mat4Identity();
    m[5]=c; m[6]=s; m[9]=-s; m[10]=c; return m;
  }

  /* Les photos d'iPhone dépassent souvent la taille maximale d'une texture.
     On réduit d'abord, sinon la texture échoue en silence (écran noir). */
  function fitSize(src) {
    var w = src.videoWidth || src.width || 0, h = src.videoHeight || src.height || 0;
    var max = 2048;
    try { var mx = gl.getParameter(gl.MAX_TEXTURE_SIZE); if (mx && mx < max) max = mx; } catch (e) {}
    if (!w || !h || (w <= max && h <= max)) return src;
    var s = Math.min(max / w, max / h);
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    var x = c.getContext("2d");
    x.imageSmoothingEnabled = true;
    x.drawImage(src, 0, 0, c.width, c.height);
    c._srcW = w; c._srcH = h;
    return c;
  }

  /* Demi-largeur / demi-hauteur RÉELLES de la photo à l'écran.
     Indispensable pour les cubes : sans ça, les arêtes ne se rejoignent pas. */
  function extents(tex, o) {
    o = o || {};
    var car = canvas.width / canvas.height, ar = (tex && tex._w ? tex._w : 1) / (tex && tex._h ? tex._h : 1);
    var sx, sy;
    if ((o.mode || "fit") === "fill") {
      if (ar > car) { sy = 1; sx = ar; } else { sx = car; sy = car / ar; }
    } else {
      if (ar > car) { sx = car; sy = car / ar; } else { sy = 1; sx = ar; }
    }
    var z = o.zoom || 1;
    return { sx: sx * z, sy: sy * z };
  }

  var API = {
    /* Prépare le moteur. Renvoie false si WebGL indisponible → repli 2D. */
    init: function (cv) {
      try {
        canvas = cv;
        gl = cv.getContext("webgl", { alpha: false, antialias: true, preserveDrawingBuffer: true })
          || cv.getContext("experimental-webgl", { alpha: false, antialias: true, preserveDrawingBuffer: true });
        if (!gl) return false;
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
        gl.useProgram(prog);

        bufPos = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
        bufUV = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, bufUV);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,1, 1,1, 0,0, 1,0]), gl.STATIC_DRAW);

        loc.aPos = gl.getAttribLocation(prog, "aPos");
        loc.aUV = gl.getAttribLocation(prog, "aUV");
        ["uMVP","uTex","uAlpha","uBright","uContrast","uSat","uTint","uTintAmt","uVignette","uBlur","uTexel","uGray","uMask","uMaskMode","uFadeY","uFadeOn"]
          .forEach(function (n) { loc[n] = gl.getUniformLocation(prog, n); });

        /* Second programme : la passe d'effets. */
        progPost = gl.createProgram();
        gl.attachShader(progPost, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(progPost, compile(gl.FRAGMENT_SHADER, FS_POST));
        gl.linkProgram(progPost);
        if (!gl.getProgramParameter(progPost, gl.LINK_STATUS)) progPost = null;
        if (progPost) {
          locP.aPos = gl.getAttribLocation(progPost, "aPos");
          locP.aUV = gl.getAttribLocation(progPost, "aUV");
          ["uMVP","uTex","uTexel","uAmt","uTime","uDrop","uFx","uVig","uAsp","uTint","uTintAmt","uGrain","uSepia","uSat2","uCon2","uBri2","uShadow","uHigh","uSplit"]
            .forEach(function (n) { locP[n] = gl.getUniformLocation(progPost, n); });
        }

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        ready = true;
        return true;
      } catch (e) { ready = false; return false; }
    },

    available: function () { return !!ready; },

    /* La passe d'effets est-elle utilisable ? */
    canFx: function (name) { return !!(ready && progPost && (!name || FX_ID[name])); },
    fxList: function () { var a = []; for (var k in FX_ID) if (FX_ID.hasOwnProperty(k)) a.push(k); return a; },

    /* Ouvre une scène : tout ce qui suit est dessiné en mémoire graphique. */
    beginScene: function () {
      if (!ready || !progPost) return false;
      try {
        var W = canvas.width, H = canvas.height;
        if (!fbo || fboW !== W || fboH !== H) {
          if (fboTex) gl.deleteTexture(fboTex);
          if (fbo) gl.deleteFramebuffer(fbo);
          fboTex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, fboTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          fbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null); fbo = null; return false;
          }
          fboW = W; fboH = H;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, W, H);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        inScene = true;
        return true;
      } catch (e) { try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch (e2) {} inScene = false; return false; }
    },

    /* Referme la scène en appliquant l'effet demandé, puis dessine à l'écran. */
    endScene: function (fx, o) {
      if (!inScene) return false;
      o = o || {};
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        inScene = false;
        var W = canvas.width, H = canvas.height;
        gl.viewport(0, 0, W, H);
        gl.useProgram(progPost);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(locP.aPos);
        gl.vertexAttribPointer(locP.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufUV);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(locP.aUV);
        gl.vertexAttribPointer(locP.aUV, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fboTex);
        gl.uniform1i(locP.uTex, 0);
        gl.uniformMatrix4fv(locP.uMVP, false, mat4Identity());
        gl.uniform2f(locP.uTexel, 1 / W, 1 / H);
        gl.uniform1f(locP.uAmt, o.amt || 0);
        gl.uniform1f(locP.uTime, o.time || 0);
        gl.uniform1f(locP.uDrop, o.drop ? 1 : 0);
        gl.uniform1i(locP.uFx, FX_ID[fx] || 0);
        gl.uniform1f(locP.uVig, o.vignette == null ? 0 : o.vignette);
        gl.uniform1f(locP.uAsp, W / H);
        gl.uniform3fv(locP.uTint, o.tint || [1, 1, 1]);
        gl.uniform1f(locP.uTintAmt, o.tintAmt || 0);
        gl.uniform1f(locP.uGrain, o.grain || 0);
        gl.uniform1f(locP.uSepia, o.sepia || 0);
        gl.uniform1f(locP.uSat2, o.sat == null ? 1 : o.sat);
        gl.uniform1f(locP.uCon2, o.contrast == null ? 1 : o.contrast);
        gl.uniform1f(locP.uBri2, o.bright == null ? 1 : o.bright);
        gl.uniform3fv(locP.uShadow, o.shadow || [0, 0, 0]);
        gl.uniform3fv(locP.uHigh, o.high || [1, 1, 1]);
        gl.uniform1f(locP.uSplit, o.split || 0);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return true;
      } catch (e) { try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch (e2) {} inScene = false; return false; }
    },

    /* Crée une texture depuis une image, une vidéo ou un canvas. */
    texture: function (src) {
      if (!ready || !src) return null;
      try {
        var img = fitSize(src);
        var t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   /* les UV gèrent déjà le sens : un seul retournement */
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        t._w = img.videoWidth || img.width || 1;
        t._h = img.videoHeight || img.height || 1;
        t._err = gl.getError();
        return t;
      } catch (e) { return null; }
    },

    /* Rafraîchit une texture (utile pour la vidéo, image par image). */
    update: function (t, src) {
      if (!ready || !t || !src) return;
      try {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   /* les UV gèrent déjà le sens : un seul retournement */
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      } catch (e) {}
    },

    free: function (t) { try { if (t) gl.deleteTexture(t); } catch (e) {} },

    /* Efface l'écran. */
    clear: function (r, g2, b) {
      if (!ready) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(r || 0, g2 || 0, b || 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },

    /* Dessine une texture.
       o = { mode:"fit"|"fill", zoom, cx, cy, alpha, blur, gray,
             bright, contrast, sat, tint:[r,g,b], tintAmt, vignette,
             rotY, rotX, z, offX, offY, additive } */
    draw: function (tex, o) {
      if (!ready || !tex) return;
      o = o || {};
      var W = canvas.width, H = canvas.height;
      gl.viewport(0, 0, W, H);
      gl.useProgram(prog);

      /* Cadrage : dans ce repère, la largeur de l'écran vaut "car" et la hauteur vaut 1. */
      var ex = extents(tex, o);
      var sx = ex.sx, sy = ex.sy, car = W / H;

      /* Perspective : indispensable pour que la 3D ait de la profondeur. */
      var proj = mat4Perspective(Math.PI / 4, car, 0.1, 100);
      var dist = 1 / Math.tan(Math.PI / 8);
      var m = mat4Scale(sx, sy, 1);
      if (o.rotZ) m = mat4Multiply(mat4RotateZ(o.rotZ), m);
      if (o.rotY) m = mat4Multiply(mat4RotateY(o.rotY), m);
      if (o.rotX) m = mat4Multiply(mat4RotateX(o.rotX), m);
      m = mat4Multiply(mat4Translate(o.offX || 0, o.offY || 0, -dist + (o.z || 0)), m);
      var mvp = mat4Multiply(proj, m);

      gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
      /* o.slice = [x0, x1] (0 à 1) : ne dessine qu'une tranche verticale de la photo.
         Sert aux effets à panneaux (portes, volets). */
      if (o.slice) {
        var a0 = o.slice[0], a1 = o.slice[1];
        var px0 = -1 + 2 * a0, px1 = -1 + 2 * a1;
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([px0,-1, px1,-1, px0,1, px1,1]), gl.DYNAMIC_DRAW);
      } else {
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.DYNAMIC_DRAW);
      }
      gl.enableVertexAttribArray(loc.aPos);
      gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufUV);
      if (o.slice) {
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([o.slice[0],1, o.slice[1],1, o.slice[0],0, o.slice[1],0]), gl.DYNAMIC_DRAW);
      } else {
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,1, 1,1, 0,0, 1,0]), gl.DYNAMIC_DRAW);
      }
      gl.enableVertexAttribArray(loc.aUV);
      gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc.uTex, 0);
      gl.uniformMatrix4fv(loc.uMVP, false, mvp);
      gl.uniform1f(loc.uAlpha, o.alpha == null ? 1 : o.alpha);
      gl.uniform1f(loc.uBright, o.bright == null ? 1 : o.bright);
      gl.uniform1f(loc.uContrast, o.contrast == null ? 1 : o.contrast);
      gl.uniform1f(loc.uSat, o.sat == null ? 1 : o.sat);
      gl.uniform1f(loc.uGray, o.gray || 0);
      /* Masque de personne : permet de faire passer un overlay DERRIÈRE les gens. */
      if (o.mask) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, o.mask);
        gl.uniform1i(loc.uMask, 1); gl.uniform1i(loc.uMaskMode, o.maskMode || 1); gl.activeTexture(gl.TEXTURE0); }
      else { gl.uniform1i(loc.uMaskMode, 0); }
      if (o.fadeY) { gl.uniform1i(loc.uFadeOn, 1); gl.uniform2f(loc.uFadeY, o.fadeY[0], o.fadeY[1]); }
      else { gl.uniform1i(loc.uFadeOn, 0); }
      gl.uniform3fv(loc.uTint, o.tint || [1, 1, 1]);
      gl.uniform1f(loc.uTintAmt, o.tintAmt || 0);
      gl.uniform1f(loc.uVignette, o.vignette || 0);
      gl.uniform1f(loc.uBlur, o.blur || 0);
      gl.uniform2f(loc.uTexel, 1 / (tex._w || 1), 1 / (tex._h || 1));

      /* "additive" = mode écran, pour les overlays lumineux. */
      if (o.additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },

    /* Fond flouté et assombri (photo entière, comme le moteur 2D). */
    background: function (tex, o) {
      o = o || {};
      API.draw(tex, {
        mode: "fill", zoom: 1.5, blur: o.blur == null ? 3.5 : o.blur,
        bright: o.bright == null ? 0.55 : o.bright, alpha: 1
      });
    },

    /* ---- VRAIES transitions 3D ------------------------------------
       k va de 0 à 1. from/to sont des textures. */
    transition: function (kind, from, to, k, base) {
      if (!ready) return;
      base = base || {};
      var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;  /* adouci */
      var PI = Math.PI;
      function opts(extra) {
        var o = {};
        for (var key in base) if (base.hasOwnProperty(key)) o[key] = base[key];
        for (var k2 in extra) if (extra.hasOwnProperty(k2)) o[k2] = extra[k2];
        return o;
      }

      if (kind === "cube3d") {
        /* Vrai cube : les deux faces sont perpendiculaires et tournent
           autour de l'axe central du cube (et non chacune sur elle-même). */
        var hw = extents(from || to, base).sx;   /* demi-largeur RÉELLE : les arêtes se rejoignent */
        var th = e * PI / 2;
        var fO = { rotY: th,          offX: Math.sin(th) * hw,  z: Math.cos(th) * hw - hw };
        var tO = { rotY: th - PI / 2, offX: -Math.cos(th) * hw, z: Math.sin(th) * hw - hw };
        /* On dessine la face la plus éloignée en premier (sinon elle passe devant). */
        if (fO.z <= tO.z) { if (from) API.draw(from, opts(fO)); if (to) API.draw(to, opts(tO)); }
        else { if (to) API.draw(to, opts(tO)); if (from) API.draw(from, opts(fO)); }
        return;
      }
      if (kind === "flip3d") {
        /* Carte qui se retourne sur elle-même. */
        var b = e * PI;
        if (e < 0.5) { if (from) API.draw(from, opts({ rotY: b })); }
        else { if (to) API.draw(to, opts({ rotY: b - PI })); }
        return;
      }
      if (kind === "carousel3d") {
        /* Carrousel : la photo part sur le côté en s'éloignant,
           la suivante arrive de l'autre côté. Les deux restent visibles. */
        if (from) API.draw(from, opts({ rotY: -e * 1.1, offX: -e * 2.2, z: -e * 2.0, alpha: 1 - e * 0.35 }));
        if (to)   API.draw(to,   opts({ rotY: (1 - e) * 1.1, offX: (1 - e) * 2.2, z: -(1 - e) * 2.0, alpha: 0.65 + e * 0.35 }));
        return;
      }
      if (kind === "cubeX3d") {
        /* Cube vertical : la photo bascule vers le haut. */
        var hh = extents(from || to, base).sy;   /* demi-hauteur RÉELLE : les coins se rejoignent */
        var tx = e * PI / 2;
        var fV = { rotX: -tx,          offY: Math.sin(tx) * hh,  z: Math.cos(tx) * hh - hh };
        var tV = { rotX: PI / 2 - tx,  offY: -Math.cos(tx) * hh, z: Math.sin(tx) * hh - hh };
        if (fV.z <= tV.z) { if (from) API.draw(from, opts(fV)); if (to) API.draw(to, opts(tV)); }
        else { if (to) API.draw(to, opts(tV)); if (from) API.draw(from, opts(fV)); }
        return;
      }
      if (kind === "door3d") {
        /* Portes : la photo s'ouvre en deux panneaux qui pivotent sur les
           bords extérieurs, la suivante apparaît derrière. */
        var hwd = extents(from || to, base).sx;
        var ang = e * (PI / 2) * 0.95, cA = Math.cos(ang), sA = Math.sin(ang);
        if (to) API.draw(to, opts({ zoom: (base.zoom || 1) * (0.93 + 0.07 * e) }));
        if (from) {
          API.draw(from, opts({ slice: [0, 0.5], rotY: -ang, offX: hwd * (cA - 1), z: sA * hwd }));
          API.draw(from, opts({ slice: [0.5, 1], rotY: ang,  offX: hwd * (1 - cA), z: sA * hwd }));
        }
        return;
      }
      if (kind === "carnet3d") {
        /* ✦ Signature Magot Voyage — « Carnet de voyage » :
           la photo se soulève comme la page d'un carnet, pivot sur le bord
           gauche. La photo suivante attend dessous, comme la page d'après. */
        var hwp = extents(from || to, base).sx;
        var pg = Math.pow(k, 1.9) * (PI / 2) * 0.98;   /* la page se lève lentement, puis bascule */
        var cP = Math.cos(pg), sP = Math.sin(pg);
        if (to) API.draw(to, opts({}));
        if (from) API.draw(from, opts({
          rotY: -pg, offX: hwp * (cP - 1), z: sP * hwp,
          bright: 1 - 0.25 * Math.pow(k, 1.9)   /* la page s'assombrit en se levant */
        }));
        return;
      }
      if (kind === "boussole3d") {
        /* ✦ Signature Magot Voyage — « Boussole » :
           la photo arrive en pivotant sur deux axes et se stabilise
           avec un léger dépassement, comme une aiguille qui se pose. */
        var s = 1 - Math.pow(1 - k, 3);
        var over = Math.sin(k * PI * 1.5) * Math.pow(1 - k, 2) * 0.09;   /* léger dépassement, vite amorti */
        if (from) API.draw(from, opts({ zoom: (base.zoom || 1) * (1 - 0.10 * s), alpha: 1 - s, rotY: -s * 0.35 }));
        if (to) API.draw(to, opts({
          rotY: (1 - s) * 0.9 + over, rotX: (1 - s) * 0.35 - over * 0.5,
          z: -(1 - s) * 1.1, alpha: s, zoom: (base.zoom || 1) * (1.06 - 0.06 * s)
        }));
        return;
      }
      if (kind === "reminiscence3d") {
        /* ✦ Signature Magot Voyage — « Réminiscence » :
           la photo se voile, s'éclaircit et s'éloigne comme un souvenir qui
           s'estompe ; la suivante émerge du flou dans un halo doré (la couleur
           de la marque) qui se dissipe en arrivant à la netteté. */
        var r = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        if (from) API.draw(from, opts({
          blur: r * 4.5, bright: 1 + 0.18 * r, sat: 1 - 0.35 * r,
          z: -0.40 * r, zoom: (base.zoom || 1) * (1 + 0.05 * r), alpha: 1 - r
        }));
        if (to) API.draw(to, opts({
          blur: (1 - r) * 4.0, zoom: (base.zoom || 1) * (1.10 - 0.10 * r),
          alpha: r, tint: [0.79, 0.64, 0.15], tintAmt: (1 - r) * 0.30,
          bright: 1 + 0.10 * (1 - r)
        }));
        return;
      }
      if (kind === "depart3d") {
        /* ✦ Signature Magot Voyage — « Tableau des départs » :
           la photo est découpée en lames verticales qui basculent l'une après
           l'autre, comme les volets d'un panneau d'affichage de gare ou
           d'aéroport. Chaque lame révèle la photo suivante en se retournant. */
        var N = 7, sg = 0.55 / (N - 1), win = 0.40;   /* cascade plus posée, et toutes les lames finissent avant la fin */
        for (var i = 0; i < N; i++) {
          var p = (k - i * sg) / win;
          p = p < 0 ? 0 : (p > 1 ? 1 : p);
          var sl = [i / N, (i + 1) / N];
          var dim = 1 - 0.40 * Math.sin(p * PI);   /* la lame s'assombrit sur la tranche */
          if (p < 0.5) {
            if (from) API.draw(from, opts({ slice: sl, rotX: -p * PI, bright: dim }));
          } else {
            if (to) API.draw(to, opts({ slice: sl, rotX: (p - 1) * PI, bright: dim }));
          }
        }
        return;
      }
      if (kind === "zoomThrough3d") {
        /* On traverse la photo pour arriver dans la suivante. */
        if (from) API.draw(from, opts({ zoom: 1 + e * 1.6, alpha: 1 - e }));
        if (to)   API.draw(to,   opts({ zoom: 0.6 + e * 0.4, alpha: e }));
        return;
      }
      /* Par défaut : fondu enchaîné. */
      if (from) API.draw(from, opts({ alpha: 1 - e }));
      if (to)   API.draw(to,   opts({ alpha: e }));
    },

    version: "2.6",
    kinds: ["cube3d", "cubeX3d", "flip3d", "carousel3d", "door3d", "zoomThrough3d", "carnet3d", "boussole3d", "reminiscence3d", "depart3d", "fade"],
    labels: { cube3d:"Cube", cubeX3d:"Cube vertical", flip3d:"Retournement", carousel3d:"Carrousel", door3d:"Portes", zoomThrough3d:"Traversée", carnet3d:"\u2726 Carnet de voyage", boussole3d:"\u2726 Boussole", reminiscence3d:"\u2726 Réminiscence", depart3d:"\u2726 Tableau des départs", fade:"Fondu" }
  };

  root.MVGL = API;
})(typeof window !== "undefined" ? window : this);
