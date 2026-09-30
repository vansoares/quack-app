// Testa o contrato de sincronização da API: revisão do servidor, conflito (409),
// cliente antigo sem If-Match e leitura de estado no formato legado.
// Rodar: npm test
const test = require("node:test");
const assert = require("node:assert");
const { createMockRedis } = require("./mock-redis");
const db = require("../lib/db");
const mock = createMockRedis();
db.__setClientForTests(mock);
process.env.JWT_SECRET = "teste-" + "x".repeat(40);
process.env.NODE_ENV = "development";
const app = require("../lib/app");

let server, base, cookie;

test.before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
  const res = await fetch(base + "/api/auth/signup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "a@teste.com", password: "senha-de-teste-1" })
  });
  assert.equal(res.status, 200);
  cookie = res.headers.get("set-cookie").split(";")[0];
});
test.after(() => server.close());

function get() { return fetch(base + "/api/state", { headers: { cookie } }).then(r => r.json()); }
function put(state, rev) {
  const headers = { "Content-Type": "application/json", cookie };
  if (rev != null) headers["If-Match"] = String(rev);
  return fetch(base + "/api/state", { method: "PUT", headers, body: JSON.stringify(state) });
}

test("conta nova: estado nulo e revisão 0", async () => {
  const r = await get();
  assert.equal(r.state, null);
  assert.equal(r.rev, 0);
});

test("gravar com a revisão certa incrementa a revisão", async () => {
  const res = await put({ tasks: [{ id: "t1", title: "a" }] }, 0);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).rev, 1);
  const r = await get();
  assert.equal(r.rev, 1);
  assert.equal(r.state.tasks[0].id, "t1");
});

test("revisão velha recebe 409 com o estado atual e não sobrescreve", async () => {
  await put({ tasks: [{ id: "t1" }, { id: "t2" }] }, 1);          // aparelho B grava (rev 2)
  const res = await put({ tasks: [{ id: "velho" }] }, 1);         // aparelho A ainda acha que é rev 1
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.rev, 2);
  assert.equal(body.state.tasks.length, 2);
  assert.equal((await get()).state.tasks.length, 2);              // nada foi perdido
});

test("cliente antigo (sem If-Match) continua gravando", async () => {
  const res = await put({ tasks: [] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).rev, 3);
});

test("estado fica comprimido no Redis e formato legado ainda é lido", async () => {
  const stored = mock._store["state:" + Object.keys(mock._store).find(k => k.startsWith("user:") && !k.startsWith("user:index")).slice(5)];
  assert.equal(stored.v, 2);
  assert.equal(typeof stored.gz, "string");
  const uid = Object.keys(mock._store).find(k => k.startsWith("user:")).slice(5);
  mock._store["state:" + uid] = { tasks: [{ id: "legado" }] };   // formato antigo: objeto puro
  const r = await get();
  assert.equal(r.rev, 0);
  assert.equal(r.state.tasks[0].id, "legado");
});

test("gravações simultâneas: só uma passa com a mesma revisão", async () => {
  const base0 = (await get()).rev;
  const [a, b] = await Promise.all([put({ tasks: [{ id: "A" }] }, base0), put({ tasks: [{ id: "B" }] }, base0)]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [200, 409]);
});
