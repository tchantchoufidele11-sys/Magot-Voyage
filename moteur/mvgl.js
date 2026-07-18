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
    "void main(){",
    "  vec4 c;",
    "  if(uBlur > 0.0){",
    "    vec4 s = vec4(0.0); float w = 0.0;",
    "    for(int i=-4;i<=4;i++){ for(int j=-4;j<=4;j++){",
    "      vec2 o = vec2(float(i), float(j)) * uTexel * uBlur;",
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
    "  gl_FragColor = vec4(c.rgb, c.a * uAlpha);",
    "}"
  ].join("\n");

  var gl = null, prog = null, canvas = null;
  var bufPos = null, bufUV = null, loc = {};
  var ready = false;

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
  function mat4Multiply(a, b) {
    var o = new Float32Array(16);
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) {
        o[i*4+j] = a[i*4]*b[j] + a[i*4+1]*b[4+j] + a[i*4+2]*b[8+j] + a[i*4+3]*b[12+j];
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
  function mat4RotateX(a) {
    var c = Math.cos(a), s = Math.sin(a), m = mat4Identity();
    m[5]=c; m[6]=s; m[9]=-s; m[10]=c; return m;
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
        ["uMVP","uTex","uAlpha","uBright","uContrast","uSat","uTint","uTintAmt","uVignette","uBlur","uTexel","uGray"]
          .forEach(function (n) { loc[n] = gl.getUniformLocation(prog, n); });

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        ready = true;
        return true;
      } catch (e) { ready = false; return false; }
    },

    available: function () { return !!ready; },

    /* Crée une texture depuis une image, une vidéo ou un canvas. */
    texture: function (src) {
      if (!ready || !src) return null;
      try {
        var t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        t._w = src.videoWidth || src.width || 1;
        t._h = src.videoHeight || src.height || 1;
        return t;
      } catch (e) { return null; }
    },

    /* Rafraîchit une texture (utile pour la vidéo, image par image). */
    update: function (t, src) {
      if (!ready || !t || !src) return;
      try {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
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

      /* Cadrage : on respecte les proportions de la photo. */
      var car = W / H, ar = (tex._w || 1) / (tex._h || 1);
      var sx = 1, sy = 1;
      if ((o.mode || "fit") === "fill") {
        if (ar > car) { sx = ar / car; } else { sy = car / ar; }
      } else {
        if (ar > car) { sy = car / ar; } else { sx = ar / car; }
      }
      var zoom = o.zoom || 1;
      sx *= zoom; sy *= zoom;

      /* Perspective : indispensable pour que la 3D ait de la profondeur. */
      var proj = mat4Perspective(Math.PI / 4, car, 0.1, 100);
      var dist = 1 / Math.tan(Math.PI / 8);
      var m = mat4Scale(sx, sy, 1);
      if (o.rotY) m = mat4Multiply(mat4RotateY(o.rotY), m);
      if (o.rotX) m = mat4Multiply(mat4RotateX(o.rotX), m);
      m = mat4Multiply(mat4Translate(o.offX || 0, o.offY || 0, -dist + (o.z || 0)), m);
      var mvp = mat4Multiply(proj, m);

      gl.bindBuffer(gl.ARRAY_BUFFER, bufPos);
      gl.enableVertexAttribArray(loc.aPos);
      gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufUV);
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
        /* Cube qui tourne : deux faces perpendiculaires. */
        var a = e * PI / 2;
        if (from) API.draw(from, opts({ rotY: -a, offX: -Math.sin(a) * 0.9, z: -Math.abs(Math.sin(a)) * 0.5 }));
        if (to)   API.draw(to,   opts({ rotY: PI / 2 - a, offX: Math.cos(a) * 0.9, z: -Math.abs(Math.cos(a)) * 0.5 }));
        return;
      }
      if (kind === "flip3d") {
        /* Carte qui se retourne. */
        var b = e * PI;
        if (e < 0.5) { if (from) API.draw(from, opts({ rotY: b })); }
        else { if (to) API.draw(to, opts({ rotY: b - PI })); }
        return;
      }
      if (kind === "carousel3d") {
        /* Carrousel : la photo s'éloigne sur le côté, la suivante arrive. */
        if (from) API.draw(from, opts({ rotY: -e * 0.9, offX: -e * 1.6, z: -e * 1.2, alpha: 1 - e * 0.4 }));
        if (to)   API.draw(to,   opts({ rotY: (1 - e) * 0.9, offX: (1 - e) * 1.6, z: -(1 - e) * 1.2, alpha: 0.6 + e * 0.4 }));
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

    kinds: ["cube3d", "flip3d", "carousel3d", "zoomThrough3d", "fade"]
  };

  root.MVGL = API;
})(typeof window !== "undefined" ? window : this);
