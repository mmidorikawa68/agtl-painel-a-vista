const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");
const { parseCargaFileName, parseDescargaXml } = require("./xml-import");
const { businessDateKey } = require("./business-time");

const xmlBasePath = process.env.XML_BASE_PATH || "\\\\srvportal";
const initialXmlScanDate = "2026-01-01";
const ignoredXmlCargaIds = new Set([381006]);
const refreshIntervalMs = 15 * 60 * 1000;
const databaseUrl = process.env.IMPORT_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("Configure IMPORT_DATABASE_URL com a URL do banco PostgreSQL do Render.");
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" },
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

async function importXmlFiles() {
  const todayKey = businessDateKey(new Date());
  const currentYear = todayKey.slice(0, 4);
  const yearDirectory = path.join(xmlBasePath, currentYear);
  try {
    const yearDirectoryStat = await fs.stat(yearDirectory);
    if (!yearDirectoryStat.isDirectory()) {
      throw new Error(`A pasta de importação XML não é um diretório: ${yearDirectory}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Pasta de importação XML não encontrada: ${yearDirectory}`);
    }
    throw error;
  }

  const client = await pool.connect();
  try {
    await synchronizeDescargaIdSequence(client);
    const importedIds = new Set(
      (await client.query("SELECT idcarga FROM descargas")).rows.map(({ idcarga }) => String(idcarga)),
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
          console.error(`Falha ao listar a pasta ${dateDirectory}:`, error);
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
            !importedIds.has(String(idcarga))
          ) {
            files.push(entry);
          }
        } catch (error) {
          importErrors += 1;
          console.error(`Falha ao interpretar o nome do arquivo ${entry.name}:`, error);
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
            "SELECT 1 FROM descargas WHERE idcarga = $1 LIMIT 1",
            [idcarga],
          );
          if (existing.rowCount > 0) {
            importedIds.add(String(idcarga));
            await client.query("COMMIT");
            continue;
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
          await client.query(
            `INSERT INTO descargas (
               idcarga, dataentrada, pesoentrada, datasaida, pesosaida, pesoliquido,
               produto, cliente, placacavalo, placacarreta1, placacarreta2, placacarreta3
             ) VALUES ($1, $2::timestamp, $3, $4::timestamp, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              descarga.idcarga,
              descarga.dataentrada,
              descarga.pesoentrada,
              descarga.datasaida,
              descarga.pesosaida,
              descarga.pesoliquido,
              descarga.produto,
              descarga.cliente,
              descarga.placacavalo,
              descarga.placacarreta1,
              descarga.placacarreta2,
              descarga.placacarreta3,
            ],
          );
          await client.query("COMMIT");
          importedIds.add(String(idcarga));
          console.info(`Carga ${descarga.idcarga} importada em descargas.`);
        } catch (error) {
          await client.query("ROLLBACK");
          importErrors += 1;
          console.error(`Falha ao importar ${entry.name}; nova tentativa no próximo ciclo:`, error);
        }
      }

      scanDate.setUTCDate(scanDate.getUTCDate() + 1);
    }
    if (importErrors) {
      console.warn(
        `Varredura de XML concluída até ${todayKey} com ${importErrors} erro(s); os itens serão tentados novamente no próximo ciclo.`,
      );
    } else {
      console.info(`Varredura completa de XML concluída até ${todayKey}.`);
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
    await importXmlFiles();
  } catch (error) {
    console.error("Falha na rotina de importação XML:", error);
  } finally {
    importRunning = false;
  }
}

console.info("Importador local de descargas iniciado.");
void runXmlImport();
setInterval(() => void runXmlImport(), refreshIntervalMs);
