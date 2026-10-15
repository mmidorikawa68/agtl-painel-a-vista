const assert = require("node:assert/strict");
const test = require("node:test");
const { buildDescargasDashboard, getOperationalShift } = require("../descarga-dashboard");

test("classifica horários nos turnos e vincula a madrugada à data operacional anterior", () => {
  assert.deepEqual(getOperationalShift(new Date(2026, 9, 9, 6, 59)), {
    data: "2026-10-08",
    turno: "C",
  });
  assert.deepEqual(getOperationalShift(new Date(2026, 9, 9, 7, 0)), {
    data: "2026-10-09",
    turno: "A",
  });
  assert.deepEqual(getOperationalShift(new Date(2026, 9, 9, 15, 20)), {
    data: "2026-10-09",
    turno: "B",
  });
  assert.deepEqual(getOperationalShift(new Date(2026, 9, 9, 23, 28)), {
    data: "2026-10-09",
    turno: "C",
  });
});

test("move para F apenas o turno indicado em turnofolga e agrega quantidade e peso por produto", () => {
  const now = new Date(2026, 9, 9, 10, 0);
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
  const result = buildDescargasDashboard([], 2026, 2, new Date(2026, 1, 1, 8, 0));

  assert.equal(result.dias.length, 28);
  assert.deepEqual(result.dias[0].turnos, { A: 0, B: 0, C: 0, F: 0 });
  assert.equal(result.totais.quantidade, 0);
  assert.equal(result.turnoAtual.pesoKg, null);
});

test("usa turnofolga para identificar o turno F atual mesmo sem descargas", () => {
  const result = buildDescargasDashboard(
    [],
    2026,
    10,
    new Date(2026, 9, 9, 10, 0),
    " a ",
  );

  assert.equal(result.turnoAtual.turno, "F");
});
