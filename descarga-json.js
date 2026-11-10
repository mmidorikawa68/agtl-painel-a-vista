const fs = require("fs/promises");
const path = require("path");
const { businessDateKey, getBusinessDateParts } = require("./business-time");
const {
  buildDescargasDashboard,
  getOperationalDateFromTimestamp,
  getOperationalShift,
  mergeAnnualDescargasDashboard,
} = require("./descarga-dashboard");

const checkpointTable = "public.painel_importacao_controle";
const initialCheckpointSource = "descargas_reconciliacao_inicial";
const dashboardCheckpointSource = "descargas";
const defaultOutputDirectory = path.join(__dirname, "public", "data");

function isDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function readCheckpoints(client) {
  const result = await client.query(
    `SELECT fonte, ultima_data_processada::text AS ultima_data_processada
     FROM ${checkpointTable}
     WHERE fonte IN ($1, $2)`,
    [initialCheckpointSource, dashboardCheckpointSource],
  );
  const checkpoints = new Map();
  for (const row of result.rows) {
    if (checkpoints.has(row.fonte)) {
      throw new Error(`Há mais de um checkpoint para a fonte "${row.fonte}".`);
    }
    if (!isDateKey(row.ultima_data_processada)) {
      throw new Error(`Data inválida no checkpoint da fonte "${row.fonte}".`);
    }
    checkpoints.set(row.fonte, row.ultima_data_processada);
  }
  const initialDate = checkpoints.get(initialCheckpointSource);
  if (!initialDate) {
    throw new Error(`Checkpoint obrigatório ausente: ${initialCheckpointSource}.`);
  }
  return { checkpoints, initialDate };
}

async function setCheckpointDate(client, source, date) {
  const existing = await client.query(
    `SELECT 1 FROM ${checkpointTable} WHERE fonte = $1`,
    [source],
  );
  if (existing.rowCount > 1) {
    throw new Error(`Há mais de um checkpoint para a fonte "${source}".`);
  }
  if (existing.rowCount === 1) {
    await client.query(
      `UPDATE ${checkpointTable}
       SET ultima_data_processada = $2::date
       WHERE fonte = $1`,
      [source, date],
    );
    return;
  }
  await client.query(
    `INSERT INTO ${checkpointTable} (fonte, ultima_data_processada)
     VALUES ($1, $2::date)`,
    [source, date],
  );
}

async function moveCheckpointBack(client, date) {
  const existing = await client.query(
    `SELECT ultima_data_processada::text AS ultima_data_processada
     FROM ${checkpointTable}
     WHERE fonte = $1`,
    [dashboardCheckpointSource],
  );
  if (existing.rowCount > 1) {
    throw new Error(`Há mais de um checkpoint para a fonte "${dashboardCheckpointSource}".`);
  }
  const currentDate = existing.rows[0]?.ultima_data_processada;
  if (currentDate && !isDateKey(currentDate)) {
    throw new Error(`Data inválida no checkpoint da fonte "${dashboardCheckpointSource}".`);
  }
  if (!currentDate || date < currentDate) {
    await setCheckpointDate(client, dashboardCheckpointSource, date);
  }
}

async function invalidateAnnualDescargasJson(client, dataSaida, now = new Date()) {
  const affectedDate = getOperationalDateFromTimestamp(dataSaida);
  if (affectedDate < businessDateKey(now)) {
    await moveCheckpointBack(client, affectedDate);
  }
}

async function readExistingDashboard(filePath, year) {
  let contents;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let dashboard;
  try {
    dashboard = JSON.parse(contents);
  } catch (error) {
    throw new Error(`JSON anual inválido: ${filePath}.`, { cause: error });
  }
  const expected = buildDescargasDashboard([], year, 0).dias;
  if (
    !dashboard ||
    dashboard.ano !== year ||
    !Array.isArray(dashboard.dias) ||
    dashboard.dias.length !== expected.length ||
    dashboard.dias.some((day, index) => day?.data !== expected[index].data)
  ) {
    throw new Error(`Estrutura inválida no JSON anual: ${filePath}.`);
  }
  return dashboard;
}

