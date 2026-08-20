// api/[...all].js — ponto de entrada que o Vercel invoca.
//
// O nome do arquivo usa a sintaxe de rota "catch-all" do Vercel: qualquer
// caminho sob /api/* (ex.: /api/auth/login, /api/state) cai aqui. Um app
// Express é, ele mesmo, uma função (req, res) => void — então basta
// exportá-lo; não precisa de nenhum adaptador extra.
module.exports = require("../lib/app");
