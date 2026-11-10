const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDescargasDashboard,
  getOperationalDateFromTimestamp,
  getOperationalShift,
  mergeAnnualDescargasDashboard,
  selectDescargasDashboardForPeriod,
} = require("../descarga-dashboard");

test("classifica horários nos turnos e vincula a madrugada à data operacional anterior", () => {
  assert.deepEqual(getOperationalShift(new Date("2026-10-09T09:59:00.000Z")), {
    data: "2026-10-08",
    turno: "C",
  });
  assert.deepEqual(getOperationalShift(new Date("2026-10-09T10:00:00.000Z")), {
    data: "2026-10-09",
    turno: "A",
  });
  assert.deepEqual(getOperationalShift(new Date("2026-10-09T18:20:00.000Z")), {
    data: "2026-10-09",
    turno: "B",
  });
  assert.deepEqual(getOperationalShift(new Date("2026-10-10T02:28:00.000Z")), {
    data: "2026-10-09",
    turno: "C",
  });
});

test("move para F apenas o turno indicado em turnofolga e agrega quantidade e peso por produto", () => {
  const now = new Date("2026-10-09T13:00:00.000Z");
  const result = buildDescargasDashboard(
    [
      {
        data_turno: "2026-10-09",
        turno_base: "A",
        turnofolga: "A",
        produto: "Soja",
        pesoliquido: 1200,
      },
      {
        data_turno: "2026-10-09",
        turno_base: "A",
        turnofolga: "A",
        produto: "Milho",
        pesoliquido: 800,
      },
      {
        data_turno: "2026-10-09",
        turno_base: "B",
        turnofolga: "A",
        produto: "Soja",
        pesoliquido: 900,
      },
    ],
    2026,
    10,
    now,
  );

  assert.equal(result.turnoAtual.turno, "F");
  assert.deepEqual(result.turnoAtual.produtos, { Soja: 1, Milho: 1 });
  assert.equal(result.turnoAtual.pesoKg, 2000);
  assert.deepEqual(result.dias[8].turnos, { A: 0, B: 1, C: 0, F: 2 });
  assert.equal(result.dias[8].pesoKg, 2900);
  assert.equal(result.totais.quantidade, 3);
  assert.equal(result.totais.produtos.Soja.pesoKg, 2100);
});

test("retorna todos os dias do mês, mesmo quando não há descargas", () => {
  const result = buildDescargasDashboard([], 2026, 2, new Date("2026-02-01T11:00:00.000Z"));

  assert.equal(result.dias.length, 28);
  assert.deepEqual(result.dias[0].turnos, { A: 0, B: 0, C: 0, F: 0 });
  assert.equal(result.totais.quantidade, 0);
  assert.equal(result.turnoAtual.pesoKg, null);
});

test("agrega todos os dias e descargas do ano quando o mês é todos", () => {
  const result = buildDescargasDashboard(
    [
      {
        data_turno: "2024-01-02",
        turno_base: "A",
        turnofolga: null,
        produto: "Soja",
        pesoliquido: 1200,
      },
      {
        data_turno: "2024-12-31",
        turno_base: "B",
        turnofolga: null,
        produto: "Milho",
        pesoliquido: 800,
      },
    ],
    2024,
    0,
    new Date("2024-01-01T11:00:00.000Z"),
  );

  assert.equal(result.dias.length, 366);
  assert.equal(result.dias[0].data, "2024-01-01");
  assert.equal(result.dias[365].data, "2024-12-31");
  assert.equal(result.dias[1].quantidade, 1);
  assert.equal(result.dias[365].quantidade, 1);
  assert.equal(result.totais.quantidade, 2);
  assert.equal(result.totais.pesoKg, 2000);
});

test("usa turnofolga para identificar o turno F atual mesmo sem descargas", () => {
  const result = buildDescargasDashboard(
    [],
    2026,
    10,
    new Date("2026-10-09T13:00:00.000Z"),
    " a ",
  );

  assert.equal(result.turnoAtual.turno, "F");
});

test("contabiliza no turno A usando horário de São Paulo quando o servidor está em UTC", () => {
  const result = buildDescargasDashboard(
    [
      {
        data_turno: "2026-10-09",
        turno_base: "A",
        turnofolga: null,
        produto: "Soja",
        pesoliquido: 1200,
      },
    ],
    2026,
    10,
    new Date("2026-10-09T10:05:00.000Z"),
  );

  assert.equal(result.turnoAtual.turno, "A");
  assert.equal(result.turnoAtual.quantidade, 1);
  assert.equal(result.turnoAtual.produtos.Soja, 1);
});

test("classifica a data operacional da descarga antes das 07:00 como o dia anterior", () => {
  assert.equal(getOperationalDateFromTimestamp("2026-10-09 06:59:00"), "2026-10-08");
  assert.equal(getOperationalDateFromTimestamp("2026-10-09 07:00:00"), "2026-10-09");
  assert.throws(
    () => getOperationalDateFromTimestamp("data inválida"),
    /Data de saída inválida/,
  );
});

test("seleciona um mês do JSON anual e recompõe os totais do período", () => {
  const annual = buildDescargasDashboard(
    [
      {
        data_turno: "2026-10-09",
        turno_base: "A",
        turnofolga: null,
        produto: "Soja",
        pesoliquido: 1200,
      },
      {
        data_turno: "2026-11-02",
        turno_base: "B",
        turnofolga: null,
        produto: "Milho",
        pesoliquido: 800,
      },
    ],
    2026,
    0,
    new Date("2026-11-09T13:00:00.000Z"),
  );

  const november = selectDescargasDashboardForPeriod(annual, 2026, 11);

  assert.equal(november.dias.length, 30);
  assert.equal(november.totais.quantidade, 1);
  assert.equal(november.totais.pesoKg, 800);
  assert.deepEqual(november.totais.produtos.Milho, { quantidade: 1, pesoKg: 800 });
  assert.equal(november.totais.produtos.Soja, undefined);
});

test("reconstrói a partir do checkpoint e preserva os dias anteriores do JSON anual", () => {
  const now = new Date("2026-11-09T13:00:00.000Z");
  const original = buildDescargasDashboard(
    [
      {
        data_turno: "2026-10-08",
        turno_base: "A",
        turnofolga: null,
        produto: "Soja",
        pesoliquido: 1000,
      },
      {
        data_turno: "2026-10-09",
        turno_base: "A",
        turnofolga: null,
        produto: "Milho",
        pesoliquido: 500,
      },
    ],
    2026,
    0,
    now,
  );
  const refreshed = buildDescargasDashboard(
    [
      {
        data_turno: "2026-10-09",
        turno_base: "A",
        turnofolga: null,
        produto: "Milho",
        pesoliquido: 700,
      },
    ],
    2026,
    0,
    now,
  );

  const merged = mergeAnnualDescargasDashboard(
    original,
    refreshed,
    "2026-10-09",
    "2026-11-09",
  );
  const dayBeforeCheckpoint = merged.dias.find(({ data }) => data === "2026-10-08");
  const changedDay = merged.dias.find(({ data }) => data === "2026-10-09");

  assert.equal(dayBeforeCheckpoint.pesoKg, 1000);
  assert.equal(changedDay.pesoKg, 700);
  assert.equal(merged.totais.quantidade, 2);
  assert.equal(merged.totais.pesoKg, 1700);
});
