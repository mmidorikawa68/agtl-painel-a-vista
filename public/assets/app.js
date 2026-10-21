const refreshIntervalMs = 15 * 60 * 1000;
const interactionResumeDelayMs = 5 * 1000;
const panelError = document.querySelector("#panel-error");
const carousel = document.querySelector("#carousel");
const dashboardFrame = document.querySelector("#dashboard-frame");
const carouselPosition = document.querySelector("#carousel-position");
const apiStatus = document.querySelector("#api-status");
const carouselProgress = document.querySelector("#carousel-progress");
const carouselProgressFill = document.querySelector("#carousel-progress-fill");

let dashboards = [];
let currentIndex = 0;
let rotationTimer;
let progressTimer;
let interactionTimer;
let apiRefreshTimer;
let currentApiData;
let interactionPaused = false;
let manuallyPaused = false;
let durationMs = 0;
let elapsedMs = 0;
let rotationStartedAt;

function updateProgress() {
  const elapsed = elapsedMs + (
    rotationStartedAt === undefined ? 0 : performance.now() - rotationStartedAt
  );
  const progress = durationMs > 0 ? Math.min(elapsed / durationMs, 1) : 0;
  carouselProgressFill.style.width = `${progress * 100}%`;
}

function stopRotation(preserveProgress) {
  window.clearTimeout(rotationTimer);
  window.clearInterval(progressTimer);
  if (preserveProgress && rotationStartedAt !== undefined) {
    elapsedMs += performance.now() - rotationStartedAt;
  }
  rotationStartedAt = undefined;
  updateProgress();
}

function startRotation() {
  if (dashboards.length < 2 || interactionPaused || manuallyPaused) {
    return;
  }

  rotationStartedAt = performance.now();
  rotationTimer = window.setTimeout(
    () => moveCarousel(1),
    Math.max(durationMs - elapsedMs, 0),
  );
  progressTimer = window.setInterval(updateProgress, 50);
}

function updatePauseButton() {
  carouselProgress.setAttribute(
    "aria-label",
    manuallyPaused ? "Continuar carrossel" : "Pausar carrossel",
  );
  carouselProgress.setAttribute("aria-pressed", String(manuallyPaused));
  carouselProgress.classList.toggle("is-paused", manuallyPaused);
}

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
  stopRotation(false);
  const dashboard = dashboards[currentIndex];
  durationMs = dashboard.duracaoSegundos * 1000;
  elapsedMs = 0;
  carouselPosition.textContent = `${currentIndex + 1} / ${dashboards.length}`;
  dashboardFrame.title = dashboard.titulo;
  dashboardFrame.src = `/api/dashboards/${encodeURIComponent(dashboard.id)}/content`;
  updatePauseButton();
  updateProgress();
  startRotation();
}

function moveCarousel(direction) {
  currentIndex = (currentIndex + direction + dashboards.length) % dashboards.length;
  updateCarousel();
}

function pauseCarouselForInteraction(event) {
  if (
    dashboards.length < 2
    || manuallyPaused
    || event.target?.closest?.("#carousel-progress")
  ) {
    return;
  }

  interactionPaused = true;
  stopRotation(true);
  window.clearTimeout(interactionTimer);
  interactionTimer = window.setTimeout(() => {
    interactionPaused = false;
    startRotation();
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
carouselProgress.addEventListener("click", () => {
  manuallyPaused = !manuallyPaused;
  interactionPaused = false;
  window.clearTimeout(interactionTimer);
  if (manuallyPaused) {
    stopRotation(true);
  } else {
    startRotation();
  }
  updatePauseButton();
});
listenForInteraction(document);

void loadPanel();
