/**
 * Magot Voyage — Cloudflare Worker (backend Phase A)
 * -------------------------------------------------
 * Rôle :
 *   1. Proxy des appels Google REST (la clé reste côté serveur, jamais dans l'app)
 *   2. Routes agent IA (Mistral) qui INTERPRÈTENT nos chiffres, sans rien inventer
 *   3. Quotas par utilisateur comptés dans Supabase (anti-abus, contrôle des coûts)
 *
 * Secrets à définir côté Cloudflare (jamais dans ce fichier) :
 *   MISTRAL_API_KEY, GOOGLE_MAPS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
 * Variables non secrètes (wrangler.toml [vars]) :
 *   MISTRAL_MODEL (def. "mistral-small-latest"), ALLOWED_ORIGIN (ton domaine GitHub Pages)
 *
 * Voir SETUP.md pour le déploiement, le SQL Supabase et l'intégration côté app.
 */

// ---------------------------------------------------------------------------
// Caractère de l'agent (source unique de vérité, identique au prompt testé)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Tu es le compagnon de voyage de Magot Voyage. Tu accompagnes la personne du début à la fin de son séjour.

CARACTÈRE
- Franc, honnête, véridique. Tu dis les choses telles qu'elles sont, même quand c'est décevant.
- Chaleureux, humain, un brin poète : voix vivante, images simples, bienveillance.
- L'honnêteté passe AVANT la poésie. On n'enrobe jamais un mensonge dans une jolie phrase.
- Tu conseilles, tu n'imposes jamais : « je te conseille », « je suggère », « à toi de voir ».
- Concis, pensé pour un écran de téléphone : la reco d'abord, puis 2–3 raisons, puis le choix laissé à la personne.

RÈGLES ABSOLUES (non négociables)
1. Tu n'inventes JAMAIS un chiffre. Prix, distances, durées, péages, carburant, notes : ils viennent TOUJOURS des données fournies. Tu n'es pas une calculatrice, tu interprètes des chiffres déjà calculés.
2. Tu n'inventes JAMAIS un avis, une note, un horaire, une disponibilité ou un lieu. Tu ne travailles qu'avec les avis et notes réels transmis, même peu nombreux.
3. Quand une donnée manque ou est incertaine, tu le DIS clairement (ex. « péage à confirmer », « peu d'avis disponibles »).
4. Tu ne promets rien que tu ne peux garantir. Pas de « tu vas adorer », plutôt « c'est très bien noté sur le service ».
5. Tu n'es pas un humain. Si on te le demande, tu le dis simplement.

LANGUE : réponds toujours dans la langue de la personne (français par défaut, tutoiement). Aussi : anglais, espagnol, italien, allemand.`;

// Tâches par route (préambule court ajouté au message utilisateur)
const TASK = {
  trajet: "Tâche : conseil trajet. Compare la route rapide et la route sans péage, arbitre temps gagné vs argent gagné, recommande sans imposer. Si le péage est inconnu, dis « montant à confirmer », ne donne jamais un faux prix.",
  resto: "Tâche : synthèse honnête d'un restaurant à partir des notes et des quelques avis réels fournis. Ne gonfle pas, ne généralise pas au-delà de l'échantillon ; si peu d'avis, précise-le.",
  jour: "Tâche : conseil du jour. À partir de la météo, du planning prévu et du budget restant, adapte sans imposer (déplacer une activité extérieure, alternative couverte, quoi emporter, impact budget)."
};

// Limites quotidiennes par utilisateur et par service
const LIMITS = {
  agent: 40,          // appels IA / jour / utilisateur
  google_places: 100, // recherches de lieux / jour / utilisateur
  google_routes: 5    // appels Routes (péage premium) / jour / utilisateur
};

// ---------------------------------------------------------------------------
// Utilitaires HTTP / CORS
// ---------------------------------------------------------------------------
function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400"
  };
}
function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) }
  });
}
function getUser(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.replace(/^Bearer\s+/i, "").trim() || "anonymous";
}

// ---------------------------------------------------------------------------
// Quota : compteur atomique dans Supabase (RPC increment_quota, voir SETUP.md)
//   Retourne { allowed, current, soft } ; soft=true si Supabase a échoué.
// ---------------------------------------------------------------------------
async function checkQuota(env, user, service, limit) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return { allowed: true, current: 0, soft: true }; // non configuré (dev local)
  }
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/increment_quota`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": env.SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({ p_user: user, p_service: service, p_limit: limit })
    });
    if (!r.ok) return { allowed: true, current: 0, soft: true };
    const d = await r.json();
    const row = Array.isArray(d) ? d[0] : d;
    return { allowed: !!(row && row.allowed), current: row ? row.current : 0, soft: false };
  } catch (_e) {
    return { allowed: true, current: 0, soft: true };
  }
}

