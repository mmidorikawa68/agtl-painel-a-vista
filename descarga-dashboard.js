const shiftDefinitions = [
  { name: "A", start: 7 * 60, end: 15 * 60 + 20 },
  { name: "B", start: 15 * 60 + 20, end: 23 * 60 + 28 },
  { name: "C", start: 23 * 60 + 28, end: 24 * 60 + 7 * 60 },
];

function dateKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getOperationalShift(date) {
  const { year, month, day, hour, minute } = getBusinessDateParts(date);
  const minuteOfDay = hour * 60 + minute;
  let shift;
  const operationalDate = new Date(Date.UTC(year, month - 1, day));

  if (minuteOfDay < 7 * 60) {
    shift = "C";
    operationalDate.setUTCDate(operationalDate.getUTCDate() - 1);
  } else {
    shift = shiftDefinitions.find(
      (definition) => minuteOfDay >= definition.start && minuteOfDay < definition.end,
    )?.name;
  }

  if (!shift) {
    throw new Error("Não foi possível classificar o horário em um turno.");
  }

  return { data: dateKey(operationalDate), turno: shift };
}

function getFinalShift(turno, turnofolga) {
  const dayOffShift = typeof turnofolga === "string" ? turnofolga.trim().toUpperCase() : "";
  return turno === dayOffShift ? "F" : turno;
}

function normalizeProduct(product) {
  const value = typeof product === "string" ? product.trim() : "";
  if (!value) {
    return "Não classificado";
  }

  const normalized = value.toLocaleLowerCase("pt-BR");
  if (normalized.includes("soja")) {
    return "Soja";
  }
  if (normalized.includes("milho")) {
    return "Milho";
  }
  return value;
}

function emptyDay(data) {
  return {
    data,
    turnos: { A: 0, B: 0, C: 0, F: 0 },
    quantidade: 0,
    pesoKg: null,
    produtos: {},
  };
}

function addProductMetric(products, product, weight) {
  if (!products[product]) {
    products[product] = { quantidade: 0, pesoKg: null };
  }
  products[product].quantidade += 1;
  if (weight !== null) {
    products[product].pesoKg = (products[product].pesoKg ?? 0) + weight;
  }
}

function summarizeDays(days) {
  const totals = {
    turnos: { A: 0, B: 0, C: 0, F: 0 },
    quantidade: 0,
    pesoKg: null,
    produtos: {},
  };

  for (const day of days) {
    for (const shift of ["A", "B", "C", "F"]) {
      totals.turnos[shift] += day.turnos[shift];
    }
    totals.quantidade += day.quantidade;
    if (day.pesoKg != null) {
      totals.pesoKg = (totals.pesoKg ?? 0) + day.pesoKg;
    }
    for (const [product, metric] of Object.entries(day.produtos ?? {})) {
      if (!totals.produtos[product]) {
        totals.produtos[product] = { quantidade: 0, pesoKg: null };
      }
      totals.produtos[product].quantidade += metric.quantidade;
      if (metric.pesoKg != null) {
        totals.produtos[product].pesoKg =
          (totals.produtos[product].pesoKg ?? 0) + metric.pesoKg;
      }
    }
  }

  return totals;
}

function selectDescargasDashboardForPeriod(annualData, year, month) {
  if (
    !annualData ||
    annualData.ano !== year ||
    !Array.isArray(annualData.dias) ||
    !annualData.turnoAtual
  ) {
    throw new Error(`Arquivo anual de descargas inválido para ${year}.`);
  }

  const monthPrefix = month === 0 ? null : `${year}-${String(month).padStart(2, "0")}-`;
  const days = monthPrefix
    ? annualData.dias.filter((day) => day.data.startsWith(monthPrefix))
    : annualData.dias;

  return {
    atualizadoEm: annualData.atualizadoEm,
    ano: year,
    mes: month,
    turnoAtual: annualData.turnoAtual,
    dias: days,
    totais: summarizeDays(days),
  };
}

function mergeAnnualDescargasDashboard(existingData, refreshedData, startDate, throughDate) {
  const existingDays = new Map((existingData?.dias || []).map((day) => [day.data, day]));
  const days = refreshedData.dias.map((day) => {
    if (day.data < startDate || day.data > throughDate) {
      return existingDays.get(day.data) || day;
    }
    return day;
  });

  return {
    ...refreshedData,
    dias: days,
    totais: summarizeDays(days),
  };
}

function buildDescargasDashboard(rows, year, month, now = new Date(), currentTurnofolga) {
  const firstMonth = month === 0 ? 0 : month - 1;
  const dayCount = month === 0
    ? (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000
    : new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = Array.from({ length: dayCount }, (_, index) => {
    const day = new Date(Date.UTC(year, firstMonth, index + 1));
    return emptyDay(dateKey(day));
  });
  const daysByDate = new Map(days.map((day) => [day.data, day]));
  const monthlyProducts = {};
  const totals = { turnos: { A: 0, B: 0, C: 0, F: 0 }, quantidade: 0, pesoKg: null };
  const currentShift = getOperationalShift(now);
  const currentDayRow = rows.find((row) => row.data_turno === currentShift.data);
  const currentShiftData = {
    turno: getFinalShift(
      currentShift.turno,
      currentTurnofolga ?? currentDayRow?.turnofolga,
    ),
    turnoBase: currentShift.turno,
    data: currentShift.data,
    produtos: { Soja: 0, Milho: 0 },
    pesoKg: null,
    quantidade: 0,
  };

  for (const row of rows) {
    const weight = row.pesoliquido === null ? null : Number(row.pesoliquido);
    if (weight !== null && !Number.isFinite(weight)) {
      throw new Error("A consulta retornou um peso líquido inválido.");
    }
    const product = normalizeProduct(row.produto);
    const finalShift = getFinalShift(row.turno_base, row.turnofolga);

    if (row.data_turno === currentShift.data && finalShift === currentShiftData.turno) {
      currentShiftData.quantidade += 1;
      if (product === "Soja" || product === "Milho") {
        currentShiftData.produtos[product] += 1;
        if (weight !== null) {
          currentShiftData.pesoKg = (currentShiftData.pesoKg ?? 0) + weight;
        }
      }
    }

    const day = daysByDate.get(row.data_turno);
    if (!day) {
      continue;
    }

    day.turnos[finalShift] += 1;
    day.quantidade += 1;
    totals.turnos[finalShift] += 1;
    totals.quantidade += 1;

    if (weight !== null) {
      day.pesoKg = (day.pesoKg ?? 0) + weight;
      totals.pesoKg = (totals.pesoKg ?? 0) + weight;
    }

    addProductMetric(day.produtos, product, weight);
    addProductMetric(monthlyProducts, product, weight);
  }

  return {
    atualizadoEm: now.toISOString(),
    ano: year,
    mes: month,
    turnoAtual: currentShiftData,
    dias: days,
    totais: { ...totals, produtos: monthlyProducts },
  };
}

function getOperationalDateFromTimestamp(timestamp) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(String(timestamp));
  if (!match) {
    throw new Error(`Data de saída inválida para determinar o turno: ${timestamp}.`);
  }
  return Number(match[2]) < 7 ? addDaysToDateKey(match[1], -1) : match[1];
}

module.exports = {
  buildDescargasDashboard,
  getOperationalDateFromTimestamp,
  getOperationalShift,
  mergeAnnualDescargasDashboard,
  selectDescargasDashboardForPeriod,
};
const { addDaysToDateKey, getBusinessDateParts } = require("./business-time");
