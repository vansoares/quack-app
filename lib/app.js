// lib/app.js — a mesma API de conta e sincronização, adaptada para
// serverless: sem app.listen() (o Vercel chama o handler por requisição),
// sem servir estáticos (o Vercel entrega public/ direto pela CDN), e com
// rate limit e armazenamento vivendo no Redis em vez de memória/disco local.

const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");
const mail = require("./mail");

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = "quack_session";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

// O Vercel Hobby limita o corpo de requisições a ~4.5MB; ficamos com folga
// abaixo disso. Para o tipo de dado guardado aqui (tarefas, hábitos, etc.)
// isso é muito espaço — mas vale saber que o teto existe.
const MAX_STATE_BYTES = 4 * 1024 * 1024;

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "4mb" }));
app.use(cookieParser());

app.use(function(req, res, next){
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
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

function setSessionCookie(res, token){
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
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
    var hash = bcrypt.hashSync(password, 10);
    var user = await db.createUser(email, hash);
    setSessionCookie(res, signSession(user.id));
    res.json({ email: user.email });
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
  if(!user) return invalido();

  var ok = await bcrypt.compare(String(password), user.passwordHash);
  if(!ok) return invalido();
  setSessionCookie(res, signSession(user.id));
  res.json({ email: user.email });
}));

app.post("/api/auth/logout", function(req, res){
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, function(req, res){
  res.json({ email: req.user.email });
});

app.post("/api/auth/change-password", requireAuth, h(async function(req, res){
  var atual = req.body && req.body.currentPassword || "";
  var nova = req.body && req.body.newPassword || "";
  if(typeof nova !== "string" || nova.length < 8){
    return res.status(400).json({ error: "A nova senha precisa ter pelo menos 8 caracteres." });
  }
  var ok = await bcrypt.compare(String(atual), req.user.passwordHash);
  if(!ok) return res.status(401).json({ error: "Senha atual incorreta." });
  await db.updateUserPassword(req.user.id, bcrypt.hashSync(nova, 10));
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
  await db.updateUserPassword(userId, bcrypt.hashSync(nova, 10));
  var user = await db.findUserById(userId);
  setSessionCookie(res, signSession(userId));
  res.json({ ok: true, email: user ? user.email : undefined });
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

app.get("/api/state", requireAuth, h(async function(req, res){
  var state = await db.loadState(req.user.id);
  res.json({ state: state });
}));

app.put("/api/state", requireAuth, h(async function(req, res){
  var body = req.body;
  if(!body || typeof body !== "object" || Array.isArray(body)){
    return res.status(400).json({ error: "Corpo inválido." });
  }
  var size = Buffer.byteLength(JSON.stringify(body), "utf8");
  if(size > MAX_STATE_BYTES){
    return res.status(413).json({ error: "Estado grande demais para sincronizar." });
  }
  await db.saveState(req.user.id, body);
  res.json({ ok: true, updatedAt: Date.now() });
}));

app.use(function(req, res){
  res.status(404).json({ error: "não encontrado" });
});

module.exports = app;
