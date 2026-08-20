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
function stateKey(id){ return "state:" + id; }

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

async function createUser(email, passwordHash){
  var kv = getClient();
  var k = String(email).trim().toLowerCase();
  var id = crypto.randomBytes(12).toString("hex");
  var user = { id: id, email: k, passwordHash: passwordHash, createdAt: Date.now() };

  // NX: só grava se a chave não existir ainda — evita duas contas com o
  // mesmo e-mail em cadastros simultâneos (condição de corrida)
  var claimed = await kv.set(emailKey(k), id, { nx: true });
  if(!claimed) throw new Error("EMAIL_EM_USO");

  await kv.set(userKey(id), user);
  return user;
}

async function updateUserPassword(id, passwordHash){
  var kv = getClient();
  var u = await kv.get(userKey(id));
  if(!u) return false;
  u.passwordHash = passwordHash;
  await kv.set(userKey(id), u);
  return true;
}

async function deleteUser(id){
  var kv = getClient();
  var u = await kv.get(userKey(id));
  if(u) await kv.del(emailKey(u.email));
  await kv.del(userKey(id));
  await kv.del(stateKey(id));
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
  findUserByEmail, findUserById, createUser, updateUserPassword, deleteUser,
  loadState, saveState, rateLimit, __setClientForTests
};
