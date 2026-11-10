const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  invalidateAnnualDescargasJson,
  writeAnnualDescargasJson,
} = require("../descarga-json");

test("gera JSON anual e refaz desde a data operacional de uma carga histórica", async () => {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agtl-descargas-"));
  const checkpoints = new Map([
    ["descargas_reconciliacao_inicial", "2026-01-01"],
    ["descargas", "2026-10-15"],
  ]);
  const queryRanges = [];
  const client = {
    async query(sql, values = []) {
      if (sql.includes("SELECT fonte,")) {
        return {
          rows: [...checkpoints].map(([fonte, ultima_data_processada]) => ({
            fonte,
            ultima_data_processada,
          })),
        };
      }
      if (sql.includes("SELECT ultima_data_processada::text")) {
        const date = checkpoints.get(values[0]);
        return { rowCount: date ? 1 : 0, rows: date ? [{ ultima_data_processada: date }] : [] };
      }
      if (sql.includes("SELECT 1 FROM public.painel_importacao_controle")) {
        return { rowCount: checkpoints.has(values[0]) ? 1 : 0, rows: [] };
      }
      if (sql.includes("UPDATE public.painel_importacao_controle")) {
        checkpoints.set(values[0], values[1]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO public.painel_importacao_controle")) {
        checkpoints.set(values[0], values[1]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("WITH descarga_com_turno")) {
        queryRanges.push(values);
        const row = (date) => ({
            data_turno: date,
            turno_base: "A",
            turnofolga: null,
            produto: "Soja",
            pesoliquido: 1000,
        });
        return {
          rows: values[0] === "2026-10-19"
            ? [row("2026-10-19"), row("2026-11-09")]
            : [row("2026-11-09")],
        };
      }
      if (sql.includes("FROM public.turnodescarga")) {
        return { rows: [] };
      }
      throw new Error(`Consulta inesperada no teste: ${sql}`);
    },
  };

  try {
    const now = new Date("2026-11-09T13:00:00.000Z");
    const firstWrite = await writeAnnualDescargasJson(client, { now, outputDirectory });
    const filePath = path.join(outputDirectory, "descarga_por_turno_2026.json");
    const initialData = JSON.parse(await fs.readFile(filePath, "utf8"));

    assert.equal(firstWrite.rebuiltFrom, "2026-01-01");
    assert.equal(initialData.ano, 2026);
    assert.equal(initialData.dias.find(({ data }) => data === "2026-11-09").quantidade, 1);
    assert.equal(checkpoints.get("descargas"), "2026-11-09");

    await invalidateAnnualDescargasJson(client, "2026-10-20 04:00:00", now);
    assert.equal(checkpoints.get("descargas"), "2026-10-19");
    const historicalWrite = await writeAnnualDescargasJson(client, { now, outputDirectory });
    const updatedData = JSON.parse(await fs.readFile(filePath, "utf8"));

    assert.equal(historicalWrite.rebuiltFrom, "2026-10-19");
    assert.deepEqual(queryRanges.at(-1), ["2026-10-19", "2026-11-09"]);
    assert.equal(updatedData.dias.find(({ data }) => data === "2026-10-19").quantidade, 1);
    assert.equal(updatedData.dias.find(({ data }) => data === "2026-11-09").quantidade, 1);
    assert.equal(checkpoints.get("descargas"), "2026-11-09");
  } finally {
    await fs.rm(outputDirectory, { recursive: true, force: true });
  }
});
