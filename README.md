# Quack no Vercel

Mesmo app do pacote `quack-server`, adaptado para rodar como funções
serverless no Vercel. Se você quiser hospedar num VPS, Render ou Railway em
vez disso, use o pacote `quack-server` — lá o armazenamento é em arquivo
local, mais simples quando existe um disco persistente disponível.

## Por que isto é um pacote separado, e não o mesmo código

Funções serverless não têm disco persistente entre chamadas: cada
requisição pode cair num container novo, e qualquer coisa escrita em disco
local desaparece. A versão para VPS grava um arquivo JSON por usuário —
isso não sobrevive no Vercel. Aqui, o mesmo modelo de dados (um documento
por usuário) vive em Redis via [Upstash](https://upstash.com), que o
próprio Vercel oferece como integração de um clique.

Tudo mais é idêntico: mesma interface, mesmas rotas, mesma lógica de
autenticação e sincronização.

## Estrutura

```
quack-vercel/
├── api/
│   └── [...all].js   # ponto de entrada: o Vercel roteia todo /api/* para cá
├── lib/
│   ├── app.js         # a API (Express) — rotas de conta e de estado
│   └── db.js           # leitura/escrita no Redis (Upstash)
├── index.html          # o app inteiro, servido direto pela CDN do Vercel
├── vercel.json          # roteamento explícito
├── test/                # harness para testar localmente sem depender do Vercel
└── package.json
```

## Deploy

1. **Suba esta pasta para um repositório no GitHub.**

2. **Em [vercel.com](https://vercel.com), importe o repositório**
   (New Project → escolha o repositório → Deploy). Não precisa mexer em
   build settings — o Vercel detecta o `/api` sozinho.

3. **Adicione um banco Redis.** No projeto criado, vá em **Storage → Create
   Database**, escolha **Upstash** (categoria Redis) — tem plano gratuito.
   Ao conectar, o Vercel preenche sozinho as variáveis `UPSTASH_REDIS_REST_URL`
   e `UPSTASH_REDIS_REST_TOKEN` no seu projeto.

4. **Defina o `JWT_SECRET`.** Em **Settings → Environment Variables**,
   adicione `JWT_SECRET` com o valor de:
   ```bash
   openssl rand -hex 32
   ```
   Sem isso, todas as rotas de conta retornam erro (de propósito — o
   servidor nunca inventa um segredo sozinho).

5. **Redeploy** (Settings → Deployments → ⋯ → Redeploy), para a função
   pegar as variáveis novas.

Pronto — sua URL sai em algo como `https://seu-projeto.vercel.app`, e já dá
para criar conta e sincronizar entre aparelhos.

## Rodar localmente

Duas formas:

**Com a CLI do Vercel** (mais fiel ao ambiente real):
```bash
npm i -g vercel
vercel link          # conecta esta pasta ao projeto criado no passo anterior
vercel env pull .env.local
vercel dev
```

**Sem depender do Vercel** (útil para desenvolver offline, ou testar antes
de ter uma conta Upstash): o projeto inclui um servidor de teste com um
Redis falso em memória.
```bash
npm install
node test/local-server.js
```
Abre em `http://localhost:4020`. Os dados somem quando o processo para —
serve só para testar o fluxo, não para uso de verdade.

## Login com Google (opcional)

O botão "Continuar com Google" só aparece funcional se essas variáveis
estiverem configuradas — sem elas, a rota responde com erro claro em vez
de travar silenciosamente. Passo a passo:

1. Em [console.cloud.google.com](https://console.cloud.google.com), crie um
   projeto (ou use um existente).
2. **APIs e serviços → Tela de consentimento OAuth**: tipo "Externo",
   preencha nome do app e e-mail de suporte. Pode ficar em modo "Teste"
   para uso pessoal — nesse modo, só e-mails cadastrados como testador
   conseguem logar; para liberar geral, publique o app depois.
3. **Credenciais → Criar credenciais → ID do cliente OAuth**, tipo
   "Aplicativo da Web".
4. Em **URIs de redirecionamento autorizados**, adicione:
   - `https://seu-projeto.vercel.app/api/auth/google/callback` (produção —
     troque pelo domínio real do seu deploy)
   - `http://localhost:4020/api/auth/google/callback` (se for testar local
     com `node test/local-server.js`)
5. Copie o **Client ID** e o **Client Secret** gerados.
6. No Vercel, em **Settings → Environment Variables**, adicione as duas
   variáveis abaixo e redeploy.

## Variáveis de ambiente

| Variável | Obrigatória | De onde vem |
|---|---|---|
| `JWT_SECRET` | sim | Você define manualmente (`openssl rand -hex 32`) |
| `UPSTASH_REDIS_REST_URL` | sim | Preenchida automaticamente ao conectar a integração Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | sim | Idem |
| `RESEND_API_KEY` | sim, para "esqueci minha senha" | Conta grátis em [resend.com](https://resend.com) → API Keys |
| `RESEND_FROM` | não | Remetente dos e-mails de redefinição. Sem domínio verificado na Resend, só chega ao e-mail da própria conta Resend — para atender qualquer pessoa, verifique um domínio em resend.com/domains |
| `GOOGLE_CLIENT_ID` | não, só para login com Google | Google Cloud Console → Credenciais (ver seção acima) |
| `GOOGLE_CLIENT_SECRET` | não, só para login com Google | Idem |

## Limites do plano gratuito que valem saber

- **Corpo da requisição**: o Vercel Hobby limita a uns 4,5MB por requisição;
  o servidor já recusa (HTTP 413) qualquer sincronização acima de 4MB, com
  folga. Para o volume de dados de um app pessoal (tarefas, hábitos,
  sessões), isso é bem mais espaço do que qualquer pessoa costuma usar.
- **Upstash gratuito**: tem teto de comandos por dia. Para uma pessoa
  sincronizando entre alguns aparelhos, o plano gratuito aguenta numa boa;
  se um dia passar disso, o próprio Vercel avisa e o upgrade é de um clique.
- **Rate limit de tentativas de login/cadastro** agora vive no Redis (em
  vez de memória do processo), porque memória de uma função serverless não
  é compartilhada entre invocações — de propósito, para o limite continuar
  funcionando de verdade mesmo com cold starts.

## O que é igual à versão para VPS

Login, cadastro, troca de senha, exclusão de conta, sincronização entre
abas e entre aparelhos, o aviso ao logar numa conta diferente com dados
locais no navegador — tudo isso é o mesmo código de frontend, sem
diferença de comportamento para quem usa.
