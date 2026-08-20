// Sobe o mesmo app Express (lib/app.js) num servidor HTTP local de verdade,
// só para testar via curl/Playwright — não é usado em produção no Vercel
// (lá quem invoca a função é a própria plataforma).
const { createMockRedis } = require("./mock-redis");
const db = require("../lib/db");
db.__setClientForTests(createMockRedis());

process.env.JWT_SECRET = process.env.JWT_SECRET || require("crypto").randomBytes(32).toString("hex");
process.env.NODE_ENV = "development"; // cookie sem "secure", já que o teste é em http local

const express = require("express");
const path = require("path");
const apiApp = require("../lib/app");

const top = express();
top.use(express.static(path.join(__dirname, "..")));
top.use(apiApp);

const PORT = process.env.PORT || 4020;
top.listen(PORT, () => console.log("teste local do app Vercel em http://localhost:" + PORT));