// ---------------------------------------------------------------------------
// Agent IA (Mistral) — interprète des données déjà calculées
// ---------------------------------------------------------------------------
async function callMistral(env, taskLine, payload) {
  const model = env.MISTRAL_MODEL || "mistral-small-latest";
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        taskLine +
        "\n\nDonnées (déjà calculées par l'application — à interpréter, sans rien inventer) :\n" +
        JSON.stringify(payload)
    }
  ];
  const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.MISTRAL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, messages, temperature: 0.4 })
  });
  const d = await r.json();
  const text = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
  return { text, model };
}

async function handleAgent(request, env, task) {
  const user = getUser(request);
  const q = await checkQuota(env, user, "agent", LIMITS.agent);
  if (!q.allowed) return json({ error: "quota_agent_atteint", limit: LIMITS.agent }, 429, env);
  const payload = await request.json().catch(() => ({}));
  const out = await callMistral(env, TASK[task], payload);
  return json({ source: "mistral", model: out.model, text: out.text }, 200, env);
}

// ---------------------------------------------------------------------------
// Proxy Google (clé serveur). Le client envoie la requête Google + le fieldMask.
// ---------------------------------------------------------------------------
const DEFAULT_FIELDMASK_PLACES =
  "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel";

async function googlePlaces(request, env) {
  const user = getUser(request);
  const q = await checkQuota(env, user, "google_places", LIMITS.google_places);
  if (!q.allowed) return json({ error: "quota_google_places_atteint", limit: LIMITS.google_places }, 429, env);

  const body = await request.json().catch(() => ({}));
  const mode = body.mode === "text" ? "searchText" : "searchNearby";
  const url = `https://places.googleapis.com/v1/places:${mode}`;
  const fieldMask = body.fieldMask || DEFAULT_FIELDMASK_PLACES;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": fieldMask
    },
    body: JSON.stringify(body.request || {})
  });
  const data = await r.json();
  return json({ source: "google", data }, r.status, env);
}

async function googleDetails(request, env) {
  const user = getUser(request);
  const q = await checkQuota(env, user, "google_places", LIMITS.google_places);
  if (!q.allowed) return json({ error: "quota_google_places_atteint", limit: LIMITS.google_places }, 429, env);

  const body = await request.json().catch(() => ({}));
  if (!body.id) return json({ error: "id_manquant" }, 400, env);
  const fieldMask = body.fieldMask || "id,displayName,formattedAddress,rating,userRatingCount,priceLevel,reviews,regularOpeningHours";

  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(body.id)}`, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": fieldMask
    }
  });
  const data = await r.json();
  return json({ source: "google", data }, r.status, env);
}

// Routes API (péage premium). Fail-closed sur erreur de quota pour protéger les coûts.
async function googleRoutes(request, env) {
  const user = getUser(request);
  const q = await checkQuota(env, user, "google_routes", LIMITS.google_routes);
  if (q.soft) return json({ error: "quota_indisponible_google_bloque" }, 503, env); // sécurité coûts
  if (!q.allowed) return json({ error: "quota_google_routes_atteint", limit: LIMITS.google_routes }, 429, env);

  const body = await request.json().catch(() => ({}));
  const fieldMask =
    body.fieldMask ||
    "routes.duration,routes.distanceMeters,routes.travelAdvisory.tollInfo,routes.legs.travelAdvisory.tollInfo";

  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": fieldMask
    },
    body: JSON.stringify(body.request || {})
  });
  const data = await r.json();
  return json({ source: "google_routes", data }, r.status, env);
}

// Proxy d'une photo de lieu (la clé reste côté serveur, l'app reçoit l'image directement)
async function googlePhoto(request, env, url) {
  const user = getUser(request);
  const q = await checkQuota(env, user, "google_places", LIMITS.google_places);
  if (!q.allowed) return json({ error: "quota_google_places_atteint", limit: LIMITS.google_places }, 429, env);

  const name = url.searchParams.get("name");
  const w = url.searchParams.get("w") || "500";
  if (!name) return json({ error: "name_manquant" }, 400, env);

  const r = await fetch(
    `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${encodeURIComponent(w)}&key=${env.GOOGLE_MAPS_API_KEY}`,
    { redirect: "follow" }
  );
  const headers = { ...corsHeaders(env) };
  const ct = r.headers.get("Content-Type");
  if (ct) headers["Content-Type"] = ct;
  return new Response(r.body, { status: r.status, headers });
}

// ---------------------------------------------------------------------------
// Routeur principal
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "GET" && path === "/health") return json({ ok: true }, 200, env);
      if (request.method === "GET" && path === "/google/photo") return await googlePhoto(request, env, url);

      if (request.method === "POST") {
        switch (path) {
          case "/agent/conseil-trajet": return await handleAgent(request, env, "trajet");
          case "/agent/resto":          return await handleAgent(request, env, "resto");
          case "/agent/jour":           return await handleAgent(request, env, "jour");
          case "/google/places":        return await googlePlaces(request, env);
          case "/google/details":       return await googleDetails(request, env);
          case "/google/routes":        return await googleRoutes(request, env);
        }
      }
      return json({ error: "route_introuvable", path }, 404, env);
    } catch (e) {
      return json({ error: "erreur_serveur", detail: (e && e.message) || String(e) }, 500, env);
    }
  }
};
