const xml2js = require("xml2js");
const {
  addDaysToDateKey,
  businessDateKey,
  businessDateTime,
  getBusinessDateParts,
} = require("./business-time");

const products = [
  { prefix: "1005", name: "Milho" },
  { prefix: "1070", name: "Sorgo" },
  { prefix: "1104", name: "Trigo" },
  { prefix: "1201", name: "Soja" },
];

class FilaXmlError extends Error {}

function localName(name) {
  return name.split(":").pop();
}

function values(value) {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function directValues(node, name) {
  if (!node || typeof node !== "object") {
    return [];
  }
  return Object.entries(node)
    .filter(([key]) => localName(key) === name)
    .flatMap(([, value]) => values(value));
}

function text(value) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (value && typeof value === "object" && typeof value._ === "string") {
    return value._.trim();
  }
  return "";
}

function directText(node, name) {
  for (const value of directValues(node, name)) {
    const result = text(value);
    if (result) {
      return result;
    }
  }
  return "";
}

function findElements(node, name, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) {
      findElements(item, name, found);
    }
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (localName(key) === name) {
        found.push(...values(value));
      } else {
        findElements(value, name, found);
      }
    }
  }
  return found;
}

function parseLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(value);
  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText, hourText = "00", minuteText = "00", secondText = "00", fraction = "0"] = match;
  const components = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = components;
  const millisecond = Math.floor(Number(`0.${fraction}`) * 1000);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  if (
    year < 1000 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }

  let date;
  try {
    date = businessDateTime(year, month, day, hour, minute, second, millisecond);
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
  const businessParts = getBusinessDateParts(date);
  if (
    businessParts.year !== year ||
    businessParts.month !== month ||
    businessParts.day !== day ||
    businessParts.hour !== hour ||
    businessParts.minute !== minute ||
    businessParts.second !== second
  ) {
    return null;
  }
  return date;
}

function dateKey(date) {
  return businessDateKey(date);
}

function productFor(ncm) {
  const value = text(ncm);
  return products.find((product) => value.startsWith(product.prefix))?.name ?? null;
}

function productTotals() {
  return Object.fromEntries(products.map(({ name }) => [name, 0]));
}

function emptyDashboard(now) {
  return {
    atualizadoEm: now.toISOString(),
    ofertas: {
      dataHoje: dateKey(now),
      dataAmanha: addDaysToDateKey(dateKey(now), 1),
      hoje: productTotals(),
      amanha: productTotals(),
    },
    patio: productTotals(),
    via: productTotals(),
    viaVeiculos: [],
    maisAntigos: [],
    permanencia: null,
  };
}

function uniqueVehicles(cargas, groupByProduct = true) {
  const unique = new Map();
  for (const carga of cargas) {
    const product = carga.produto;
    if (!product) {
      continue;
    }
    const vehicle = carga.placa ? carga.placa.toLocaleUpperCase("pt-BR") : carga.vehicleId;
    const key = `${groupByProduct ? `${product}:` : ""}${vehicle}`;
    const existing = unique.get(key);
    if (
      !existing ||
      (!groupByProduct &&
        carga.rastreamento &&
        (!existing.rastreamento || carga.rastreamento < existing.rastreamento))
    ) {
      unique.set(key, carga);
    }
  }
  return [...unique.values()];
}

function uniqueVehiclesByProduct(cargas) {
  const totals = productTotals();
  for (const { produto } of uniqueVehicles(cargas)) {
    totals[produto] += 1;
  }
  return totals;
}

function formatElapsed(milliseconds) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) {
    return `${days}d ${hours}h ${minutes}min`;
  }
  if (hours) {
    return `${hours}h ${minutes}min`;
  }
  return `${minutes}min`;
}

function oldestTracking(rastros, codigo) {
  return rastros
    .filter((rastro) => rastro.codigo === codigo && rastro.data)
    .map((rastro) => rastro.data)
    .sort((first, second) => first - second)[0] ?? null;
}

