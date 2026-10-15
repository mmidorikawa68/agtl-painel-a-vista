const productNames = ["Soja", "Milho"];
const numberFormatter = new Intl.NumberFormat("pt-BR");
const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
});
const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
let currentDashboardData;

function setText(selector, value) {
  document.querySelector(selector).textContent = value;
}

function formatDate(date) {
  return dateFormatter.format(new Date(`${date}T12:00:00`));
}

function formatCount(count) {
  return count > 0 ? numberFormatter.format(count) : "---";
}

function totalForVisibleProducts(counts) {
  const total = productNames.reduce((sum, product) => sum + (counts[product] || 0), 0);
  return formatCount(total);
}

function formatElapsed(since, now = Date.now()) {
  if (!since) {
    return "---";
  }
  const totalMinutes = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60000));
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

function updateStayHighlight(permanencia) {
  const timeElement = document.querySelector("#stay-time");
  const vehicleElement = document.querySelector("#stay-vehicle");
  if (!permanencia) {
    timeElement.textContent = "---";
    timeElement.className = "stay-time";
    timeElement.style.removeProperty("color");
    vehicleElement.textContent = "---";
    return;
  }

  const elapsedMinutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(permanencia.desde).getTime()) / 60000),
  );
  timeElement.textContent = formatElapsed(permanencia.desde);
  timeElement.className = elapsedMinutes >= 16 * 60
    ? "stay-time stay-critical"
    : "stay-time";
  vehicleElement.textContent = `${permanencia.placa} - ${permanencia.produto}`;

  if (elapsedMinutes <= 10 * 60) {
    timeElement.style.removeProperty("color");
    return;
  }

  const progress = Math.min((elapsedMinutes - 10 * 60) / (6 * 60), 1);
  const start = { red: 238, green: 153, blue: 153 };
  const end = { red: 176, green: 0, blue: 0 };
  const color = Object.fromEntries(
    Object.entries(start).map(([channel, value]) => [
      channel,
      Math.round(value + (end[channel] - value) * progress),
    ]),
  );
  timeElement.style.color = `rgb(${color.red} ${color.green} ${color.blue})`;
}

function renderProductCounts(container, counts, style) {
  container.replaceChildren();
  for (const product of productNames) {
    const item = document.createElement("div");
    item.className = style;
    const name = document.createElement("span");
    name.className = "product-name";
    name.textContent = product;
    const count = document.createElement("strong");
    count.textContent = formatCount(counts[product] || 0);
    item.append(name, count);
    container.append(item);
  }
}

function renderOldest(vehicles) {
  const list = document.querySelector("#oldest-list");
  list.replaceChildren();
  if (!vehicles.length) {
    const empty = document.createElement("li");
    empty.className = "oldest-empty";
    empty.textContent = "---";
    list.append(empty);
    return;
  }

  for (const vehicle of vehicles) {
    const item = document.createElement("li");
    item.className = "oldest-item";
    item.textContent = `${vehicle.placa} - ${vehicle.produto} - ${vehicle.permanencia}`;
    list.append(item);
  }
}

function renderTransit(vehicles) {
  const list = document.querySelector("#transit-list");
  list.replaceChildren();
  if (!vehicles.length) {
    const empty = document.createElement("li");
    empty.className = "oldest-empty";
    empty.textContent = "---";
    list.append(empty);
    return;
  }

  for (const vehicle of vehicles) {
    const item = document.createElement("li");
    item.textContent = `${vehicle.placa} - ${vehicle.produto} - ${formatElapsed(vehicle.dataRastreamento)}`;
    if (vehicle.dataRastreamento) {
      item.dataset.rastreamento = vehicle.dataRastreamento;
    }
    item.dataset.placa = vehicle.placa;
    item.dataset.produto = vehicle.produto;
    list.append(item);
  }
}

function renderDashboard(data) {
  currentDashboardData = data;
  setText("#updated-at", dateTimeFormatter.format(new Date(data.atualizadoEm)));
  setText("#today-date", formatDate(data.ofertas.dataHoje));
  setText("#tomorrow-date", formatDate(data.ofertas.dataAmanha));
  renderProductCounts(document.querySelector("#today-offers"), data.ofertas.hoje, "product-tile");
  renderProductCounts(document.querySelector("#tomorrow-offers"), data.ofertas.amanha, "product-tile");
  renderProductCounts(document.querySelector("#yard-counts"), data.patio, "status-count");
  renderProductCounts(document.querySelector("#via-counts"), data.via, "status-count");
  setText("#via-total", totalForVisibleProducts(data.via));
  setText("#yard-total", totalForVisibleProducts(data.patio));
  setText("#today-offers-total", totalForVisibleProducts(data.ofertas.hoje));
  setText("#tomorrow-offers-total", totalForVisibleProducts(data.ofertas.amanha));
  renderOldest(data.maisAntigos);
  renderTransit(data.viaVeiculos);

  updateStayHighlight(data.permanencia);
}

function refreshElapsedTimes() {
  if (!currentDashboardData) {
    return;
  }

  updateStayHighlight(currentDashboardData.permanencia);

  for (const item of document.querySelectorAll("#transit-list li[data-rastreamento]")) {
    item.textContent = `${item.dataset.placa} - ${item.dataset.produto} - ${formatElapsed(item.dataset.rastreamento)}`;
  }
}

window.addEventListener("message", (event) => {
  if (
    event.origin !== window.location.origin ||
    event.data?.tipo !== "dados-dashboard" ||
    !event.data.dados
  ) {
    return;
  }
  renderDashboard(event.data.dados);
});
window.setInterval(refreshElapsedTimes, 60 * 1000);

async function refreshStandaloneDashboard() {
  const updatedAt = document.querySelector("#updated-at");
  try {
    const response = await fetch("/api/dashboard-data");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.erro || "Falha ao consultar a API.");
    }
    renderDashboard(data);
  } catch (error) {
    updatedAt.textContent = `Falha ao atualizar: ${error.message}`;
  }
}

if (window.parent === window) {
  void refreshStandaloneDashboard();
  window.setInterval(() => void refreshStandaloneDashboard(), 15 * 60 * 1000);
}
