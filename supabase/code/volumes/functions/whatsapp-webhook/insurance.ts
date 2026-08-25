// Convênio: leitura, validação e resolução do plano do paciente.
//
// RELATO DO DONO (04/08): "quando você está gravando a consulta, está ficando na
// agenda sempre particular, e deveria ser já o convênio."
//
// MEDIDO NO BANCO antes de escrever este módulo:
//   • 75 agendamentos com auditoria: 63 gravados como "particular" (84%).
//   • Os 12 que levaram convênio usaram SÓ DOIS ids: 115117 e 118455 — que são
//     exatamente os dois convênios mais frequentes do cache `local_patients`
//     (SUL AMERICA e BRADESCO SAUDE). Nenhum id fora do cache jamais apareceu.
//     Ou seja: o convênio NUNCA veio da Amigo, só do nosso próprio cache.
//   • `local_patients`: 1276 pacientes, só 42 com convênio — os 42 que nós
//     mesmos cadastramos. De paciente já existente nunca lemos o convênio.
//   • 41 telefones têm mais de uma linha no cache; em 30 deles uma linha tem
//     convênio e outra não (o `limit 1` por telefone derruba o convênio), e em
//     7 as linhas são de PACIENTES DIFERENTES (parentes no mesmo telefone) —
//     buscar convênio por telefone pode faturar no plano do parente errado.
//
// Daí as três peças aqui:
//   1. readPatientInsurance — lê o cadastro da Amigo tolerando o formato real
//      (o sandbox não alcança a API; o leitor cobre as formas plausíveis e o
//      describeInsuranceShape grava QUAIS chaves vieram, só nomes, nunca valores).
//   2. isNegativeInsuranceClaim — "particular"/"reembolso" nunca viram id.
//   3. pickPlanFromGroup / matchInsuranceGroup — `insurances` devolve GRUPOS e
//      `insurances/plans/{grupo}` devolve PLANOS; o attendance quer um PLANO.
//      São espaços de id diferentes: mandar id de grupo fatura errado.

export type InsuranceRead = { id: string | null; source: string };

/** Só aceita id positivo inteiro (number ou string numérica). "none"/""/0 → null. */
export function toInsuranceId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? String(Math.trunc(value)) : null;
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!/^\d+$/.test(t)) return null;
    return Number(t) > 0 ? String(Number(t)) : null;
  }
  return null;
}

const WRAPPER_KEYS = ["data", "patient", "paciente", "result", "record"];

/** Descasca `{data:{...}}`, `{patient:{...}}` e arrays até achar o objeto do paciente. */
export function unwrapPatient(raw: unknown): Record<string, unknown> | null {
  let cur: unknown = raw;
  for (let depth = 0; depth < 5; depth++) {
    if (Array.isArray(cur)) {
      cur = cur.length > 0 ? cur[0] : null;
      continue;
    }
    if (!cur || typeof cur !== "object") return null;
    const obj = cur as Record<string, unknown>;
    // Parece o próprio paciente? Para aqui.
    if ("cpf" in obj || "name" in obj || "nome" in obj || "born" in obj) return obj;
    const wrapper = WRAPPER_KEYS.find((k) => k in obj && obj[k] !== null && typeof obj[k] === "object");
    if (!wrapper) return obj;
    cur = obj[wrapper];
  }
  return null;
}

// Ordem de preferência: quanto mais específico o nome da chave, mais confiável.
const DIRECT_KEYS = [
  "insurance_id",
  "insuranceId",
  "insurance_plan_id",
  "insurancePlanId",
  "health_insurance_id",
  "healthInsuranceId",
  "convenio_id",
  "convenioId",
  "agreement_id",
  "agreementId",
  "plan_id",
  "planId",
];

const NESTED_KEYS = [
  "insurance",
  "insurance_plan",
  "insurancePlan",
  "health_insurance",
  "healthInsurance",
  "convenio",
  "agreement",
  "plan",
];

const NESTED_ID_KEYS = ["id", "insurance_id", "plan_id", "insurance_plan_id"];

/**
 * Lê o convênio do cadastro do paciente tolerando o formato.
 * Devolve o id e QUAL chave o forneceu (vai pra auditoria em ai_entities).
 */
export function readPatientInsurance(raw: unknown): InsuranceRead {
  const p = unwrapPatient(raw);
  if (!p) return { id: null, source: "sem_cadastro" };

  for (const k of DIRECT_KEYS) {
    if (k in p) {
      const id = toInsuranceId(p[k]);
      if (id) return { id, source: k };
    }
  }

  for (const k of NESTED_KEYS) {
    const v = p[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = v as Record<string, unknown>;
      for (const idKey of NESTED_ID_KEYS) {
        const id = toInsuranceId(inner[idKey]);
        if (id) return { id, source: `${k}.${idKey}` };
      }
    }
  }

  // Varredura genérica: qualquer chave que cheire a convênio e traga um id.
  // Nome/carteirinha/validade NUNCA entram (não são id) — o toInsuranceId barra.
  for (const k of Object.keys(p)) {
    if (!/insur|conven|agreement/i.test(k)) continue;
    if (/name|nome|number|numero|card|carteir|valid|expir|holder|titular/i.test(k)) continue;
    const v = p[k];
    const direct = toInsuranceId(v);
    if (direct) return { id: direct, source: k };
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = v as Record<string, unknown>;
      for (const idKey of NESTED_ID_KEYS) {
        const id = toInsuranceId(inner[idKey]);
        if (id) return { id, source: `${k}.${idKey}` };
      }
    }
  }

  return { id: null, source: "sem_convenio_no_cadastro" };
}

