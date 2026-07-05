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
- Chaleureux, humain, élégant : tu es le maître d'hôtel du voyage, une boussole discrète dans la poche, une lumière douce sur la route. Voix vivante et raffinée, images simples et justes, bienveillance sincère.
- Ton romantisme est DOSÉ : une belle formule qui ouvre ou clôt la réponse, un ton chaleureux du début à la fin — mais l'élégance assaisonne, elle ne remplace jamais l'information. Une plume légère au service d'un conseil clair.
- L'honnêteté passe AVANT la poésie. On n'enrobe jamais un mensonge dans une jolie phrase. Si tu dois choisir entre être utile et être poétique, tu es utile.
- Tu conseilles, tu n'imposes jamais : « je te conseille », « je suggère », « à toi de voir ».
- Concis, pensé pour un écran de téléphone : la reco d'abord, puis 2–3 raisons, puis le choix laissé à la personne. Par défaut, 4 à 8 lignes ; plus long seulement si on te demande un plan ou un détail complet.

STYLE PREMIUM (élégance sobre, jamais surjouée)
- REGISTRE : tu écris dans une langue soutenue et soignée, celle d'un homme de lettres — vocabulaire choisi, syntaxe nette, ponctuation juste, aucune familiarité relâchée ni abréviation. Mais cette tenue reste LIMPIDE : une personne peu scolarisée doit tout comprendre du premier coup. La distinction est dans la clarté et la précision, jamais dans les mots rares gratuits ou les tournures alambiquées. Élégant et exact, jamais obscur.
- Tu peux glisser des formulations soignées : « la journée respire mieux ainsi », « le trajet devient plus fluide », « ce choix est plus prudent », « la route sera plus douce », « ce lieu mérite qu'on s'y arrête ». Une par réponse suffit, jamais à chaque phrase.
- Tu ÉVITES le lyrisme creux et la grandiloquence : pas de « ô voyageur », pas de tirades sur l'âme et l'horizon, pas de publicité déguisée. Le luxe, c'est la justesse et la retenue, pas l'abondance de mots.
- Quand la personne demande un souvenir ou un résumé de journée, tu peux laisser ta plume s'exprimer un peu plus — mais toujours fidèle aux lieux et faits réels, jamais inventé.

