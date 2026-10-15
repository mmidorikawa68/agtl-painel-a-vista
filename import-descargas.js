const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");
const { parseCargaFileName, parseDescargaXml } = require("./xml-import");

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

async function importXmlFiles() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yearDirectory = path.join(xmlBasePath, String(today.getFullYear()));
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
    await client.query(
      `INSERT INTO painel_importacao_controle (fonte, ultima_data_processada)
       VALUES ('descargas', $1::date)
       ON CONFLICT (fonte) DO NOTHING`,
      [initialXmlScanDate],
    );
    const checkpoint = await client.query(
      `SELECT to_char(ultima_data_processada, 'YYYY-MM-DD') AS ultima_data_processada
       FROM painel_importacao_controle
       WHERE fonte = 'descargas'`,
    );
    if (checkpoint.rowCount !== 1) {
      throw new Error("Não foi possível ler o checkpoint da importação de descargas.");
    }

    const reconciliation = await client.query(
      `SELECT 1
       FROM painel_importacao_controle
       WHERE fonte = 'descargas_reconciliacao_inicial'`,
    );
    const backfillRequired = reconciliation.rowCount === 0;
    const scanStartDate = backfillRequired
      ? initialXmlScanDate
      : checkpoint.rows[0].ultima_data_processada;
    const [startYear, startMonth, startDay] = scanStartDate.split("-").map(Number);
    const scanDate = new Date(startYear, startMonth - 1, startDay);

    while (scanDate <= today) {
      const year = String(scanDate.getFullYear());
      const month = String(scanDate.getMonth() + 1).padStart(2, "0");
      const day = String(scanDate.getDate()).padStart(2, "0");
      const dateKey = `${year}-${month}-${day}`;
      const dateDirectory = path.join(xmlBasePath, year, month, day, "SendRest");

      let entries;
      try {
        entries = await fs.readdir(dateDirectory, { withFileTypes: true });
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
        entries = [];
      }

      const files = entries
        .filter((entry) => {
          if (!entry.isFile()) {
            return false;
          }
          const idcarga = parseCargaFileName(entry.name);
          return idcarga !== null && !ignoredXmlCargaIds.has(idcarga);
        })
        .sort((first, second) => first.name.localeCompare(second.name, "en"));

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
          console.info(`Carga ${descarga.idcarga} importada em descargas.`);
        } catch (error) {
          await client.query("ROLLBACK");
          throw new Error(`Falha ao importar ${entry.name}: ${error.message}`, { cause: error });
        }
      }

      await client.query(
        `UPDATE painel_importacao_controle
         SET ultima_data_processada = $1::date
         WHERE fonte = 'descargas'`,
        [dateKey],
      );
      scanDate.setDate(scanDate.getDate() + 1);
    }

    if (backfillRequired) {
      await client.query(
        `INSERT INTO painel_importacao_controle (fonte, ultima_data_processada)
         VALUES ('descargas_reconciliacao_inicial', $1::date)
         ON CONFLICT (fonte) DO NOTHING`,
        [initialXmlScanDate],
      );
      console.info("Reconciliação histórica de descargas concluída.");
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