/**
 * Auditoria do formato: SÓ NOMES DE CHAVE, nunca valores — o registro vai parar
 * em `ai_entities` e não pode carregar dado sensível de paciente.
 */
export function describeInsuranceShape(raw: unknown): string {
  const p = unwrapPatient(raw);
  if (!p) return "sem_objeto";
  const keys = Object.keys(p);
  const relevant = keys.filter((k) => /insur|conven|plan|agreement|carteir/i.test(k));
  const nested = relevant
    .filter((k) => p[k] && typeof p[k] === "object" && !Array.isArray(p[k]))
    .map((k) => `${k}{${Object.keys(p[k] as Record<string, unknown>).join(",")}}`);
  return `chaves=${keys.length} relev=[${relevant.join(",")}] ${nested.join(" ")}`.trim().slice(0, 300);
}

// "particular", "reembolso", "não tenho convênio" — o paciente está dizendo que
// NÃO tem plano. Isso jamais pode virar um id, e jamais pode ser tratado como
// "convênio desconhecido" (que bloqueava o agendamento com uma lista de planos —
// aconteceu em produção: paciente escreveu "particular" e a Julia respondeu que o
// convênio "particular" não estava na lista de atendimento).
const NEGATIVE_CLAIM_RE =
  /\b(particular|reembolso|reembolsar|sem\s+conv[êe]nio|sem\s+plano|n[ãa]o\s+tenho\s+(conv[êe]nio|plano)|pagar\s+(do\s+bolso|particular)|priv(ado|ada))\b/i;

export function isNegativeInsuranceClaim(text: string): boolean {
  if (!text) return false;
  const t = String(text).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return NEGATIVE_CLAIM_RE.test(t) || NEGATIVE_CLAIM_RE.test(String(text));
}

/**
 * A API rejeitou o convênio? Mesma detecção já provada no booking-widget
 * (code "001" / mensagem citando convênio). Serve para reenviar sem o
 * insurance_id em vez de perder o agendamento inteiro.
 */
export function isInsuranceRejection(status: number, data: unknown): boolean {
  if (status < 400) return false;
  const body = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (String(body.code || "") === "001") return true;
  const msg = String(body.message || body.error || "").toLowerCase();
  return msg.includes("convênio") || msg.includes("convenio") || msg.includes("insurance");
}

function normalizeName(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sem acento, sem espaço, sem pontuação: "SulAmérica" e "SUL AMERICA" viram o mesmo. */
function squashName(s: unknown): string {
  return normalizeName(s).replace(/[^a-z0-9]/g, "");
}

/**
 * Casa o que o paciente disse com a lista OFICIAL de grupos (`insurances`).
 * O paciente costuma dizer o plano inteiro ("SulAmérica plano especial 100"),
 * então o grupo ("SUL AMERICA") aparece como prefixo do que ele falou — mas
 * escrito à maneira dele. Por isso a comparação também é feita sem espaços:
 * "sulamerica…" não continha "sul america" e o convênio se perdia.
 */
export function matchInsuranceGroup(
  claim: string,
  groups: Array<Record<string, unknown>>,
): Record<string, unknown> | null {
  const c = normalizeName(claim);
  const cs = squashName(claim);
  if (!c || !Array.isArray(groups)) return null;
  let best: Record<string, unknown> | null = null;
  let bestLen = 0;
  for (const g of groups) {
    const n = normalizeName(g.name ?? g.nome);
    const ns = squashName(g.name ?? g.nome);
    if (!n) continue;
    if (n === c || (ns.length >= 4 && ns === cs)) return g;
    const hit =
      (c.length >= 4 && n.includes(c)) ||
      (n.length >= 4 && c.includes(n)) ||
      (cs.length >= 4 && ns.includes(cs)) ||
      (ns.length >= 4 && cs.includes(ns));
    // Empate ("SUL AMERICA" x "SUL AMERICA SAUDE"): fica com o nome mais longo,
    // que é o mais específico.
    if (hit && n.length > bestLen) {
      best = g;
      bestLen = n.length;
    }
  }
  return best;
}

/**
 * Dentro dos planos de um grupo, escolhe o que o paciente descreveu.
 * Sem pista, devolve o primeiro — a mesma regra que o cadastro já usa.
 */
export function pickPlanFromGroup(
  plans: unknown,
  claim?: string,
): { id: string; name: string } | null {
  const list = Array.isArray(plans) ? (plans as Array<Record<string, unknown>>) : [];
  const valid = list.filter((p) => toInsuranceId(p?.id));
  if (valid.length === 0) return null;

  const c = normalizeName(claim || "");
  if (c) {
    let best: Record<string, unknown> | null = null;
    let bestLen = 0;
    for (const p of valid) {
      const n = normalizeName(p.name ?? p.nome);
      if (!n) continue;
      if (n === c) {
        best = p;
        break;
      }
      if (n.length >= 3 && c.includes(n) && n.length > bestLen) {
        best = p;
        bestLen = n.length;
      }
    }
    if (best) {
      return { id: toInsuranceId(best.id) as string, name: String(best.name ?? best.nome ?? "") };
    }
  }
  const first = valid[0];
  return { id: toInsuranceId(first.id) as string, name: String(first.name ?? first.nome ?? "") };
}
