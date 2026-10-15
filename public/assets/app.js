const refreshIntervalMs = 15 * 60 * 1000;
const interactionResumeDelayMs = 5 * 1000;
const panelError = document.querySelector("#panel-error");
const carousel = document.querySelector("#carousel");
const dashboardFrame = document.querySelector("#dashboard-frame");
const carouselPosition = document.querySelector("#carousel-position");
const apiStatus = document.querySelector("#api-status");

let dashboards = [];
let currentIndex = 0;
let rotationTimer;
let interactionTimer;
let apiRefreshTimer;
let currentApiData;
let interactionPaused = false;

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.erro || "Não foi possível concluir a solicitação.");
  }
  return result;
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = false;
}

function updateCarousel() {
  if (!dashboards.length) {
    return;
  }
  const dashboard = dashboards[currentIndex];
  carouselPosition.textContent = `${currentIndex + 1} / ${dashboards.length}`;
  dashboardFrame.title = dashboard.titulo;
  dashboardFrame.src = `/api/dashboards/${encodeURIComponent(dashboard.id)}/content`;
  window.clearTimeout(rotationTimer);
  if (dashboards.length > 1 && !interactionPaused) {
    rotationTimer = window.setTimeout(
      () => moveCarousel(1),
      dashboard.duracaoSegundos * 1000,
    );
  }
}

function moveCarousel(direction) {
  currentIndex = (currentIndex + direction + dashboards.length) % dashboards.length;
  updateCarousel();
}

function pauseCarouselForInteraction() {
  if (dashboards.length < 2) {
    return;
  }

  interactionPaused = true;
  window.clearTimeout(rotationTimer);
  window.clearTimeout(interactionTimer);
  interactionTimer = window.setTimeout(() => {
    interactionPaused = false;
    updateCarousel();
  }, interactionResumeDelayMs);
}

function listenForInteraction(target) {
  ["pointermove", "pointerdown", "keydown", "touchstart"].forEach((eventType) => {
    target.addEventListener(eventType, pauseCarouselForInteraction, { passive: true });
  });
}

async function refreshApiData() {
  try {
    const data = await request("/api/dashboard-data");
    currentApiData = data;
    apiStatus.textContent = `Dados da API atualizados às ${new Date().toLocaleTimeString("pt-BR")}`;
    dashboardFrame.contentWindow?.postMessage(
      { tipo: "dados-dashboard", dados: data },
      window.location.origin,
    );
  } catch (error) {
    apiStatus.textContent = `API: ${error.message}`;
  }
}

dashboardFrame.addEventListener("load", () => {
  if (dashboardFrame.contentDocument) {
    listenForInteraction(dashboardFrame.contentDocument);
  }
  if (currentApiData !== undefined) {
    dashboardFrame.contentWindow?.postMessage(
      { tipo: "dados-dashboard", dados: currentApiData },
      window.location.origin,
    );
  }
});

async function loadPanel() {
  try {
    dashboards = await request("/api/dashboards");
    if (!dashboards.length) {
      throw new Error("Nenhum dashboard está configurado.");
    }
    panelError.hidden = true;
    currentIndex = 0;
    carousel.hidden = false;
    updateCarousel();
    window.clearInterval(apiRefreshTimer);
    void refreshApiData();
    apiRefreshTimer = window.setInterval(() => void refreshApiData(), refreshIntervalMs);
  } catch (error) {
    showError(panelError, error.message);
  }
}

document.querySelector("#previous-button").addEventListener("click", () => moveCarousel(-1));
document.querySelector("#next-button").addEventListener("click", () => moveCarousel(1));
listenForInteraction(document);

void loadPanel();
