// lib/app.js — a mesma API de conta e sincronização, adaptada para
// serverless: sem app.listen() (o Vercel chama o handler por requisição),
// sem servir estáticos (o Vercel entrega public/ direto pela CDN), e com
// rate limit e armazenamento vivendo no Redis em vez de memória/disco local.

const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");
const mail = require("./mail");

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = "quack_session";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

// hash de referência sem relação com senha nenhuma, só pra dar ao login
// algo pra comparar quando o e-mail nem existe — ver uso em /api/auth/login.
// Calculado uma vez (custo síncrono só no cold start, não por requisição)
const DUMMY_HASH = bcrypt.hashSync("quack-timing-placeholder", 10);

// O Vercel Hobby limita o corpo de requisições a ~4.5MB; ficamos com folga
// abaixo disso. Para o tipo de dado guardado aqui (tarefas, hábitos, etc.)
// isso é muito espaço — mas vale saber que o teto existe.
const MAX_STATE_BYTES = 4 * 1024 * 1024;

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "4mb" }));
app.use(cookieParser());

// no Vercel, index.html é servido estático direto pela CDN e nunca passa
// por aqui — esses cabeçalhos valem pras respostas de /api/*, mas quem
// protege a página de verdade é o "headers" em vercel.json. Mantidos aqui
// também porque este mesmo app.js é a base do pacote pra VPS/Render, onde
// o Express serve a página estática diretamente
app.use(function(req, res, next){
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "frame-src https://www.youtube.com https://open.spotify.com; object-src 'none'; base-uri 'self'; " +
    "form-action 'self'; frame-ancestors 'none'"
  );
  next();
});

function clientIp(req){
  return req.ip || (req.connection && req.connection.remoteAddress) || "desconhecido";
}

function ensureSecret(){
  if(!JWT_SECRET || JWT_SECRET.length < 16){
    throw new Error(
      "JWT_SECRET não configurado (ou curto demais) nas variáveis de ambiente do projeto. " +
      "Gere um com: openssl rand -hex 32"
    );
  }
}

function signSession(userId){
  ensureSecret();
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "30d" });
}

// req.secure já reflete o X-Forwarded-Proto do Vercel (trust proxy está
// configurado abaixo) — mais confiável do que depender só de NODE_ENV
// estar setado certo pela plataforma
function setSessionCookie(req, res, token){
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/"
  });
}

async function requireAuth(req, res, next){
  var token = req.cookies && req.cookies[COOKIE_NAME];
  if(!token) return res.status(401).json({ error: "não autenticado" });
  try{
    ensureSecret();
    var payload = jwt.verify(token, JWT_SECRET);
    var user = await db.findUserById(payload.sub);
    if(!user) return res.status(401).json({ error: "sessão inválida" });
    req.user = user;
    next();
  }catch(e){
    res.status(401).json({ error: e.message.indexOf("JWT_SECRET") >= 0 ? e.message : "sessão expirada" });
  }
}

