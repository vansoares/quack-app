// lib/db.js — armazenamento em Redis (Upstash), para rodar em serverless.
//
// Por que não arquivos, como na versão para VPS/Render: funções serverless
// do Vercel não têm disco persistente entre chamadas — cada requisição pode
// cair num container novo, e qualquer coisa escrita em disco local
// simplesmente some. Precisa de algo externo à função. Redis via Upstash é
// o caminho mais simples: sem servidor para administrar, sem schema para
// migrar, e o modelo de dados daqui (um documento por usuário) cai bem
// numa estrutura chave-valor.
//
// O cliente é injetável (getClient/__setClientForTests) para permitir testar
// toda a lógica de negócio sem precisar de uma conta Upstash real.

const crypto = require("crypto");

let _client = null;
function getClient(){
  if(_client) return _client;
  var Redis = require("@upstash/redis").Redis;
  _client = Redis.fromEnv();  // lê UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
  return _client;
}

// só para os testes deste projeto: injeta um cliente falso com a mesma forma
function __setClientForTests(mock){ _client = mock; }

function userKey(id){ return "user:" + id; }
function emailKey(email){ return "email:" + String(email).trim().toLowerCase(); }
function usernameKey(username){ return "username:" + String(username).trim().toLowerCase(); }
function stateKey(id){ return "state:" + id; }
function resetKey(token){ return "reset:" + token; }
const USERS_INDEX_KEY = "users:index";
const FEATURE_DEFS_KEY = "flags:defs";

async function findUserByEmail(email){
  var kv = getClient();
  var k = String(email || "").trim().toLowerCase();
  if(!k) return null;
  var id = await kv.get(emailKey(k));
  if(!id) return null;
  return findUserById(id);
}

async function findUserById(id){
  var kv = getClient();
  var u = await kv.get(userKey(id));
  return u || null;
}

// passwordHash é null para conta criada só pelo login com Google — quem
// nunca definiu senha não tem como logar pelo formulário de e-mail/senha
// (ver checagem em /api/auth/login)
async function createUser(email, passwordHash, googleId){
  var kv = getClient();
  var k = String(email).trim().toLowerCase();
  var id = crypto.randomBytes(12).toString("hex");
  var user = { id: id, email: k, passwordHash: passwordHash || null, createdAt: Date.now() };
  if(googleId) user.googleId = googleId;

  // NX: só grava se a chave não existir ainda — evita duas contas com o
  // mesmo e-mail em cadastros simultâneos (condição de corrida)
  var claimed = await kv.set(emailKey(k), id, { nx: true });
  if(!claimed) throw new Error("EMAIL_EM_USO");

  await kv.set(userKey(id), user);
  await kv.sadd(USERS_INDEX_KEY, id);
  return user;
}

// grava o id do Google na primeira vez que uma conta existente (criada por
// e-mail/senha) faz login pelo Google com o mesmo endereço — só por
// rastreio, a busca do usuário continua sendo por e-mail
async function setGoogleId(id, googleId){
  var kv = getClient();
  var u = await kv.get(userKey(id));
  if(!u || u.googleId === googleId) return;
  u.googleId = googleId;
  await kv.set(userKey(id), u);
}

async function findUserByUsername(username){
  var kv = getClient();
  var k = String(username || "").trim().toLowerCase();
  if(!k) return null;
  var id = await kv.get(usernameKey(k));
  if(!id) return null;
  return findUserById(id);
}

// unicidade pelo mesmo truque do e-mail (NX), com o cuidado extra de liberar
// o nome antigo quando a pessoa está trocando por outro, não reservando o
// primeiro
async function setUsername(id, username){
  var kv = getClient();
  var u = await kv.get(userKey(id));
  if(!u) return false;
  var novo = String(username).trim().toLowerCase();
  if(!u.username || u.username !== novo){
    var claimed = await kv.set(usernameKey(novo), id, { nx: true });
    if(!claimed) throw new Error("USERNAME_EM_USO");
    if(u.username) await kv.del(usernameKey(u.username));
  }
  u.username = novo;
  await kv.set(userKey(id), u);
  return true;
}

async function updateUserPassword(id, passwordHash){
  var kv = getClient();
  var u = await kv.get(userKey(id));
  if(!u) return false;
  u.passwordHash = passwordHash;
  await kv.set(userKey(id), u);
  return true;
}