async function readRowsSince(client, startDate, endDate) {
  const result = await client.query(
    `WITH descarga_com_turno AS (
       SELECT
         CASE
           WHEN d.datasaida::time < TIME '07:00'
             THEN d.datasaida::date - 1
           ELSE d.datasaida::date
         END AS data_turno,
         CASE
           WHEN d.datasaida::time >= TIME '07:00'
             AND d.datasaida::time < TIME '15:20' THEN 'A'
           WHEN d.datasaida::time >= TIME '15:20'
             AND d.datasaida::time < TIME '23:28' THEN 'B'
           ELSE 'C'
         END AS turno_base,
         d.produto,
         d.pesoliquido,
         n.produto AS produto_mapeado,
         td.turnofolga
       FROM public.descargas d
       LEFT JOIN public.ncm n ON n.codigo::text = d.produto::text
       LEFT JOIN LATERAL (
         SELECT turnofolga
         FROM public.turnodescarga
         WHERE dataturno = CASE
           WHEN d.datasaida::time < TIME '07:00'
             THEN d.datasaida::date - 1
           ELSE d.datasaida::date
         END
         ORDER BY idturno DESC
         LIMIT 1
       ) td ON TRUE
     )
     SELECT
       to_char(data_turno, 'YYYY-MM-DD') AS data_turno,
       turno_base,
       turnofolga,
       COALESCE(NULLIF(BTRIM(produto_mapeado), ''), produto::text) AS produto,
       pesoliquido
     FROM descarga_com_turno
     WHERE data_turno >= $1::date AND data_turno <= $2::date`,
    [startDate, endDate],
  );
  return result.rows;
}

async function readCurrentDayOff(client, currentShiftDate) {
  const result = await client.query(
    `SELECT turnofolga
     FROM public.turnodescarga
     WHERE dataturno = $1::date
     ORDER BY idturno DESC
     LIMIT 1`,
    [currentShiftDate],
  );
  return result.rows[0]?.turnofolga ?? null;
}

async function writeAnnualDescargasJson(
  client,
  {
    now = new Date(),
    outputDirectory = defaultOutputDirectory,
  } = {},
) {
  const year = getBusinessDateParts(now).year;
  const yearStart = `${year}-01-01`;
  const currentDate = businessDateKey(now);
  const currentOperationalDate = getOperationalShift(now).data;
  const filePath = path.join(outputDirectory, `descarga_por_turno_${year}.json`);
  const { initialDate } = await readCheckpoints(client);
  const existingDashboard = await readExistingDashboard(filePath, year);

  const updatedCheckpoints = await readCheckpoints(client);
  let startDate = existingDashboard
    ? updatedCheckpoints.checkpoints.get(dashboardCheckpointSource) || initialDate
    : initialDate;
  if (startDate < yearStart) {
    startDate = yearStart;
  }
  if (startDate > currentOperationalDate) {
    startDate = currentOperationalDate;
  }

  const rows = await readRowsSince(client, startDate, currentOperationalDate);
  const currentTurnofolga = await readCurrentDayOff(client, currentOperationalDate);
  const refreshedDashboard = buildDescargasDashboard(
    rows,
    year,
    0,
    now,
    currentTurnofolga,
  );
  const dashboard = mergeAnnualDescargasDashboard(
    existingDashboard,
    refreshedDashboard,
    startDate,
    currentOperationalDate,
  );
  await fs.mkdir(outputDirectory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  let temporaryFileExists = false;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(dashboard, null, 2)}\n`, "utf8");
    temporaryFileExists = true;
    await fs.rename(temporaryPath, filePath);
    temporaryFileExists = false;
  } finally {
    if (temporaryFileExists) {
      await fs.unlink(temporaryPath);
    }
  }
  await setCheckpointDate(client, dashboardCheckpointSource, currentDate);
  return { filePath, year, rebuiltFrom: startDate };
}

module.exports = { invalidateAnnualDescargasJson, writeAnnualDescargasJson };
