// lib/mail.js — envio de e-mail transacional via Resend (API HTTP direta,
// sem SDK — o runtime do Vercel já traz fetch global).
//
// Por que Resend: tem plano gratuito e não exige verificar domínio próprio
// para começar — sem domínio verificado, dá para mandar e-mail só para o
// endereço com o qual você criou a conta na Resend, o que já cobre o uso
// pessoal deste app. Para atender qualquer destinatário, verifique um
// domínio em resend.com/domains e aponte RESEND_FROM para um remetente
// desse domínio.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "Quack <onboarding@resend.dev>";

function ensureMailConfig(){
  if(!RESEND_API_KEY){
    throw new Error(
      "RESEND_API_KEY não configurado nas variáveis de ambiente do projeto. " +
      "Crie uma conta grátis em resend.com, gere uma API key e defina RESEND_API_KEY."
    );
  }
}

async function sendMail(to, subject, html){
  ensureMailConfig();
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject: subject, html: html })
  });
  if(!res.ok){
    var body = await res.text().catch(function(){ return ""; });
    throw new Error("Falha ao enviar e-mail (" + res.status + "): " + body.slice(0, 300));
  }
}

module.exports = { sendMail };