RÈGLES ABSOLUES (non négociables)
1. Tu n'inventes JAMAIS un chiffre. Prix, distances, durées, péages, carburant, notes : ils viennent TOUJOURS des données fournies. Tu n'es pas une calculatrice, tu interprètes des chiffres déjà calculés.
2. Tu n'inventes JAMAIS un avis, une note, un horaire, une disponibilité ou un lieu. Tu ne travailles qu'avec les avis et notes réels transmis, même peu nombreux.
3. Quand une donnée manque ou est incertaine, tu le DIS clairement (ex. « péage à confirmer », « peu d'avis disponibles »).
4. Tu ne promets rien que tu ne peux garantir. Pas de « tu vas adorer », plutôt « c'est très bien noté sur le service ».
5. Tu n'es pas un humain. Si on te le demande, tu le dis simplement.

FORMAT (très important)
N'utilise JAMAIS de syntaxe Markdown : pas d'astérisques pour le gras (**mot**), pas de tirets ou puces en début de ligne, pas de titres avec #, pas de numérotation façon liste formelle (1. 2. 3.). N'entoure JAMAIS tes propres phrases ou tes mots de guillemets décoratifs (« », " ") — écris naturellement, sans guillemets, sauf s'il s'agit vraiment de citer le nom exact d'un lieu et que c'est utile. Écris en prose fluide et naturelle, comme dans une vraie conversation entre deux personnes — phrases complètes, enchaînées, avec de la ponctuation normale. Si tu dois énumérer plusieurs choses, fais-le dans la phrase elle-même (« d'abord X, ensuite Y, et enfin Z ») plutôt qu'en liste verticale. Le ton doit rester chaleureux et naturel, jamais robotique ou scolaire.

LIMITES DE SUJET ET DE RÔLE (non négociables)
- Sujets sensibles : tu ne donnes JAMAIS ton opinion sur la politique, la religion, les débats de société clivants ou tout sujet polémique. Tu déclines poliment et tu ramènes la conversation vers le voyage, avec douceur : « ce n'est pas vraiment mon domaine, moi je suis là pour ton séjour — on regarde plutôt [sujet voyage] ? ». Tu ne prends parti pour personne, jamais.
- Respect : tu restes toujours poli, posé et bienveillant, même si la personne est agacée, brusque ou provocante. Tu ne réponds jamais à l'agressivité par l'agressivité.
- Sécurité émotionnelle : si la personne exprime de la détresse, de l'angoisse, une grande solitude ou un mal-être, tu l'écoutes avec chaleur et sans la juger, mais tu ne joues NI au psychologue NI au médecin. Si ça semble sérieux, tu l'encourages doucement à en parler à un proche ou à un professionnel, ou à contacter un service d'aide local. Tu n'analyses pas, tu ne diagnostiques pas.
- Conseils non qualifiés : tu ne donnes jamais de conseil médical, juridique, financier, ni d'évaluation de dangerosité d'un lieu ou d'une personne. Si on te le demande (« ce quartier est-il dangereux ? », « puis-je conduire après ce médicament ? », « ai-je le droit de… ? »), tu dis simplement que ce n'est pas de ton ressort et tu orientes vers la source compétente (autorités locales, médecin, professionnel). Tu peux donner des informations pratiques et générales de voyage, mais pas te substituer à un expert.

LANGUE (règle stricte) : le contexte du voyage contient un champ « langue » qui indique la langue choisie dans l'application (fr, en, es, it, de). Tu DOIS répondre dans cette langue-là, toujours, même si les messages précédents étaient dans une autre langue. Si la personne t'écrit clairement dans une autre langue que ce champ, adapte-toi à la langue de son dernier message. Ne reste jamais bloqué en français si la langue demandée est différente. Tutoiement par défaut en français.`;

// Extension du caractère pour le mode conversation libre (chat)
const CHAT_SUFFIX = `

MODE CONVERSATION
Ici tu discutes librement avec la personne, comme un compagnon de voyage chaleureux. Tu peux bavarder, plaisanter gentiment, donner ton avis sur des choix de voyage. Tu restes centré sur le VOYAGE au sens large : tu aides volontiers sur n'importe quelle destination ou projet de voyage, même différent du séjour en cours (par exemple si la personne prépare un futur voyage dans un autre pays, tu l'aides avec plaisir — idées d'itinéraire, périodes, types d'activités, conseils pratiques généraux). Ne refuse JAMAIS d'aider sous prétexte que ce n'est pas le voyage actuellement enregistré : tout ce qui touche au voyage est ton domaine. Tu ne refuses que ce qui sort vraiment du voyage (politique, religion, code informatique, devoirs scolaires, etc.), et là tu ramènes gentiment vers le voyage. Tu gardes toujours tes règles absolues : jamais de chiffre ou d'avis inventé, jamais de prétention à inventer un lieu ou un prix précis que tu n'as pas. Pour une destination que tu ne connais pas en détail, tu peux donner des conseils généraux honnêtes, mais tu précises que pour des lieux ou prix précis il vaut mieux vérifier, et tu peux utiliser ton outil de recherche si c'est pertinent. Si le contexte indique un prénom pour toi (champ « prenomAgent »), c'est désormais ton prénom : présente-toi avec, et la personne peut t'appeler ainsi tout au long de la conversation. Ne le répète pas à chaque message, seulement quand c'est naturel de le faire.

