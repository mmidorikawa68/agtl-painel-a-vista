const message = document.querySelector("#login-message");
const params = new URLSearchParams(window.location.search);

if (params.has("erro")) {
  message.textContent = "E-mail ou senha inválidos, ou usuário desabilitado.";
  message.hidden = false;
} else if (params.has("expirada")) {
  message.textContent = "Sua sessão expirou. Entre novamente.";
  message.hidden = false;
}
