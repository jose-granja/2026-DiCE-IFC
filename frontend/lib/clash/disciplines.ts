/**
 * The disciplines a clash matrix classifies its groups and models by: the
 * Especialidade codes of buildingSMART Portugal's EIR (Fase de Projeto, Obra
 * Privada), Table A.2 — the same codes its file names carry.
 * https://github.com/buildingSMART-Portugal/EIR-FaseProjeto-ObraPrivada/blob/main/EIR.md#tabela-a2--c%C3%B3digo-para-o-campo-especialidade
 *
 * A discipline is the table's description, word for word, in both languages:
 * groups and models are matched by that text (ignoring case), and an EIR is
 * the shared vocabulary between the teams, not something to translate. The
 * code is shown beside it in the suggestions. Copied from the EIR's own table,
 * all 59 rows in its order; change it only with the EIR.
 */

export type EirDiscipline = { code: string; name: string };

export const EIR_DISCIPLINES: readonly EirDiscipline[] = [
  { code: "ACS", name: "Acessibilidades" },
  { code: "ACU", name: "Engenharia acústica" },
  { code: "ADR", name: "Agricultura e desenvolvimento rural" },
  { code: "AMB", name: "Engenharia do ambiente" },
  { code: "APA", name: "Arquitetura paisagista" },
  { code: "ARQ", name: "Arquitetura" },
  { code: "ASR", name: "Auditorias de segurança rodoviária" },
  { code: "BAR", name: "Barragens" },
  { code: "CAR", name: "Cartografia" },
  { code: "CTR", name: "Canal técnico rodoviário" },
  { code: "DEM", name: "Demolições" },
  { code: "ECP", name: "Escavação e/ou contenção periférica" },
  { code: "ECT", name: "Estudo de comportamento térmico" },
  { code: "EEL", name: "Engenharia eletrotécnica - eletricidade" },
  { code: "EIT", name: "Engenharia eletrotécnica - ited" },
  { code: "ELM", name: "Engenharia eletromecânica" },
  { code: "ERU", name: "Estudo do ruído" },
  { code: "EST", name: "Engenharia de estruturas" },
  { code: "ETF", name: "Estudo de tráfego" },
  { code: "ETS", name: "Estruturas de suporte e taludes" },
  { code: "FLI", name: "Fluidos industriais" },
  { code: "GAS", name: "Gás" },
  { code: "GEO", name: "Geologia" },
  { code: "GET", name: "Geotecnia" },
  { code: "GTC", name: "Gestão técnica centralizada" },
  { code: "HAB", name: "Engenharia hidráulica - abastecimento de água" },
  { code: "HAP", name: "Engenharia hidráulica - drenagem de águas pluviais" },
  { code: "HAR", name: "Engenharia hidráulica - drenagem de águas residuais" },
  { code: "HDR", name: "Engenharia hidráulica - drenagem (pluviais e residuais)" },
  { code: "HGL", name: "Hidrogeologia" },
  { code: "HID", name: "Engenharia hidráulica" },
  { code: "HTA", name: "Engenharia hidráulica - tratamento de água" },
  { code: "HTR", name: "Engenharia hidráulica - tratamento de águas residuais" },
  { code: "IAE", name: "Infraestruturas aeroportuárias" },
  { code: "IFE", name: "Infraestruturas ferroviárias" },
  { code: "IMA", name: "Infraestruturas marítimas" },
  { code: "INS", name: "Instrumentação" },
  { code: "IRO", name: "Infraestruturas rodoviárias" },
  { code: "LTE", name: "Linha de transporte de energia" },
  { code: "LUM", name: "Estudo luminotécnico" },
  { code: "MAC", name: "Engenharia mecânica - avac" },
  { code: "MCL", name: "Engenharia mecânica - climatização" },
  { code: "MVE", name: "Engenharia mecânica - ventilação /exaustão" },
  { code: "OAR", name: "Obras de arte" },
  { code: "RAC", name: "Rede de ar comprimido" },
  { code: "RSU", name: "Resíduos sólidos urbanos" },
  { code: "SAF", name: "Serviços afetados" },
  { code: "SCI", name: "Segurança contra incêndio" },
  { code: "SEG", name: "Segurança" },
  { code: "SIN", name: "Sinalização e equipamento de segurança" },
  { code: "SOL", name: "Ocupação do solo" },
  { code: "SOM", name: "Som e áudio" },
  { code: "SUB", name: "Obras subterrâneas" },
  { code: "TER", name: "Terraplenagens" },
  { code: "TOP", name: "Topografia" },
  { code: "TRA", name: "Traçado" },
  { code: "URB", name: "Urbanismo" },
  { code: "XXX", name: "Não disciplinar / não aplicável" },
  { code: "ZZZ", name: "Multidisciplinar" },
];

const BY_CODE = new Map(EIR_DISCIPLINES.map((d) => [d.code, d]));

/** The description for a Table A.2 code. Throws on a code the table does not have. */
export function eirDiscipline(code: string): string {
  const found = BY_CODE.get(code);
  if (!found) throw new Error(`No EIR discipline ${code}`);
  return found.name;
}

/** The code for a discipline written as the table's description (ignoring case), if it is one. */
export function eirDisciplineCode(name: string): string | undefined {
  const key = name.trim().toLocaleLowerCase();
  return EIR_DISCIPLINES.find((d) => d.name.toLocaleLowerCase() === key)?.code;
}
