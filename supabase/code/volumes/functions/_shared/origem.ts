// Origem da marcação: o que o SERVIDOR do site grava em webhook_messages.booking_source.
//
// "widget" (sem UTM) ou "widget_<utm_source>" — julia, site, anuncio, maps… (ver
// origemDoAgendamento, booking-widget). Em 09/11/2026 a página do site passou a mandar a
// origem em todo agendamento, e de 10 a 15/11 nenhuma marcação chegou como "widget" puro:
// vieram "widget_site", "widget_anuncio" e "widget_maps". Quem comparava com a lista fixa
// "widget" e "widget_julia" deixou de reconhecer a marcação pelo site, sem erro nenhum —
// a liberação de data e hora na antialucinação, o "convênio logo depois de marcar", o
// fechamento da ficha depois do "obrigada", o lembrete do link e a contagem do painel.
//
// Regra: ninguém compara booking_source com um nome. Pergunta aqui.
// (src/test/origem-do-site.test.ts varre o código e acusa comparação com nome fixo.)

/** Foi o site que gravou esta linha? Vale para qualquer origem que o site inventar depois. */
export function ehOrigemDoSite(origem: unknown): boolean {
  return /^widget(_[a-z0-9_-]{1,24})?$/.test(String(origem ?? ""));
}

/** Para `.like("booking_source", FILTRO_ORIGEM_DO_SITE)` */
export const FILTRO_ORIGEM_DO_SITE = "widget%";

/** Para dentro de um `.or("…")` do PostgREST, onde o curinga é `*` */
export const FILTRO_ORIGEM_DO_SITE_NO_OR = "booking_source.like.widget*";