// token de uso único para "esqueci minha senha" — expira sozinho em 1h no Redis,
// então não precisa de limpeza manual nem guarda estado além do necessário
async function createResetToken(userId){
  var kv = getClient();
  var token = crypto.randomBytes(24).toString("hex");
  await kv.set(resetKey(token), userId, { ex: 3600 });
  return token;
}

async function consumeResetToken(token){
  var kv = getClient();
  var k = resetKey(String(token || ""));
  var userId = await kv.get(k);
  if(!userId) return null;
  await kv.del(k); // uso único: some assim que é gasto, mesmo que a troca de senha falhe depois
  return userId;
}

async function deleteUser(id){
  var kv = getClient();
  var u = await kv.get(userKey(id));
  if(u){
    await kv.del(emailKey(u.email));
    if(u.username) await kv.del(usernameKey(u.username));
  }
  await kv.del(userKey(id));
  await kv.del(stateKey(id));
  await kv.srem(USERS_INDEX_KEY, id);
}

// para a página de administração: todo mundo que já criou conta, do mais
// antigo pro mais novo. Não é paginado — o público-alvo deste app é pequeno
// o bastante pra isso nunca ser um problema real.
async function listUsers(){
  var kv = getClient();
  var ids = await kv.smembers(USERS_INDEX_KEY);
  if(!ids || !ids.length) return [];
  var users = await Promise.all(ids.map(findUserById));
  return users.filter(Boolean).sort(function(a, b){ return (a.createdAt || 0) - (b.createdAt || 0); });
}

/* ---------- features (liberadas por usuário, via página de admin) ---------- */

function validFeatureKey(k){
  return typeof k === "string" && /^[a-z0-9_-]{2,40}$/.test(k);
}

async function listFeatureDefs(){
  var kv = getClient();
  var defs = await kv.get(FEATURE_DEFS_KEY);
  return defs || [];
}

async function addFeatureDef(key, label){
  if(!validFeatureKey(key)) throw new Error("CHAVE_INVALIDA");
  var kv = getClient();
  var defs = await listFeatureDefs();
  if(defs.some(function(d){ return d.key === key; })) throw new Error("FEATURE_EXISTENTE");
  defs.push({ key: key, label: String(label || key).slice(0, 80), createdAt: Date.now() });
  await kv.set(FEATURE_DEFS_KEY, defs);
  return defs;
}

async function removeFeatureDef(key){
  var kv = getClient();
  var defs = await listFeatureDefs();
  var next = defs.filter(function(d){ return d.key !== key; });
  await kv.set(FEATURE_DEFS_KEY, next);
  return next;
}

// liga/desliga uma feature para um usuário específico. Sem entrada = desligada
// (a lista de usuários com a feature ligada é que fica curta, não o contrário)
async function setUserFeature(userId, key, enabled){
  if(!validFeatureKey(key)) throw new Error("CHAVE_INVALIDA");
  var kv = getClient();
  var u = await kv.get(userKey(userId));
  if(!u) return false;
  u.features = u.features || {};
  if(enabled) u.features[key] = true;
  else delete u.features[key];
  await kv.set(userKey(userId), u);
  return true;
}

async function loadState(userId){
  var kv = getClient();
  var s = await kv.get(stateKey(userId));
  return s || null;
}

async function saveState(userId, state){
  var kv = getClient();
  await kv.set(stateKey(userId), state);
}

// limitador de tentativas com INCR + EXPIRE atômicos — funciona corretamente
// entre instâncias serverless diferentes, ao contrário de um contador em
// memória (que reseta a cada cold start e não é compartilhado entre
// invocações concorrentes)
async function rateLimit(key, max, windowSeconds){
  var kv = getClient();
  var count = await kv.incr("rl:" + key);
  if(count === 1) await kv.expire("rl:" + key, windowSeconds);
  return count <= max;
}

module.exports = {
  findUserByEmail, findUserById, findUserByUsername, createUser, updateUserPassword, deleteUser,
  setUsername, setGoogleId, listUsers,
  listFeatureDefs, addFeatureDef, removeFeatureDef, setUserFeature,
  createResetToken, consumeResetToken,
  loadState, saveState, rateLimit, __setClientForTests
};
