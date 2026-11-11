const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");
const { parseCargaFileName, parseDescargaXml } = require("./xml-import");
const { businessDateKey } = require("./business-time");
const {
  invalidateAnnualDescargasJson,
  writeAnnualDescargasJson,
} = require("./descarga-json");
const { uploadAnnualDescargasJson } = require("./firebase-upload");

const xmlBasePath = process.env.XML_BASE_PATH || "\\\\srvportal";
const ignoredXmlCargaIds = new Set([381006]);
const refreshIntervalMs = 15 * 60 * 1000;
const eventTimestampFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  dateStyle: "short",
  timeStyle: "medium",
});

function timestamped(message) {
  return `[${eventTimestampFormatter.format(new Date())}] ${message}`;
}

const pool = new Pool({
  user: process.env.PGUSER || "postgres",
  host: process.env.PGHOST || "localhost",
  database: process.env.PGDATABASE || "agtl_painel_a_vista",
  password: process.env.PGPASSWORD,
  port: Number(process.env.PGPORT || 5432),
});

async function synchronizeDescargaIdSequence(client) {
  await client.query("BEGIN");
  try {
    await client.query("LOCK TABLE descargas IN SHARE MODE");
    await client.query(`
      DO $$
      DECLARE
        sequence_name text;
        sequence_last_value bigint;
        sequence_is_called boolean;
        max_id bigint;
      BEGIN
        sequence_name := pg_get_serial_sequence('public.descargas', 'iddescarga');
        IF sequence_name IS NULL THEN
          RAISE EXCEPTION 'Não foi encontrada uma sequência associada a descargas.iddescarga.';
        END IF;

        EXECUTE format(
          'SELECT last_value, is_called FROM %s',
          sequence_name::regclass
        ) INTO sequence_last_value, sequence_is_called;
        SELECT COALESCE(MAX(iddescarga), 0) INTO max_id FROM public.descargas;

        IF max_id > sequence_last_value
          OR (max_id = sequence_last_value AND NOT sequence_is_called) THEN
          PERFORM setval(sequence_name::regclass, max_id, true);
        END IF;
      END $$;
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function getInitialXmlScanDate(client) {
  const result = await client.query(
    `SELECT ultima_data_processada::text AS ultima_data_processada
     FROM public.painel_importacao_controle
     WHERE fonte = 'descargas_reconciliacao_inicial'`,
  );
  const date = result.rows[0]?.ultima_data_processada;
  if (
    result.rowCount !== 1 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date || "")
  ) {
    throw new Error(
      "O checkpoint descargas_reconciliacao_inicial está ausente, duplicado ou contém uma data inválida.",
    );
  }
  return date;
}

async function importXmlFiles() {
  const todayKey = businessDateKey(new Date());
  const currentYear = todayKey.slice(0, 4);
  const yearDirectory = path.join(xmlBasePath, currentYear);
  let yearDirectoryStat;
  try {
    yearDirectoryStat = await fs.stat(yearDirectory);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Pasta de importação XML não encontrada: ${yearDirectory}`, { cause: error });
    }
    throw new Error(
      `Não foi possível acessar a pasta de importação XML: ${yearDirectory}. Verifique se o compartilhamento de rede está disponível e se esta conta tem permissão de leitura.`,
      { cause: error },
    );
  }
  if (!yearDirectoryStat.isDirectory()) {
    throw new Error(`A pasta de importação XML não é um diretório: ${yearDirectory}`);
  }

  const client = await pool.connect();
  try {
    await synchronizeDescargaIdSequence(client);
    const initialXmlScanDate = await getInitialXmlScanDate(client);
    const existingRows = (await client.query(
      "SELECT idcarga, cnpjexportador FROM descargas",
    )).rows;
    const importedIds = new Set(existingRows.map(({ idcarga }) => String(idcarga)));
    const missingCnpjIds = new Set(
      existingRows
        .filter(({ cnpjexportador }) => cnpjexportador == null || !String(cnpjexportador).trim())
        .map(({ idcarga }) => String(idcarga)),
    );
    const [startYear, startMonth, startDay] = initialXmlScanDate.split("-").map(Number);
    const [endYear, endMonth, endDay] = todayKey.split("-").map(Number);
    const scanDate = new Date(Date.UTC(startYear, startMonth - 1, startDay));
    const endDate = new Date(Date.UTC(endYear, endMonth - 1, endDay));
    let importErrors = 0;

    while (scanDate <= endDate) {
      const year = String(scanDate.getUTCFullYear());
      const month = String(scanDate.getUTCMonth() + 1).padStart(2, "0");
      const day = String(scanDate.getUTCDate()).padStart(2, "0");
      const dateKey = `${year}-${month}-${day}`;
      const dateDirectory = path.join(xmlBasePath, year, month, day, "SendRest");

      let entries;
      try {
        entries = await fs.readdir(dateDirectory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") {
          entries = [];
        } else {
          importErrors += 1;
          console.error(timestamped(`Falha ao listar a pasta ${dateDirectory}:`), error);
          entries = [];
        }
      }

      const files = [];
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        try {
          const idcarga = parseCargaFileName(entry.name);
          if (
            idcarga !== null &&
            !ignoredXmlCargaIds.has(idcarga) &&
            (!importedIds.has(String(idcarga)) || missingCnpjIds.has(String(idcarga)))
          ) {
            files.push(entry);
          }
        } catch (error) {
          importErrors += 1;
          console.error(timestamped(`Falha ao interpretar o nome do arquivo ${entry.name}:`), error);
        }
      }
      files.sort((first, second) => first.name.localeCompare(second.name, "en"));

      for (const entry of files) {
        const idcarga = parseCargaFileName(entry.name);
        const filePath = path.join(dateDirectory, entry.name);
        await client.query("BEGIN");
        try {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtext('agtl_descargas'), $1::int)",
            [idcarga],
          );
          const existing = await client.query(
            `SELECT cnpjexportador, to_char(datasaida, 'YYYY-MM-DD HH24:MI:SS') AS datasaida
             FROM descargas
             WHERE idcarga = $1
             LIMIT 1`,
            [idcarga],
          );
          if (existing.rowCount > 0) {
            importedIds.add(String(idcarga));
            const existingCnpj = existing.rows[0].cnpjexportador;
            if (existingCnpj != null && String(existingCnpj).trim()) {
              missingCnpjIds.delete(String(idcarga));
              await client.query("COMMIT");
              continue;
            }
          }

          const stat = await fs.stat(filePath);
          if (stat.size > 10 * 1024 * 1024) {
            throw new Error("Arquivo excede o limite de 10 MB.");
          }
          const xml = await fs.readFile(filePath, "utf8");
          const descarga = await parseDescargaXml(xml);
          if (descarga.idcarga !== idcarga) {
            throw new Error(
              `ID do XML (${descarga.idcarga}) difere do ID no nome do arquivo (${idcarga}).`,
            );
          }
          if (existing.rowCount > 0) {
            missingCnpjIds.delete(String(idcarga));
            if (descarga.cnpjexportador) {
              const updated = await client.query(
                `UPDATE descargas
                 SET cnpjexportador = $2
                 WHERE idcarga = $1
                   AND NULLIF(BTRIM(cnpjexportador::text), '') IS NULL`,
                [idcarga, descarga.cnpjexportador],
              );
              if (updated.rowCount > 0) {
                console.info(timestamped(`CNPJ da carga ${idcarga} preenchido a partir do XML.`));
                if (existing.rows[0].datasaida) {
                  await invalidateAnnualDescargasJson(client, existing.rows[0].datasaida);
                }
              }
            } else {
              console.warn(timestamped(`Campo cnpjExportador ausente no XML da carga ${idcarga}.`));
            }
            await client.query("COMMIT");
            continue;
          }
          await client.query(
            `INSERT INTO descargas (
               idcarga, dataentrada, pesoentrada, datasaida, pesosaida, pesoliquido,
               produto, cliente, cnpjexportador, placacavalo, placacarreta1, placacarreta2, placacarreta3
             ) VALUES ($1, $2::timestamp, $3, $4::timestamp, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              descarga.idcarga,
              descarga.dataentrada,
              descarga.pesoentrada,
              descarga.datasaida,
              descarga.pesosaida,
              descarga.pesoliquido,
              descarga.produto,
              descarga.cliente,
              descarga.cnpjexportador,
              descarga.placacavalo,
              descarga.placacarreta1,
              descarga.placacarreta2,
              descarga.placacarreta3,
            ],
          );
          await invalidateAnnualDescargasJson(client, descarga.datasaida);
          await client.query("COMMIT");
          importedIds.add(String(idcarga));
          console.info(timestamped(`Carga ${descarga.idcarga} importada em descargas.`));
        } catch (error) {
          await client.query("ROLLBACK");
          importErrors += 1;
          console.error(
            timestamped(`Falha ao importar ${entry.name}; nova tentativa no próximo ciclo:`),
            error,
          );
        }
      }

      scanDate.setUTCDate(scanDate.getUTCDate() + 1);
    }
    const generatedJson = await writeAnnualDescargasJson(client);
    console.info(
      timestamped(
        `JSON ${path.basename(generatedJson.filePath)} atualizado desde ${generatedJson.rebuiltFrom}.`,
      ),
    );
    const uploadResult = await uploadAnnualDescargasJson(
      generatedJson.filePath,
      generatedJson.year,
    );
    console.info(
      timestamped(
        `${uploadResult.fileName} enviado ao Firebase em ${uploadResult.databasePath}.`,
      ),
    );
    if (importErrors) {
      console.warn(
        timestamped(
          `Varredura de XML concluída até ${todayKey} com ${importErrors} erro(s); os itens serão tentados novamente no próximo ciclo.`,
        ),
      );
    } else {
      console.info(timestamped(`Varredura completa de XML concluída até ${todayKey}.`));
    }
  } finally {
    client.release();
  }
}

let importRunning = false;
async function runXmlImport() {
  if (importRunning) {
    return;
  }
  importRunning = true;
  try {
    console.info(timestamped("Iniciando rotina de importação e varredura de XML."));
    await importXmlFiles();
  } catch (error) {
    console.error(timestamped("Falha na rotina de importação XML:"), error);
  } finally {
    importRunning = false;
  }
}

console.info(timestamped("Importador local de descargas iniciado."));
void runXmlImport();
setInterval(() => void runXmlImport(), refreshIntervalMs);
