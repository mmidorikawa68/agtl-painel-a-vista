const monthNames = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];
const numberFormat = new Intl.NumberFormat("pt-BR");
const weightFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const yearInput = document.querySelector("#year");
const monthInput = document.querySelector("#month");
const form = document.querySelector("#period-filter");
const errorElement = document.querySelector("#load-error");

function formatQuantity(value) {
  return value > 0 ? numberFormat.format(value) : "---";
}

function formatWeight(value) {
  return value === null || value === undefined ? "---" : weightFormat.format(value);
}

function formatMonth(year, month) {
  if (month === 0) {
    return `Todos ${year}`;
  }
  const name = monthNames[month - 1];
  return `${name.charAt(0).toLocaleUpperCase("pt-BR")}${name.slice(1)} ${year}`;
}

function keepCurrentDateVisible() {
  const tableContainer = document.querySelector(".table-container");
  const currentDate = new Date();
  const selectedYear = Number(yearInput.value);
  const selectedMonth = Number(monthInput.value);

  if (
    selectedYear !== currentDate.getFullYear()
    || (selectedMonth !== 0 && selectedMonth !== currentDate.getMonth() + 1)
  ) {
    tableContainer.scrollTop = 0;
    return;
  }

  const currentDay = currentDate.getDate();
  const firstVisibleDay = currentDay <= 10 ? 1 : currentDay <= 20 ? 8 : 18;
  const visibleMonth = selectedMonth === 0 ? currentDate.getMonth() + 1 : selectedMonth;
  const targetDate = `${selectedYear}-${String(visibleMonth).padStart(2, "0")}-${String(firstVisibleDay).padStart(2, "0")}`;
  const row = document.querySelector(`#daily-rows tr[data-date="${targetDate}"]`);
  const tableHeader = tableContainer.querySelector("thead");

  if (!row || !tableHeader) {
    return;
  }

  tableContainer.scrollTop =
    tableContainer.scrollTop
    + row.getBoundingClientRect().top
    - tableContainer.getBoundingClientRect().top
    - tableContainer.clientTop
    - tableHeader.getBoundingClientRect().height;
}

function appendCell(row, value, header = false) {
  const cell = document.createElement(header ? "th" : "td");
  if (header) {
    cell.scope = "row";
  }
  cell.textContent = value;
  row.append(cell);
}

function render(data) {
  document.querySelector("#updated-at").textContent = new Date(data.atualizadoEm)
    .toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  document.querySelector("#mobile-month-label").textContent = formatMonth(data.ano, data.mes);
  const periodLabel = data.mes === 0 ? "Ano" : "Mês";
  const totalLabel = data.mes === 0 ? "Totais do Ano" : "Totais do Mês";
  document.querySelector("#mobile-period-heading").textContent = totalLabel;
  document.querySelector("#mobile-shift-heading").textContent =
    `Veículos por Turno no ${periodLabel}`;
  document.querySelector("#mobile-shift-totals").setAttribute(
    "aria-label",
    `Veículos por turno no ${periodLabel.toLocaleLowerCase("pt-BR")}`,
  );
  document.querySelector("#mobile-product-heading").textContent = totalLabel;
  const current = data.turnoAtual;
  document.querySelector("#current-shift").textContent =
    current.turno === "F" ? `F (horário do Turno ${current.turnoBase})` : current.turno;
  document.querySelector("#current-soja").textContent = formatQuantity(current.produtos.Soja);
  document.querySelector("#current-milho").textContent = formatQuantity(current.produtos.Milho);
  document.querySelector("#current-weight").textContent = formatWeight(current.pesoKg);

  const dailyRows = document.querySelector("#daily-rows");
  dailyRows.replaceChildren();
  for (const day of data.dias) {
    const row = document.createElement("tr");
    const [year, month, date] = day.data.split("-");
    row.dataset.date = day.data;
    appendCell(row, `${date}/${month}/${year}`);
    appendCell(row, formatQuantity(day.turnos.A));
    appendCell(row, formatQuantity(day.turnos.B));
    appendCell(row, formatQuantity(day.turnos.C));
    appendCell(row, formatQuantity(day.turnos.F));
    appendCell(row, formatQuantity(day.quantidade));
    appendCell(row, formatWeight(day.pesoKg));
    dailyRows.append(row);
  }

  const totalRow = document.createElement("tr");
  appendCell(totalRow, `TOTAL DO ${data.mes === 0 ? "ANO" : "MÊS"}`, true);
  for (const shift of ["A", "B", "C", "F"]) {
    appendCell(totalRow, formatQuantity(data.totais.turnos[shift]));
    document.querySelector(`#month-shift-${shift.toLowerCase()}`).textContent =
      formatQuantity(data.totais.turnos[shift]);
  }
  appendCell(totalRow, formatQuantity(data.totais.quantidade));
  appendCell(totalRow, formatWeight(data.totais.pesoKg));
  document.querySelector("#monthly-totals").replaceChildren(totalRow);

  const productTotals = document.querySelector("#product-totals");
  productTotals.replaceChildren();
  const products = Object.entries(data.totais.produtos);
  if (products.length === 0) {
    const empty = document.createElement("span");
    empty.className = "product-total";
    empty.textContent = "---";
    productTotals.append(empty);
  } else {
    for (const [name, values] of products) {
      const item = document.createElement("span");
      item.className = "product-total";
      item.append(document.createTextNode(`${name}: `));
      const summary = document.createElement("strong");
      summary.textContent =
        `${numberFormat.format(values.quantidade)} veículos · ${formatWeight(values.pesoKg)} kg`;
      item.append(summary);
      productTotals.append(item);
    }
  }
  document.querySelector("#month-soja").textContent =
    formatQuantity(data.totais.produtos.Soja?.quantidade || 0);
  document.querySelector("#month-milho").textContent =
    formatQuantity(data.totais.produtos.Milho?.quantidade || 0);
  document.querySelector("#month-quantity").textContent = formatQuantity(data.totais.quantidade);

  keepCurrentDateVisible();
}

async function loadData() {
  errorElement.hidden = true;
  const params = new URLSearchParams({
    ano: yearInput.value,
    mes: monthInput.value,
  });
  try {
    const response = await fetch(`/api/descargas-dashboard?${params}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.erro || "Não foi possível consultar as descargas.");
    }
    render(data);
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
}

const now = new Date();
const saoPauloDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "numeric",
}).formatToParts(now);
yearInput.value = saoPauloDate.find(({ type }) => type === "year").value;
monthInput.value = saoPauloDate.find(({ type }) => type === "month").value;
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadData();
});
const descargaEvents = new EventSource("/api/descargas-events");
descargaEvents.addEventListener("descargas-atualizadas", () => void loadData());
window.setInterval(() => void loadData(), 15 * 60 * 1000);
void loadData();
