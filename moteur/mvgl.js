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

    version: "1.7",
    kinds: ["cube3d", "cubeX3d", "flip3d", "carousel3d", "door3d", "zoomThrough3d", "carnet3d", "boussole3d", "reminiscence3d", "depart3d", "fade"],
    labels: { cube3d:"Cube", cubeX3d:"Cube vertical", flip3d:"Retournement", carousel3d:"Carrousel", door3d:"Portes", zoomThrough3d:"Traversée", carnet3d:"\u2726 Carnet de voyage", boussole3d:"\u2726 Boussole", reminiscence3d:"\u2726 Réminiscence", depart3d:"\u2726 Tableau des départs", fade:"Fondu" }
  };

  root.MVGL = API;
})(typeof window !== "undefined" ? window : this);