function validEmail(e){
  return typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function validUsername(u){
  return typeof u === "string" && /^[a-z0-9_]{3,20}$/.test(u);
}

function userPublic(u){
  return { email: u.email, username: u.username || null };
}

// middleware para não deixar uma rota sem try/catch derrubar a função
function h(fn){
  return function(req, res){
    Promise.resolve(fn(req, res)).catch(function(e){
      console.error(e);
      res.status(500).json({ error: "Algo deu errado no servidor." });
    });
  };
}

/* ---------- conta ---------- */

app.post("/api/auth/signup", h(async function(req, res){
  var ip = clientIp(req);
  if(!(await db.rateLimit("signup:" + ip, 12, 15 * 60))){
    return res.status(429).json({ error: "Muitas tentativas. Espere um pouco e tente de novo." });
  }
  var email = (req.body && req.body.email || "").trim().toLowerCase();
  var password = req.body && req.body.password || "";

  if(!validEmail(email)) return res.status(400).json({ error: "E-mail inválido." });
  if(typeof password !== "string" || password.length < 8){
    return res.status(400).json({ error: "A senha precisa ter pelo menos 8 caracteres." });
  }
  if(password.length > 200) return res.status(400).json({ error: "Senha muito longa." });

  try{
    var hash = await bcrypt.hash(password, 10);
    var user = await db.createUser(email, hash);
    console.log("[auth] nova conta criada:", email, "· ip:", ip, "·", new Date().toISOString());
    setSessionCookie(req, res, signSession(user.id));
    res.json(userPublic(user));
  }catch(e){
    if(e.message === "EMAIL_EM_USO"){
      return res.status(409).json({ error: "Já existe uma conta com esse e-mail." });
    }
    throw e;
  }
}));

app.post("/api/auth/login", h(async function(req, res){
  var ip = clientIp(req);
  var email = (req.body && req.body.email || "").trim().toLowerCase();
  var okIp = await db.rateLimit("login-ip:" + ip, 20, 15 * 60);
  var okEmail = email ? await db.rateLimit("login-email:" + email, 10, 15 * 60) : true;
  if(!okIp || !okEmail){
    return res.status(429).json({ error: "Muitas tentativas. Espere um pouco e tente de novo." });
  }
  var password = req.body && req.body.password || "";
  var user = await db.findUserByEmail(email);
  var invalido = function(){ res.status(401).json({ error: "E-mail ou senha incorretos." }); };

  // mesmo sem usuário (ou sem senha — conta criada só pelo Google), roda um
  // bcrypt.compare contra um hash fixo, sem relação com senha nenhuma, pra
  // gastar o mesmo tempo do caminho onde a senha existe de verdade — sem
  // isso, dava pra descobrir quais e-mails têm conta só medindo quanto
  // tempo a resposta demora
  var ok = await bcrypt.compare(String(password), (user && user.passwordHash) || DUMMY_HASH);
  if(!user || !user.passwordHash || !ok) return invalido();
  console.log("[auth] login:", email, "· ip:", ip, "·", new Date().toISOString());
  setSessionCookie(req, res, signSession(user.id));
  res.json(userPublic(user));
}));

/* ---------- login com Google (OAuth2, fluxo de redirecionamento) ---------- */
// de propósito sem o SDK/botão do Google (accounts.google.com/gsi/client):
// o script-src do CSP em vercel.json só permite 'self', e foi exatamente
// isso que travou a tentativa anterior de player com play/pause pela API
// do YouTube. O fluxo clássico de authorization code não carrega nenhum
// script de terceiro na página — é só uma navegação pro Google, e a troca
// de código por token acontece aqui no servidor, fora do CSP do navegador

const OAUTH_STATE_COOKIE = "quack_oauth_state";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

function ensureGoogleConfigured(){
  if(!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET){
    throw new Error("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET não configurados nas variáveis de ambiente do projeto.");
  }
}

// mesma lógica de req.secure usada em setSessionCookie — precisa bater
// exatamente com o "URI de redirecionamento autorizado" cadastrado no
// Google Cloud Console, então não dá pra montar isso errado
function googleRedirectUri(req){
  var proto = req.secure || process.env.NODE_ENV === "production" ? "https" : "http";
  return proto + "://" + req.get("host") + "/api/auth/google/callback";
}

app.get("/api/auth/google", function(req, res){
  try{
    ensureGoogleConfigured();
  }catch(e){
    return res.status(500).send(e.message);
  }
  var state = crypto.randomBytes(24).toString("hex");
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || process.env.NODE_ENV === "production",
    maxAge: 10 * 60 * 1000,
    path: "/"
  });
  var params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: "code",
    scope: "openid email",
    state: state,
    prompt: "select_account"
  });
  res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString());
});

app.get("/api/auth/google/callback", h(async function(req, res){
  ensureGoogleConfigured();
  var ip = clientIp(req);
  if(!(await db.rateLimit("google-callback:" + ip, 20, 15 * 60))){
    return res.status(429).send("Muitas tentativas. Espere um pouco e tente de novo.");
  }

  var cookieState = req.cookies && req.cookies[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });
  if(!req.query.state || !cookieState || req.query.state !== cookieState || !req.query.code){
    return res.status(400).send("Não foi possível confirmar o login com Google (state inválido ou expirado). Tente de novo.");
  }

  var tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: req.query.code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(req),
      grant_type: "authorization_code"
    })
  });
  if(!tokenResp.ok) return res.status(502).send("O Google recusou a troca do código de login.");
  var tokenData = await tokenResp.json();

  var profileResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: "Bearer " + tokenData.access_token }
  });
  if(!profileResp.ok) return res.status(502).send("Não consegui buscar seu perfil do Google.");
  var profile = await profileResp.json();

  if(!profile.email || !profile.email_verified){
    return res.status(400).send("Sua conta Google precisa ter um e-mail verificado pra entrar no Quack.");
  }
  var email = String(profile.email).trim().toLowerCase();

  var user = await db.findUserByEmail(email);
  if(user){
    // e-mail já verificado pelo Google — seguro tratar como a mesma pessoa
    // de uma conta criada por e-mail/senha, em vez de duplicar
    if(profile.sub) await db.setGoogleId(user.id, profile.sub);
  }else{
    user = await db.createUser(email, null, profile.sub);
  }

  console.log("[auth] login via Google:", email, "· ip:", ip, "·", new Date().toISOString());
  setSessionCookie(req, res, signSession(user.id));
  res.redirect("/");
}));

