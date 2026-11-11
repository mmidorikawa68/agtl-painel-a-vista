const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { FilaXmlError, parseFilaResponse } = require("./fila-dashboard");
const { selectDescargasDashboardForPeriod } = require("./descarga-dashboard");
const { businessDateKey } = require("./business-time");

const app = express();
const port = Number(process.env.PORT || 3000);
const descargaEventClients = new Set();
const publicDirectory = path.join(__dirname, "public");
const dashboardDirectory = path.join(publicDirectory, "dashboards");
const dashboardDataDirectory = path.join(publicDirectory, "data");
const dashboardsFile = path.join(__dirname, "dashboards.json");

function notifyDescargasUpdated() {
  for (const response of descargaEventClients) {
    if (response.destroyed || response.writableEnded) {
      descargaEventClients.delete(response);
      continue;
    }
    response.write("event: descargas-atualizadas\ndata: {}\n\n");
  }
}

let latestDescargaFileModified;
let checkingDescargas = false;
async function checkForNewDescargas() {
  if (checkingDescargas) {
    return;
  }
  checkingDescargas = true;
  try {
    const year = businessDateKey(new Date()).slice(0, 4);
    const filePath = path.join(dashboardDataDirectory, `descarga_por_turno_${year}.json`);
    const fileStat = await fs.stat(filePath);
    if (
      latestDescargaFileModified !== undefined &&
      fileStat.mtimeMs !== latestDescargaFileModified
    ) {
      notifyDescargasUpdated();
    }
    latestDescargaFileModified = fileStat.mtimeMs;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Falha ao verificar atualização do JSON de descargas:", error);
    }
  } finally {
    checkingDescargas = false;
  }
}

async function loadDashboards() {
  const rawDashboards = JSON.parse(await fs.readFile(dashboardsFile, "utf8"));
  if (!Array.isArray(rawDashboards) || rawDashboards.length === 0) {
    throw new Error("dashboards.json deve conter ao menos um dashboard.");
  }

  const ids = new Set();
  return rawDashboards.map((dashboard) => {
    if (
      !dashboard ||
      typeof dashboard.id !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(dashboard.id) ||
      ids.has(dashboard.id) ||
      typeof dashboard.titulo !== "string" ||
      !dashboard.titulo.trim() ||
      !Number.isInteger(dashboard.duracaoSegundos) ||
      dashboard.duracaoSegundos < 1 ||
      typeof dashboard.arquivo !== "string"
    ) {
      throw new Error("Configuração inválida ou ID duplicado em dashboards.json.");
    }
    ids.add(dashboard.id);

    const filePath = path.resolve(dashboardDirectory, dashboard.arquivo);
    const relativePath = path.relative(dashboardDirectory, filePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`O arquivo do dashboard "${dashboard.id}" está fora da pasta permitida.`);
    }

    return {
      id: dashboard.id,
      titulo: dashboard.titulo.trim(),
      duracaoSegundos: dashboard.duracaoSegundos,
      filePath,
    };
  });
}

app.get("/api/dashboards", async (req, res, next) => {
  try {
    const dashboards = await loadDashboards();
    res.json(
      dashboards.map(({ id, titulo, duracaoSegundos }) => ({ id, titulo, duracaoSegundos })),
    );
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboards/:id/content", async (req, res, next) => {
  try {
    const dashboards = await loadDashboards();
    const dashboard = dashboards.find((item) => item.id === req.params.id);
    if (!dashboard) {
      return res.status(404).json({ erro: "Dashboard não encontrado." });
    }
    await fs.access(dashboard.filePath);
    return res.sendFile(dashboard.filePath);
  } catch (error) {
    return next(error);
  }
});

app.get("/api/dashboard-data", async (req, res, next) => {
  const apiUrl = process.env.DASHBOARD_API_URL;
  if (!apiUrl) {
    return res.status(503).json({ erro: "DASHBOARD_API_URL não foi configurada." });
  }

  try {
    const url = new URL(apiUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return res.status(500).json({ erro: "A URL da API deve usar HTTPS." });
    }

    const headers = { accept: "application/xml, text/xml, */*" };
    if (process.env.DASHBOARD_API_TOKEN) {
      headers.authorization = `Bearer ${process.env.DASHBOARD_API_TOKEN}`;
    }
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!response.ok) {
      return res.status(502).json({ erro: `A API de dados respondeu com HTTP ${response.status}.` });
    }
    const xml = await response.text();
    if (Buffer.byteLength(xml, "utf8") > 10 * 1024 * 1024) {
      return res.status(502).json({ erro: "A resposta da API excedeu o limite de 10 MB." });
    }
    return res.json(await parseFilaResponse(xml));
  } catch (error) {
    if (error instanceof FilaXmlError) {
      return res.status(502).json({ erro: error.message });
    }
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return res.status(504).json({ erro: "A API da fila excedeu o tempo limite." });
    }
    return next(error);
  }
});

app.get("/api/descargas-events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  descargaEventClients.add(res);
  req.on("close", () => descargaEventClients.delete(res));
});

app.get("/api/descargas-dashboard", async (req, res, next) => {
  const year = Number(req.query.ano);
  const month = Number(req.query.mes);
  if (
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2100 ||
    !Number.isInteger(month) ||
    month < 0 ||
    month > 12
  ) {
    return res.status(400).json({ erro: "Informe um ano e mês válidos, ou selecione todos os meses." });
  }

  try {
    const filePath = path.join(dashboardDataDirectory, `descarga_por_turno_${year}.json`);
    let contents;
    try {
      contents = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return res.status(503).json({
          erro: `Os dados de descargas para ${year} ainda não foram publicados.`,
        });
      }
      throw error;
    }

    let annualData;
    try {
      annualData = JSON.parse(contents);
    } catch (error) {
      return next(new Error(`JSON anual de descargas inválido: ${filePath}.`, { cause: error }));
    }
    return res.json(selectDescargasDashboardForPeriod(annualData, year, month));
  } catch (error) {
    return next(error);
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDirectory, "index.html"));
});
app.use("/assets", express.static(path.join(publicDirectory, "assets")));

app.use((req, res) => {
  res.status(404).json({ erro: "Recurso não encontrado." });
});

app.use((error, req, res, next) => {
  console.error("Erro na requisição:", error);
  if (res.headersSent) {
    return next(error);
  }
  return res.status(500).json({ erro: "Ocorreu um erro interno no servidor." });
});

app.listen(port, () => {
  console.info(`Painel AGTL disponível na porta ${port}.`);
  void checkForNewDescargas();
  setInterval(() => void checkForNewDescargas(), 30 * 1000);
});