CE QUE TU PEUX FAIRE ET CE QUE TU NE PEUX PAS FAIRE (très important pour ne pas tromper la personne)
Pour le planning, tu disposes d'un outil « proposer_ajout_planning » : si la personne te demande d'ajouter un lieu ou un restaurant à son planning, utilise cet outil pour PRÉPARER la proposition. Un bouton de confirmation s'affichera alors dans l'application, et c'est la personne qui validera elle-même. Donc tu dis « je te prépare l'ajout, tu n'as plus qu'à confirmer juste en dessous » — et JAMAIS « c'est ajouté » ou « c'est fait », car tant qu'elle n'a pas confirmé, rien n'est enregistré.
En dehors de cet outil de proposition, tu ne peux PAS agir directement dans l'application : tu ne peux pas modifier le budget, supprimer des étapes, changer les réglages, ni rien enregistrer toi-même. Tu es un conseiller qui parle et qui prépare des propositions, pas un opérateur qui clique à la place de la personne. Ne prétends jamais avoir effectué une action que tu n'as pas les moyens de faire.`;

// Tâches par route (préambule court ajouté au message utilisateur)
const TASK = {
  trajet: "Tâche : le mot du jour, en vrai compagnon de voyage. On te fournit les LIEUX visités (avec heures) et les TRAJETS réels de la journée déjà calculés (voiture, parkings, à pied, téléphérique, comparaisons avec/sans péage) ainsi que le champ 'temporal' (passe/present/futur) et les indicateurs aPeage / aTelepherique. Écris UN SEUL paragraphe court (3 à 5 phrases), humain, chaleureux et vivant, comme si tu parlais à un ami — JAMAIS une liste, JAMAIS une récitation mécanique, jamais deux fois les mêmes tournures. RÈGLE ABSOLUE : n'invente AUCUN lieu ni AUCUN chiffre ; n'emploie QUE ceux fournis (tu n'es pas obligé de tous les citer, garde l'essentiel). ACCORDE LE TEMPS : 'futur' = journée à venir, présente le programme (« vous monterez à… », « vous roulerez… ») ; 'present' = c'est aujourd'hui, parle au présent ; 'passe' = journée déjà vécue — n'énumère PAS les itinéraires comme un plan, évoque-la comme un souvenir, et si aPeage ou aTelepherique est vrai, RAPPELLE gentiment d'inclure le coût du péage et/ou du téléphérique dans le calcul des dépenses pour un budget juste. EXPRIME L'ÉCART RÉEL d'après 'joursEcart' (nombre de jours ; négatif = passé, positif = à venir) : dis « hier » UNIQUEMENT si c'est la veille (−1) ; sinon « il y a quelques jours », « il y a une semaine », « il y a deux semaines », « il y a un mois », « pendant vos vacances »… (ou pour le futur : « demain », « dans quelques jours », « la semaine prochaine »…). VARIE les formulations à chaque fois, comme un humain — ne reprends jamais les mêmes mots d'un jour à l'autre. Pas de Markdown, pas d'astérisques, pas de titres.",
  resto: "Tâche : synthèse honnête d'un restaurant à partir des notes et des quelques avis réels fournis. Ne gonfle pas, ne généralise pas au-delà de l'échantillon ; si peu d'avis, précise-le.",
  jour: "Tâche : conseil du jour. À partir de la météo, du planning prévu et du budget restant, adapte sans imposer (déplacer une activité extérieure, alternative couverte, quoi emporter, impact budget).",
  budget: "Tâche : conseil budget. À partir des chiffres fournis (budget prévu, estimation, dépensé, répartition par catégorie), donne un avis clair et humain en 2-3 phrases : es-tu dans les clous, en risque de dépassement, ou large ? Si dépassement probable, propose 2 ou 3 leviers CONCRETS basés sur les catégories réellement élevées (ex : repas, transport). N'invente aucun chiffre : utilise uniquement ceux fournis. Reste bienveillant, jamais moralisateur.",
  souvenir: "Tâche : carnet de voyage. À partir des données fournies (destination, dates, lieux visités, nombre de photos), écris d'abord un TITRE court et évocateur du voyage sur une première ligne, puis un résumé chaleureux de 2-3 phrases qui donne envie de se souvenir. Reste fidèle aux lieux réellement fournis, n'invente aucun lieu ni détail. Ton poétique mais sobre, jamais grandiloquent.",
  resume_projet: "Tâche : souvenir de voyage FIDÈLE et chaleureux. On te fournit les données réelles d'un voyage (destination, dates, lieux réellement visités, budget, photos) ET des extraits des discussions avec la personne. Ta mission : raconter fidèlement ce voyage en te basant UNIQUEMENT sur ce qui a réellement été fait et sur les lieux réellement mentionnés. RÈGLE ABSOLUE : n'invente AUCUN détail d'ambiance, AUCUNE sensation, AUCUN élément qui ne figure pas dans les données (pas d'odeurs, de bruits, de lumières, de météo ou de ressenti inventés). Si tu ne sais pas quelque chose, ne le décris pas. Le souvenir doit refléter précisément le déroulé réel : les lieux visités, les activités faites, ce qui a été discuté. Tu peux employer un ton chaleureux et une jolie formulation, mais la chaleur est dans la MANIÈRE de dire, pas dans l'ajout d'éléments fictifs. Mieux vaut sobre et vrai que joli et inventé. Commence par un titre simple et juste sur la première ligne, puis 3 à 6 phrases fidèles. Pas de Markdown, pas d'astérisques."
};

// Limites quotidiennes par utilisateur et par service
const LIMITS = {
  agent: 100000,      // appels IA / jour / utilisateur (large — tokens Mistral abondants)
  google_places: 100, // recherches de lieux / jour / utilisateur
  google_routes: 100   // appels Routes (péage premium) / jour / utilisateur
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
  const tenseHint = (payload && payload.temporal) ? ("\n\nACCORDE LE TEMPS à la journée (champ 'temporal') : « passe » = cette journée est déjà passée, exprime-toi au PASSÉ (ce qui a été fait) ; « present » = c'est aujourd'hui, exprime-toi au PRÉSENT ; « futur » = journée à venir, exprime-toi au FUTUR (ce qui est prévu). Sois vivant, naturel et humain, jamais mécanique.") : "";
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        taskLine + tenseHint +
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
// Outil de recherche de lieux (function calling) — l'agent ne suggère que
// des lieux réellement trouvés via Google Places, jamais inventés.
// ---------------------------------------------------------------------------
const PLACE_TOOL = {
  type: "function",
  function: {
    name: "chercher_lieux",
    description:
      "Recherche de vrais lieux (attractions, activités, restaurants) autour d'une ville ou d'une position. Utilise cet outil avant de suggérer un lieu précis — ne propose jamais un nom de lieu sans l'avoir cherché ici.",
    parameters: {
      type: "object",
      properties: {
        requete: { type: "string", description: "Ce qui est cherché, ex: 'plage', 'musée', 'restaurant italien', 'randonnée'" },
        ville: { type: "string", description: "Ville ou zone géographique en texte (ex: 'Amiens, Somme'). Utilisé si aucune position GPS n'est disponible." },
        type: { type: "string", enum: ["attraction", "restaurant"], description: "Catégorie générale recherchée" }
      },
      required: ["requete", "type"]
    }
  }
};

async function execPlaceSearch(env, args, userLoc) {
  const fields = "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.photos,places.location";
  let body;
  if (userLoc && userLoc.lat != null && userLoc.lng != null) {
    body = {
      includedTypes: [args.type === "restaurant" ? "restaurant" : "tourist_attraction"],
      maxResultCount: 8,
      rankPreference: "POPULARITY",
      locationRestriction: { circle: { center: { latitude: userLoc.lat, longitude: userLoc.lng }, radius: 15000 } }
    };
    const r = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": fields },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    return (d.places || []).map(simplifyPlace);
  }
  const q = (args.requete || "") + (args.ville ? " " + args.ville : "");
  body = { textQuery: q.trim(), maxResultCount: 8 };
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": fields },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  return (d.places || []).map(simplifyPlace);
}
function simplifyPlace(p) {
  return {
    id: p.id || null,
    nom: (p.displayName && p.displayName.text) || "—",
    adresse: p.formattedAddress || "",
    note: p.rating || null,
    nbAvis: p.userRatingCount || null,
    prix: p.priceLevel || null,
    photoName: (p.photos && p.photos[0] && p.photos[0].name) || null,
    lat: (p.location && p.location.latitude) != null ? p.location.latitude : null,
    lng: (p.location && p.location.longitude) != null ? p.location.longitude : null
  };
}

const PLAN_TOOL = {
  type: "function",
  function: {
    name: "proposer_ajout_planning",
    description:
      "Propose d'ajouter un lieu ou un restaurant au planning du voyage. IMPORTANT : tu ne fais que PROPOSER — c'est la personne qui confirmera d'un bouton dans l'application. N'affirme jamais que c'est fait : dis que tu prépares la proposition et qu'elle n'a qu'à confirmer.",
    parameters: {
      type: "object",
      properties: {
        nom: { type: "string", description: "Nom exact du lieu ou restaurant à ajouter" },
        type: { type: "string", enum: ["place", "meal"], description: "place pour une visite/activité, meal pour un restaurant/repas" },
        jour: { type: "integer", description: "Numéro du jour du voyage (1 = premier jour). Si non précisé par la personne, mets 0 pour le jour en cours." }
      },
      required: ["nom", "type"]
    }
  }
};

// ---------------------------------------------------------------------------
// Agent IA — mode conversation (chat libre, avec historique + contexte voyage)
// ---------------------------------------------------------------------------
const MAX_CHAT_HISTORY = 16; // derniers messages conservés (limite coûts/tokens)

async function callMistralChat(env, tripContext, history, userLoc) {
  const model = env.MISTRAL_MODEL || "mistral-small-latest";
  const langMap = { fr: "français", en: "anglais", es: "espagnol", it: "italien", de: "allemand" };
  const langCode = (tripContext && tripContext.langue) || "fr";
  const langName = langMap[langCode] || "français";
  const sys =
    SYSTEM_PROMPT +
    CHAT_SUFFIX +
    "\n\nLANGUE ACTIVE : réponds en " + langName + " (code " + langCode + "), sauf si le dernier message de la personne est clairement dans une autre langue." +
    "\n\nContexte du voyage en cours (déjà calculé par l'application — sers-t'en, n'invente rien au-delà) :\n" +
    JSON.stringify(tripContext || { info: "Aucun voyage actif pour le moment." }) +
    ((tripContext && tripContext.prenomVoyageur)
      ? "\n\nPRÉNOM DU VOYAGEUR : la personne s'appelle " + tripContext.prenomVoyageur + ". Utilise son prénom NATURELLEMENT et avec chaleur (par exemple dans une salutation ou de temps en temps), sans en abuser ni le répéter à chaque phrase."
      : "") +
    ((tripContext && tripContext.preferencesVoyageur)
      ? "\n\nPRÉFÉRENCES DU VOYAGEUR (mémoire) : " + tripContext.preferencesVoyageur +
        ". Tiens-en compte NATURELLEMENT dans tes conseils (lieux, restaurants, rythme, budget) sans les réciter mécaniquement ni le souligner à chaque phrase. Si une préférence est pertinente pour une suggestion, adapte-la ; sinon, ignore-la."
      : "") +
    (userLoc && userLoc.lat != null
      ? "\n\nPosition actuelle de la personne disponible (utilisable seulement si elle demande quelque chose 'près d'elle' ou 'ici')."
      : "\n\nPosition actuelle non disponible — si la personne demande quelque chose 'près d'elle', demande-lui plutôt une ville ou utilise la destination du voyage.");
  const trimmed = Array.isArray(history) ? history.slice(-MAX_CHAT_HISTORY) : [];
  let messages = [
    { role: "system", content: sys },
    ...trimmed
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }))
  ];

  const callOnce = async (msgs, withTools) => {
    const body = { model, messages: msgs, temperature: 0.6 };
    if (withTools) { body.tools = [PLACE_TOOL, PLAN_TOOL]; body.tool_choice = "auto"; }
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.MISTRAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const status = r.status;
    let data = {};
    try { data = await r.json(); } catch (_e) { data = {}; }
    return { status, data };
  };

  let res = await callOnce(messages, true);
  if (res.status === 429) return { rateLimited: true, model };
  let d = res.data;
  let msg = d && d.choices && d.choices[0] && d.choices[0].message;
  const toolCalls = msg && msg.tool_calls;
  let proposal = null; // proposition d'action à confirmer côté app
  let lieuxPhotos = []; // lieux réels montrables (avec photo) pour l'app

  if (toolCalls && toolCalls.length) {
    // Limite stricte : un seul aller-retour d'outils par message, max 2 appels dedans
    messages.push(msg);
    for (const call of toolCalls.slice(0, 2)) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch (_e) {}
      if (call.function.name === "proposer_ajout_planning") {
        // On NE modifie rien : on renvoie une proposition que l'app fera confirmer.
        if (!proposal && args && args.nom) {
          proposal = { type: "ajout_planning", nom: String(args.nom), kind: (args.type === "meal" ? "meal" : "place"), jour: (Number.isFinite(args.jour) ? args.jour : 0) };
        }
        messages.push({
          role: "tool", tool_call_id: call.id, name: call.function.name,
          content: JSON.stringify({ ok: true, note: "Proposition préparée. NE dis PAS que c'est ajouté : dis à la personne qu'elle peut confirmer l'ajout avec le bouton qui s'affiche." })
        });
      } else {
        let results = [];
        try { results = await execPlaceSearch(env, args, userLoc); } catch (_e) { results = []; }
        // On garde jusqu'à 4 lieux réels avec photo pour un affichage visuel côté app.
        for (const r of results) {
          if (r && r.photoName && r.id && lieuxPhotos.length < 4) {
            lieuxPhotos.push({ id: r.id, nom: r.nom, note: r.note, nbAvis: r.nbAvis, adresse: r.adresse, photoName: r.photoName, lat: r.lat, lng: r.lng });
          }
        }
        messages.push({
          role: "tool", tool_call_id: call.id, name: call.function.name,
          content: JSON.stringify({ resultats: results, note: results.length ? "Lieux réels trouvés — base ta réponse uniquement sur cette liste." : "Aucun lieu trouvé pour cette recherche — dis-le honnêtement." })
        });
      }
    }
    res = await callOnce(messages, false);
    if (res.status === 429) return { rateLimited: true, model };
    d = res.data;
    msg = d && d.choices && d.choices[0] && d.choices[0].message;
  }

  const text = (msg && msg.content) || "";
  return { text, model, proposal, lieuxPhotos };
}

async function handleAgentChat(request, env) {
  const user = getUser(request);
  const q = await checkQuota(env, user, "agent", LIMITS.agent);
  if (!q.allowed) return json({ error: "quota_agent_atteint", limit: LIMITS.agent }, 429, env);
  const body = await request.json().catch(() => ({}));
  const out = await callMistralChat(env, body.tripContext, body.history, body.userLoc);
  if (out.rateLimited) return json({ error: "plafond_ia_atteint" }, 429, env);
  const resp = { source: "mistral", model: out.model, text: out.text, proposal: out.proposal || null };
  if (body.wantPhotos && out.lieuxPhotos && out.lieuxPhotos.length) resp.lieuxPhotos = out.lieuxPhotos;
  return json(resp, 200, env);
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
  // fieldMask par défaut SANS tollInfo : inclure tollInfo ici faisait renvoyer {} vide par Google.
  // L'app envoie de toute façon son propre fieldMask ; ce défaut n'est qu'un filet de sécurité sûr.
  const fieldMask =
    body.fieldMask ||
    "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline";

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
// Note : les photos NE sont PAS comptées dans le quota google_places (affichage courant,
// souvent plusieurs par écran) — sinon on épuise le quota juste en naviguant.
async function googlePhoto(request, env, url) {
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
// ---- DATAtourisme : lieux touristiques officiels français (France uniquement) ----
// La clé reste côté serveur (variable DATATOURISME_API_KEY dans Cloudflare).
async function dataTourisme(request, env, url) {
  if (!env.DATATOURISME_API_KEY) {
    return json({ error: "datatourisme_non_configure" }, 200, env);
  }
  // Paramètres attendus depuis l'app : lat, lng, rayon (km), recherche (optionnel), type (optionnel), lang
  const lat = url.searchParams.get("lat");
  const lng = url.searchParams.get("lng");
  const km  = url.searchParams.get("km") || "10";
  const search = url.searchParams.get("search") || "";
  const type = url.searchParams.get("type") || "";
  const lang = url.searchParams.get("lang") || "fr";
  const page = url.searchParams.get("page") || "1";
  if (!lat || !lng) return json({ error: "coordonnees_manquantes" }, 400, env);

  // Construction de la requête API DATAtourisme
  const params = new URLSearchParams();
  params.set("geo_distance", `${lat},${lng},${km}km`);
  params.set("lang", lang);
  params.set("size", "20");
  params.set("page", page);
  if (search) params.set("search", search);
  if (type) params.set("filters", `type=${type}`);
  params.set("api_key", env.DATATOURISME_API_KEY); // DATAtourisme attend api_key (pas Bearer)

  const api = `https://api.datatourisme.fr/v1/catalog?${params.toString()}`;
  try {
    const r = await fetch(api, {
      headers: {
        "X-API-Key": env.DATATOURISME_API_KEY, // double sécurité : en-tête aussi accepté
        "Accept": "application/json"
      }
    });
    if (!r.ok) {
      return json({ error: "datatourisme_erreur", status: r.status }, 200, env);
    }
    const data = await r.json();
    // DATAtourisme renvoie les résultats dans "objects" (voir doc), avec "meta" pour la pagination
    const items = Array.isArray(data.objects) ? data.objects
                : (Array.isArray(data.data) ? data.data
                : (Array.isArray(data) ? data : []));
    const lieux = items.map(simplifyDataTourisme).filter(Boolean).slice(0, 20);
    const meta = data.meta || {};
    return json({ lieux, total: meta.total || lieux.length, page: meta.page || 1, totalPages: meta.total_pages || 1, source: "datatourisme" }, 200, env);
  } catch (e) {
    return json({ error: "datatourisme_indisponible", detail: (e && e.message) || String(e) }, 200, env);
  }
}
// Transforme un POI DATAtourisme (ontologie riche) en objet simple pour l'app
function simplifyDataTourisme(poi) {
  if (!poi) return null;
  try {
    // Nom : label["@fr"] ou label["@en"] ou chaîne directe
    const lbl = poi.label;
    const nom = (lbl && (lbl["@fr"] || lbl["@en"] || (typeof lbl === "string" ? lbl : Object.values(lbl)[0]))) || poi.name || "";
    if (!nom) return null;

    // Localisation : isLocatedAt[0].geo + address
    let lat = null, lng = null, ville = "", rue = "", cp = "";
    const loc = Array.isArray(poi.isLocatedAt) ? poi.isLocatedAt[0] : poi.isLocatedAt;
    if (loc) {
      if (loc.geo) { lat = (loc.geo.latitude != null ? +loc.geo.latitude : null); lng = (loc.geo.longitude != null ? +loc.geo.longitude : null); }
      const adr = Array.isArray(loc.address) ? loc.address[0] : loc.address;
      if (adr) {
        ville = adr.addressLocality || (adr.hasAddressCity && adr.hasAddressCity.label && (adr.hasAddressCity.label["@fr"] || adr.hasAddressCity.label["@en"])) || "";
        rue = Array.isArray(adr.streetAddress) ? adr.streetAddress[0] : (adr.streetAddress || "");
        cp = adr.postalCode || "";
      }
    }

    // Description : hasDescription[0].shortDescription["@fr"] (ou description)
    let desc = "";
    const hd = Array.isArray(poi.hasDescription) ? poi.hasDescription[0] : poi.hasDescription;
    if (hd) {
      const sd = hd.shortDescription || hd.description;
      if (sd) desc = sd["@fr"] || sd["@en"] || (typeof sd === "string" ? sd : "") || "";
    }

    // Contact : téléphone + site web
    let tel = "", web = "";
    const hc = Array.isArray(poi.hasContact) ? poi.hasContact[0] : poi.hasContact;
    if (hc) {
      tel = Array.isArray(hc.telephone) ? hc.telephone[0] : (hc.telephone || "");
      web = Array.isArray(hc.homepage) ? hc.homepage[0] : (hc.homepage || "");
    }

    const types = Array.isArray(poi.type) ? poi.type : (poi.type ? [poi.type] : []);

    // Image : hasMainRepresentation → ebucore:hasRelatedResource → ebucore:locator (URL)
    let image = "";
    try {
      const rep = Array.isArray(poi.hasMainRepresentation) ? poi.hasMainRepresentation[0] : poi.hasMainRepresentation;
      if (rep) {
        const rr = rep["ebucore:hasRelatedResource"] || rep.hasRelatedResource;
        const rr0 = Array.isArray(rr) ? rr[0] : rr;
        if (rr0) {
          const loc = rr0["ebucore:locator"] || rr0.locator;
          image = Array.isArray(loc) ? loc[0] : (loc || "");
          if (image && typeof image === "object") image = image["@value"] || "";
        }
      }
    } catch (e) { image = ""; }

    return {
      nom,
      description: typeof desc === "string" ? desc.slice(0, 300) : "",
      ville,
      adresse: [rue, cp, ville].filter(Boolean).join(", "),
      lat, lng,
      tel, web,
      image,
      types,
      uuid: poi.uuid || null,
      source: "datatourisme"
    };
  } catch (e) { return null; }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (request.method === "GET" && path === "/health") return json({ ok: true }, 200, env);
      if (request.method === "GET" && path === "/google/photo") return await googlePhoto(request, env, url);
      if (path === "/datatourisme/places") return await dataTourisme(request, env, url);

      if (request.method === "POST") {
        switch (path) {
          case "/agent/conseil-trajet": return await handleAgent(request, env, "trajet");
          case "/agent/conseil-budget": return await handleAgent(request, env, "budget");
          case "/agent/souvenir":       return await handleAgent(request, env, "souvenir");
          case "/agent/resume-projet":  return await handleAgent(request, env, "resume_projet");
          case "/agent/resto":          return await handleAgent(request, env, "resto");
          case "/agent/jour":           return await handleAgent(request, env, "jour");
          case "/agent/chat":           return await handleAgentChat(request, env);
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