app.post("/api/auth/logout", function(req, res){
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, function(req, res){
  res.json(userPublic(req.user));
});

app.post("/api/auth/username", requireAuth, h(async function(req, res){
  var raw = (req.body && req.body.username || "").trim().toLowerCase();
  if(!validUsername(raw)){
    return res.status(400).json({ error: "Use de 3 a 20 letras minúsculas, números ou _." });
  }
  try{
    await db.setUsername(req.user.id, raw);
    res.json({ username: raw });
  }catch(e){
    if(e.message === "USERNAME_EM_USO"){
      return res.status(409).json({ error: "Esse nome de usuário já está em uso." });
    }
    throw e;
  }
}));

app.post("/api/auth/change-password", requireAuth, h(async function(req, res){
  var atual = req.body && req.body.currentPassword || "";
  var nova = req.body && req.body.newPassword || "";
  if(typeof nova !== "string" || nova.length < 8){
    return res.status(400).json({ error: "A nova senha precisa ter pelo menos 8 caracteres." });
  }
  var ok = await bcrypt.compare(String(atual), req.user.passwordHash);
  if(!ok) return res.status(401).json({ error: "Senha atual incorreta." });
  await db.updateUserPassword(req.user.id, await bcrypt.hash(nova, 10));
  res.json({ ok: true });
}));

app.post("/api/auth/forgot-password", h(async function(req, res){
  var ip = clientIp(req);
  if(!(await db.rateLimit("forgot:" + ip, 6, 15 * 60))){
    return res.status(429).json({ error: "Muitas tentativas. Espere um pouco e tente de novo." });
  }
  // a resposta é sempre a mesma, exista ou não a conta — não dar pista sobre
  // quais e-mails têm cadastro é o ponto principal de um fluxo desses
  var resposta = { ok: true, message: "Se existir uma conta com esse e-mail, mandamos um link de redefinição." };
  var email = (req.body && req.body.email || "").trim().toLowerCase();
  if(!validEmail(email)) return res.json(resposta);
  var user = await db.findUserByEmail(email);
  if(!user) return res.json(resposta);

  var token = await db.createResetToken(user.id);
  var origin = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.headers.host;
  var link = origin + "/?reset=" + token;
  await mail.sendMail(
    user.email,
    "Redefinir sua senha do Quack",
    "<p>Alguém (esperamos que você) pediu para redefinir a senha da sua conta no Quack.</p>" +
    "<p><a href=\"" + link + "\">Clique aqui para escolher uma nova senha</a>. O link vale por 1 hora.</p>" +
    "<p>Se não foi você, pode ignorar este e-mail — sua senha continua a mesma.</p>"
  );
  res.json(resposta);
}));

app.post("/api/auth/reset-password", h(async function(req, res){
  var ip = clientIp(req);
  if(!(await db.rateLimit("reset:" + ip, 10, 15 * 60))){
    return res.status(429).json({ error: "Muitas tentativas. Espere um pouco e tente de novo." });
  }
  var nova = req.body && req.body.newPassword || "";
  if(typeof nova !== "string" || nova.length < 8){
    return res.status(400).json({ error: "A nova senha precisa ter pelo menos 8 caracteres." });
  }
  var userId = await db.consumeResetToken(req.body && req.body.token);
  if(!userId) return res.status(400).json({ error: "Link inválido ou expirado. Peça um novo." });
  await db.updateUserPassword(userId, await bcrypt.hash(nova, 10));
  var user = await db.findUserById(userId);
  setSessionCookie(req, res, signSession(userId));
  res.json(Object.assign({ ok: true }, user ? userPublic(user) : {}));
}));

app.post("/api/auth/delete-account", requireAuth, h(async function(req, res){
  var senha = req.body && req.body.password || "";
  var ok = await bcrypt.compare(String(senha), req.user.passwordHash);
  if(!ok) return res.status(401).json({ error: "Senha incorreta." });
  await db.deleteUser(req.user.id);
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
}));

/* ---------- estado ---------- */

// por usuário (não por IP): é normal a mesma conta sincronizar de vários
// aparelhos ao mesmo tempo. A folga é generosa — o cliente já faz pull a
// cada ~25s e debounça o push em 900ms — só pra barrar automação
app.get("/api/state", requireAuth, h(async function(req, res){
  if(!(await db.rateLimit("state-get:" + req.user.id, 120, 5 * 60))){
    return res.status(429).json({ error: "Muitas sincronizações. Espere um pouco." });
  }
  var state = await db.loadState(req.user.id);
  res.json({ state: state });
}));

app.put("/api/state", requireAuth, h(async function(req, res){
  if(!(await db.rateLimit("state-put:" + req.user.id, 120, 5 * 60))){
    return res.status(429).json({ error: "Muitas sincronizações. Espere um pouco." });
  }
  var body = req.body;
  if(!body || typeof body !== "object" || Array.isArray(body)){
    return res.status(400).json({ error: "Corpo inválido." });
  }
  var size = Buffer.byteLength(JSON.stringify(body), "utf8");
  if(size > MAX_STATE_BYTES){
    console.warn("[state] PUT rejeitado (413) — usuário:", req.user.id, "tamanho:", size,
      "listas:", Array.isArray(body.lists) ? body.lists.length : "ausente");
    return res.status(413).json({ error: "Estado grande demais para sincronizar." });
  }
  await db.saveState(req.user.id, body);
  console.log("[state] salvo — usuário:", req.user.id, "tamanho:", size,
    "listas:", Array.isArray(body.lists) ? body.lists.length : "ausente",
    "itens:", Array.isArray(body.listItems) ? body.listItems.length : "ausente");
  res.json({ ok: true, updatedAt: Date.now() });
}));

app.use(function(req, res){
  res.status(404).json({ error: "não encontrado" });
});

module.exports = app;
