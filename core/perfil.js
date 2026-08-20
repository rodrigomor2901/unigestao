"use strict";

// ============================================================================
// PERFIL E AGENDA
// ----------------------------------------------------------------------------
// Regras dos dados de contato: o que e obrigatorio, como se normaliza e como
// se compara na busca. Fica separado do server.js porque e regra de negocio —
// muda por decisao de gente, nao por mudanca de rota.
// ============================================================================

// A exigencia de preencher o perfil no proximo acesso fica DESLIGADA por
// padrao, e liga com EXIGIR_PERFIL=1.
//
// Nao e frescura de configuracao: 32 pessoas acabaram de receber acesso e
// varias ainda nem entraram. Se a primeira coisa que elas vissem fosse trocar
// a senha E preencher um formulario, o primeiro contato com o sistema — que e
// o que decide se ele parece facil ou chato — seria puro atrito. A exigencia
// entra depois que o Tarefas migrar e ninguem mais estiver estreando.
function exigindoPerfil() {
  return process.env.EXIGIR_PERFIL === "1";
}

const DEPARTAMENTOS_MIN = 2;
const CARGO_MIN = 2;

// Lista de partida dos departamentos.
//
// Ela existe porque campo livre puro produz "Comercial", "comercial" e "Com."
// na mesma agenda, e a busca por departamento deixa de funcionar. Mas nao e
// uma lista fechada: a tela oferece "Outro" e o que a pessoa digitar passa a
// aparecer para quem preencher depois. Assim a agenda se organiza sozinha sem
// travar quem nao se encaixa.
//
// Estes nomes sao um chute informado a partir dos sistemas do grupo — conferir
// com o RH e ajustar aqui e o certo a fazer.
const DEPARTAMENTOS = [
  "Comercial",
  "Operações",
  "Financeiro",
  "Recursos Humanos",
  "Departamento Pessoal",
  "Jurídico",
  "Tecnologia da Informação",
  "Diretoria",
  "Recepção",
  "Facilities",
  "Segurança",
  "Suprimentos",
  "Qualidade",
  "Segurança do Trabalho",
];

// Guarda so digitos e os separadores que as pessoas realmente usam. Sem isso
// o mesmo numero entra como "(19) 3212-0000", "1932120000" e "19 3212 0000",
// e a busca por telefone deixa de funcionar.
function limparTelefone(v) {
  return String(v || "").replace(/[^\d]/g, "");
}

// Ramal e curto e as vezes tem letra ("2010", "R-14"). So tira espaco extra.
function limparRamal(v) {
  return String(v || "").trim().replace(/\s+/g, " ").slice(0, 20);
}

function limparTexto(v, max) {
  return String(v || "").trim().replace(/\s+/g, " ").slice(0, max);
}

// Formata para leitura: (19) 3212-0000 / (19) 99999-0000.
// Numero que nao caiba nesses formatos volta como veio — melhor mostrar o que
// a pessoa digitou do que inventar uma formatacao errada.
function formatarTelefone(digitos) {
  const d = String(digitos || "");
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  return d;
}

// Valida o que veio da tela. Devolve {ok, erros[], valores}.
//
// A regra de contato e "pelo menos um": nem todo mundo tem celular corporativo,
// e para essas pessoas o ramal do PABX e a forma de contato de verdade. Exigir
// celular de quem nao tem so produziria campo preenchido com lixo.
function validar(entrada) {
  const erros = [];
  const telefone = limparTelefone(entrada.telefone);
  const ramal = limparRamal(entrada.ramal);
  const departamento = limparTexto(entrada.departamento, 60);
  const cargo = limparTexto(entrada.cargo, 60);

  if (!telefone && !ramal) {
    erros.push("Informe um telefone ou um ramal — se você não tem celular corporativo, o ramal do PABX serve.");
  }
  if (telefone && (telefone.length < 8 || telefone.length > 13)) {
    erros.push("O telefone não parece completo. Use DDD + número.");
  }
  if (departamento.length < DEPARTAMENTOS_MIN) {
    erros.push("Informe o departamento.");
  }
  if (cargo.length < CARGO_MIN) {
    erros.push("Informe o cargo.");
  }

  return {
    ok: erros.length === 0,
    erros,
    valores: { telefone, ramal, departamento, cargo },
  };
}

// O perfil esta completo? E o que decide se a pessoa e barrada quando a
// exigencia estiver ligada. A foto NAO entra: foi decisao explicita deixá-la
// opcional, porque nem todo mundo tem uma a mão e nao ter foto nao impede
// ninguem de ser encontrado na agenda.
function completo(u) {
  if (!u) return false;
  const temContato = Boolean((u.telefone || "").trim() || (u.ramal || "").trim());
  return Boolean(temContato && (u.departamento || "").trim() && (u.cargo || "").trim());
}

// Compara ignorando acento e maiuscula, para "Comercial", "comercial" e
// "COMERCIAL" caírem no mesmo lugar na busca da agenda.
function normalizar(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().trim();
}

// Limite do que o navegador pode mandar de foto. A tela ja reduz a imagem
// antes de enviar (ver public/perfil.html); isto e a rede de seguranca contra
// quem chamar a API direto.
const FOTO_MAX_BYTES = 400 * 1024;
const FOTO_TIPOS = ["image/jpeg", "image/png", "image/webp"];

module.exports = {
  exigindoPerfil, validar, completo, normalizar, DEPARTAMENTOS,
  limparTelefone, limparRamal, limparTexto, formatarTelefone,
  FOTO_MAX_BYTES, FOTO_TIPOS,
};