function makeDashboard(cargas, now) {
  const dashboard = emptyDashboard(now);
  const hoje = dateKey(now);
  const amanha = addDaysToDateKey(hoje, 1);
  const patio = [];
  const via = [];

  for (const [index, node] of cargas.entries()) {
    const classAnalise = directText(node, "classCarAnalise").toLocaleLowerCase("pt-BR");
    if (classAnalise === "refugado") {
      continue;
    }

    const product = productFor(directText(node, "produto"));
    if (!product) {
      continue;
    }

    const rastros = directValues(node, "listaRastros").flatMap((lista) =>
      directValues(lista, "rastro"),
    );
    const rastrosNormalizados = rastros.map((rastro) => ({
      codigo: directText(rastro, "rastro").toLocaleUpperCase("pt-BR"),
      data: parseLocalDateTime(directText(rastro, "dataRastreamento")),
    }));
    const possuiC60 = rastrosNormalizados.some(({ codigo }) => codigo === "C60");
    const saiuPatio = directText(node, "cargaSaiuPatio").toLocaleLowerCase("pt-BR") === "true";
    const possuiC80 = saiuPatio || rastrosNormalizados.some(({ codigo }) => codigo === "C80");
    const placa = directText(node, "placa");
    const vehicleId = placa ? null : `carga-${index}`;

    if (possuiC80) {
      via.push({
        produto: product,
        placa,
        vehicleId,
        rastreamento: oldestTracking(rastrosNormalizados, "C80"),
      });
    }

    if (possuiC60 && !possuiC80) {
      patio.push({
        produto: product,
        placa,
        vehicleId,
        rastreamento: oldestTracking(rastrosNormalizados, "C60"),
      });
    }

    const dataPrevista = parseLocalDateTime(directText(node, "dataPrevista"));
    if (!possuiC60 && dataPrevista) {
      const previsao = dateKey(dataPrevista);
      if (previsao === hoje) {
        dashboard.ofertas.hoje[product] += 1;
      } else if (previsao === amanha) {
        dashboard.ofertas.amanha[product] += 1;
      }
    }
  }

  dashboard.patio = uniqueVehiclesByProduct(patio);
  dashboard.via = uniqueVehiclesByProduct(via);
  dashboard.viaVeiculos = uniqueVehicles(via, false)
    .sort((first, second) => {
      if (!first.rastreamento) return 1;
      if (!second.rastreamento) return -1;
      return first.rastreamento - second.rastreamento;
    })
    .map(({ placa, produto, rastreamento }) => ({
      placa: placa || "Placa não informada",
      produto,
      dataRastreamento: rastreamento?.toISOString() ?? null,
    }));

  const ordenados = uniqueVehicles(patio, false)
    .filter(({ rastreamento }) => rastreamento)
    .sort((first, second) => first.rastreamento - second.rastreamento);
  dashboard.maisAntigos = ordenados.slice(0, 5).map(({ produto, placa, rastreamento }) => ({
    placa: placa || "Placa não informada",
    produto,
    dataRastreamento: rastreamento.toISOString(),
    permanencia: formatElapsed(now.getTime() - rastreamento.getTime()),
  }));
  if (ordenados.length) {
    dashboard.permanencia = {
      desde: ordenados[0].rastreamento.toISOString(),
      minutos: Math.max(0, Math.floor((now.getTime() - ordenados[0].rastreamento.getTime()) / 60000)),
      texto: formatElapsed(now.getTime() - ordenados[0].rastreamento.getTime()),
      placa: ordenados[0].placa || "Placa não informada",
      produto: ordenados[0].produto,
    };
  }

  return dashboard;
}

async function parseFilaResponse(xml, now = new Date()) {
  if (!xml.trim()) {
    return emptyDashboard(now);
  }

  let parsed;
  try {
    parsed = await xml2js.parseStringPromise(xml, {
      explicitArray: true,
      trim: true,
    });
  } catch (error) {
    throw new FilaXmlError("A resposta da API não contém XML válido.", { cause: error });
  }
  if (findElements(parsed, "Fault").length) {
    throw new FilaXmlError("A API da fila retornou uma falha SOAP.");
  }
  return makeDashboard(findElements(parsed, "carga"), now);
}

module.exports = { FilaXmlError, parseFilaResponse };
