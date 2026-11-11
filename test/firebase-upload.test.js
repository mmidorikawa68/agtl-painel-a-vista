const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { uploadAnnualDescargasJson } = require("../firebase-upload");

test("autentica com service account e substitui o nó do Realtime Database", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agtl-firebase-"));
  const credentialPath = path.join(directory, "service-account.json");
  const dataPath = path.join(directory, "descarga_por_turno_2026.json");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const originalFetch = global.fetch;
  const originalCredentialPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const originalDatabaseUrl = process.env.FIREBASE_DATABASE_URL;
  const uploaded = {};

  await fs.writeFile(credentialPath, JSON.stringify({
    client_email: "firebase-uploader@example.test",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    token_uri: "https://oauth.example.test/token",
  }));
  await fs.writeFile(dataPath, JSON.stringify({
    ano: 2026,
    atualizadoEm: "2026-11-10T12:00:00.000Z",
    dias: [],
  }));
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH = credentialPath;
  process.env.FIREBASE_DATABASE_URL =
    "https://agtl-painel-a-vista-default-rtdb.firebaseio.com/";
  global.fetch = async (url, options) => {
    const requestUrl = new URL(url);
    if (options.method === "POST") {
      assert.equal(requestUrl.href, "https://oauth.example.test/token");
      const requestBody = new URLSearchParams(options.body);
      const assertion = requestBody.get("assertion");
      const [encodedHeader, encodedClaims, signature] = assertion.split(".");
      const signingInput = `${encodedHeader}.${encodedClaims}`;
      assert.equal(
        crypto.verify(
          "RSA-SHA256",
          Buffer.from(signingInput),
          publicKey,
          Buffer.from(signature, "base64url"),
        ),
        true,
      );
      const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"));
      assert.equal(claims.iss, "firebase-uploader@example.test");
      assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.database");
      return new Response(JSON.stringify({ access_token: "test-access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    assert.equal(options.method, "PUT");
    assert.equal(
      requestUrl.origin,
      "https://agtl-painel-a-vista-default-rtdb.firebaseio.com",
    );
    assert.equal(requestUrl.pathname, "/dashboards/descarga_por_turno_2026.json");
    assert.equal(requestUrl.searchParams.get("access_token"), "test-access-token");
    uploaded.data = JSON.parse(options.body);
    return new Response(JSON.stringify(uploaded.data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await uploadAnnualDescargasJson(dataPath, 2026);
    assert.deepEqual(result, {
      databasePath: "/dashboards/descarga_por_turno_2026",
      fileName: "descarga_por_turno_2026.json",
    });
    assert.deepEqual(uploaded.data, {
      ano: 2026,
      atualizadoEm: "2026-11-10T12:00:00.000Z",
      dias: [],
    });
  } finally {
    global.fetch = originalFetch;
    if (originalCredentialPath === undefined) {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    } else {
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH = originalCredentialPath;
    }
    if (originalDatabaseUrl === undefined) {
      delete process.env.FIREBASE_DATABASE_URL;
    } else {
      process.env.FIREBASE_DATABASE_URL = originalDatabaseUrl;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("falha explicitamente sem configurar o caminho da service account", async () => {
  const originalCredentialPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  try {
    await assert.rejects(
      uploadAnnualDescargasJson("unused.json", 2026),
      /Configure FIREBASE_SERVICE_ACCOUNT_PATH/,
    );
  } finally {
    if (originalCredentialPath !== undefined) {
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH = originalCredentialPath;
    }
  }
});
