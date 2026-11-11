const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const tokenScope = "https://www.googleapis.com/auth/firebase.database";

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function loadServiceAccount() {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!serviceAccountPath) {
    throw new Error(
      "Configure FIREBASE_SERVICE_ACCOUNT_PATH com o caminho local do JSON da service account.",
    );
  }

  let contents;
  try {
    contents = await fs.readFile(serviceAccountPath, "utf8");
  } catch (error) {
    throw new Error(
      `Não foi possível ler a service account Firebase em ${serviceAccountPath}.`,
      { cause: error },
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(contents);
  } catch (error) {
    throw new Error("O arquivo da service account Firebase não contém JSON válido.", {
      cause: error,
    });
  }

  if (
    typeof serviceAccount.client_email !== "string" ||
    typeof serviceAccount.private_key !== "string" ||
    typeof serviceAccount.token_uri !== "string"
  ) {
    throw new Error(
      "O JSON da service account precisa conter client_email, private_key e token_uri.",
    );
  }
  return serviceAccount;
}

async function requestAccessToken(serviceAccount) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = encodeBase64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: tokenScope,
    aud: serviceAccount.token_uri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  let signature;
  try {
    signature = crypto.sign(
      "RSA-SHA256",
      Buffer.from(signingInput),
      serviceAccount.private_key,
    );
  } catch (error) {
    throw new Error("Não foi possível assinar a autenticação da service account Firebase.", {
      cause: error,
    });
  }
  const assertion = `${signingInput}.${signature.toString("base64url")}`;
  let response;
  try {
    response = await fetch(serviceAccount.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new Error("Falha ao solicitar token OAuth para o Firebase.", { cause: error });
  }

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `Autenticação Firebase recusada (HTTP ${response.status}): ${responseBody.slice(0, 500)}`,
    );
  }

  let tokenResult;
  try {
    tokenResult = JSON.parse(responseBody);
  } catch (error) {
    throw new Error("A resposta OAuth do Firebase não contém JSON válido.", { cause: error });
  }
  if (typeof tokenResult.access_token !== "string" || !tokenResult.access_token) {
    throw new Error("A resposta OAuth do Firebase não contém access_token.");
  }
  return tokenResult.access_token;
}

async function uploadAnnualDescargasJson(filePath, year) {
  const serviceAccount = await loadServiceAccount();
  const accessToken = await requestAccessToken(serviceAccount);
  let dashboard;
  try {
    dashboard = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Não foi possível ler o JSON anual para upload: ${filePath}.`, {
      cause: error,
    });
  }
  if (!dashboard || dashboard.ano !== year || !Array.isArray(dashboard.dias)) {
    throw new Error(`O JSON anual de descargas não corresponde ao ano ${year}.`);
  }

  let endpoint;
  try {
    const databaseUrl =
      process.env.FIREBASE_DATABASE_URL ||
      "https://agtl-painel-a-vista-default-rtdb.firebaseio.com";
    const baseUrl = new URL(databaseUrl);
    if (baseUrl.protocol !== "https:") {
      throw new Error("A URL do Realtime Database deve usar HTTPS.");
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/dashboards/descarga_por_turno_${year}.json`;
    baseUrl.searchParams.set("access_token", accessToken);
    endpoint = baseUrl;
  } catch (error) {
    throw new Error("FIREBASE_DATABASE_URL não é uma URL HTTPS válida.", { cause: error });
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dashboard),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new Error("Falha ao enviar o JSON anual ao Firebase.", { cause: error });
  }

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `O Firebase recusou o upload (HTTP ${response.status}): ${responseBody.slice(0, 500)}`,
    );
  }

  return {
    databasePath: `/dashboards/descarga_por_turno_${year}`,
    fileName: path.basename(filePath),
  };
}

module.exports = { uploadAnnualDescargasJson };
