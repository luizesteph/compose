// Lista de espera: a consulta-base ainda existe?
//
// A lista de espera ANTECIPA uma consulta que o paciente já tem. Se a equipe cancela ou
// apaga essa consulta, a entrada perde o sentido — e até 16/11/2026 ninguém percebia: a
// Isabella (plano não atendido, consulta desmarcada pela atendente em 10/11) recebeu uma
// vaga no mesmo dia e dois avisos de "Sua consulta marcada segue garantida", o último
// depois de escrever "para de me mandar mensagem".
//
// Fonte: GET /attendances?start_date=&end_date=&status=ALL da API do robô. Uma leitura
// cobre todos os médicos e traz também as canceladas (medido em 16/11: um mês = 372 linhas,
// 345 KB, 1 s). Consulta APAGADA some da lista; cancelada vem com canceled=true.
//
// Regra de segurança: só tira da fila quem a agenda permite reconhecer. Telefone sozinho não
// basta para dizer que a consulta sumiu (o celular do cadastro do Amigo pode ser outro) —
// precisa do número do paciente no Amigo ou do nome completo que o site gravou.

import { chaveDoTelefone } from "./confirmacao.ts";
import { nomeChave } from "./liberados.ts";

export interface AtendimentoDaAgenda {
  patient?: { id?: unknown; name?: unknown; contact_cellphone?: unknown } | null;
  patient_id?: unknown;
  user?: { id?: unknown } | null;
  user_id?: unknown;
  start_date?: unknown;
  status?: unknown;
  canceled?: unknown;
}

export interface EntradaDaFila {
  doctor_id: string;
  /** data da consulta-base (AAAA-MM-DD) */
  requested_date: string;
  phone: string;
  /** números do paciente no Amigo que sabemos ser desta pessoa (marcação pelo WhatsApp ou pelo site) */
  pacientesConhecidos: string[];
  /** nome completo gravado pelo site na marcação */
  nomeCompleto: string | null;
}

export type SituacaoDaBase =
  | { tipo: "ativa" }
  | { tipo: "mudou"; novaData: string }
  | { tipo: "cancelada"; como: "cancelada" | "sumiu" }
  | { tipo: "nao_sei"; motivo: string };

/** Quantos dias à frente a leitura cobre. A API recusa janela de mais de 90 dias. */
export const AGENDA_DA_FILA_DIAS = 85;

const diaDe = (a: AtendimentoDaAgenda) => String(a.start_date ?? "").slice(0, 10);
const medicoDe = (a: AtendimentoDaAgenda) => String(a.user?.id ?? a.user_id ?? "");
const pacienteDe = (a: AtendimentoDaAgenda) => String(a.patient?.id ?? a.patient_id ?? "");

/** O Amigo marca cancelamento de quatro jeitos (regra do CLAUDE.md) */
export function atendimentoCancelado(a: AtendimentoDaAgenda): boolean {
  const st = String(a.status ?? "").toLowerCase();
  return st === "canceled" || st === "cancelled" || st === "cancelado" || a.canceled === true || a.canceled === "true";
}

/** "Agendamento via widget: NOME com MÉDICO em DATA" → NOME (a linha que o site grava) */
export function nomeDaLinhaDoSite(texto: unknown): string | null {
  const m = String(texto ?? "").match(/^Agendamento via widget:\s*(.+?)\s+com\s+.+\s+em\s+\d{4}-\d{2}-\d{2}/);
  if (!m) return null;
  const nome = m[1].trim();
  return nome && nome !== "Paciente" ? nome : null;
}

export function situacaoDaBase(e: EntradaDaFila, agenda: AtendimentoDaAgenda[], hojeISO: string): SituacaoDaBase {
  const base = String(e.requested_date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return { tipo: "nao_sei", motivo: "sem data da consulta" };

  const doMedico = (agenda || []).filter((a) => medicoDe(a) === String(e.doctor_id));
  // O dia tem de trazer ALGUÉM do médico: dia vazio é leitura incompleta ou fora da janela,
  // nunca prova de que a consulta sumiu.
  if (!doMedico.some((a) => diaDe(a) === base)) return { tipo: "nao_sei", motivo: "agenda do dia sem o médico" };

  const chave = chaveDoTelefone(e.phone);
  const nome = nomeChave(e.nomeCompleto);
  const nomeForte = nome.split(" ").filter(Boolean).length >= 2;
  const ids = new Set((e.pacientesConhecidos || []).map(String).filter(Boolean));

  const ehDaPessoa = (a: AtendimentoDaAgenda) =>
    (ids.size > 0 && ids.has(pacienteDe(a))) ||
    (!!chave && chaveDoTelefone(a.patient?.contact_cellphone) === chave) ||
    (nomeForte && nomeChave(a.patient?.name) === nome);

  const daPessoa = doMedico.filter(ehDaPessoa);
  const naBase = daPessoa.filter((a) => diaDe(a) === base);
  if (naBase.some((a) => !atendimentoCancelado(a))) return { tipo: "ativa" };

  // Sem linha no dia, só afirmo que sumiu se tenho como reconhecer a pessoa na agenda.
  const reconhecida = naBase.length > 0 || ids.size > 0 || nomeForte;
  if (!reconhecida) return { tipo: "nao_sei", motivo: "não reconheço o paciente na agenda" };

  // A equipe pode ter só mudado a data: outra consulta ativa com o mesmo médico, de hoje em diante.
  const outras = daPessoa
    .filter((a) => !atendimentoCancelado(a) && diaDe(a) >= hojeISO && diaDe(a) !== base)
    .map(diaDe)
    .sort();
  if (outras.length > 0) return { tipo: "mudou", novaData: outras[0] };

  return { tipo: "cancelada", como: naBase.length > 0 ? "cancelada" : "sumiu" };
}
