const assert = require("node:assert/strict");
const test = require("node:test");
const { FilaXmlError, parseFilaResponse } = require("../fila-dashboard");

const now = new Date(2026, 9, 9, 12, 0, 0);

function createRastro(codigo, data) {
  return `<rastro><dataRastreamento>${data}</dataRastreamento><rastro>${codigo}</rastro></rastro>`;
}

function createCarga({
  produto = "10059002",
  placa = "ABC-1234",
  previsao = "2026-10-09 00:00:00.0",
  rastros = "",
  classe = "liberado",
  saiuPatio = false,
} = {}) {
  return `<carga>
    <cargaSaiuPatio>${saiuPatio}</cargaSaiuPatio>
    <classCarAnalise>${classe}</classCarAnalise>
    <dataPrevista>${previsao}</dataPrevista>
    <listaRastros>${rastros}</listaRastros>
    <placa>${placa}</placa>
    <produto>${produto}</produto>
  </carga>`;
}

function createResponse(...cargas) {
  return `<cargas>${cargas.join("")}</cargas>`;
}

test("resposta vazia produz indicadores zerados e data de atualização", async () => {
  const result = await parseFilaResponse(" \n", now);
  assert.equal(result.atualizadoEm, now.toISOString());
  assert.deepEqual(result.ofertas.hoje, { Milho: 0, Sorgo: 0, Trigo: 0, Soja: 0 });
  assert.deepEqual(result.patio, { Milho: 0, Sorgo: 0, Trigo: 0, Soja: 0 });
  assert.deepEqual(result.via, { Milho: 0, Sorgo: 0, Trigo: 0, Soja: 0 });
  assert.deepEqual(result.maisAntigos, []);
  assert.equal(result.permanencia, null);
});

test("agrega ofertas, PÁTIO, VIA e os cinco C60 mais antigos", async () => {
  const cargos = [
    createCarga({ placa: "MIL-0001" }),
    createCarga({ placa: "MIL-0002", previsao: "2026-10-10 00:00:00.0" }),
    createCarga({
      placa: "PAT-0001",
      rastros: createRastro("C60", "2026-10-09 06:00:30.8"),
    }),
    createCarga({
      placa: "PAT-0001",
      produto: "10059002",
      rastros: createRastro("C60", "2026-10-09 06:00:30.8"),
    }),
    createCarga({
      placa: "VIA-0001",
      produto: "10701000",
      rastros: `${createRastro("C60", "2026-10-09 05:00:00.0")}${createRastro("C80", "2026-10-09 10:00:00.0")}`,
    }),
    createCarga({
      placa: "OLD-0001",
      produto: "11041200",
      rastros: createRastro("C60", "2026-10-09 07:00:00.0"),
    }),
    ...["OLD-0002", "OLD-0003", "OLD-0004", "OLD-0005"].map((placa, index) =>
      createCarga({
        placa,
        produto: "11041200",
        rastros: createRastro("C60", `2026-10-09 ${String(8 + index).padStart(2, "0")}:00:00.0`),
      }),
    ),
    createCarga({ placa: "REF-0001", classe: "refugado" }),
  ];
  const result = await parseFilaResponse(createResponse(...cargos), now);

  assert.equal(result.ofertas.hoje.Milho, 1);
  assert.equal(result.ofertas.amanha.Milho, 1);
  assert.equal(result.patio.Milho, 1);
  assert.equal(result.patio.Soja, 0);
  assert.equal(result.patio.Trigo, 5);
  assert.equal(result.via.Sorgo, 1);
  assert.deepEqual(result.viaVeiculos, [{
    placa: "VIA-0001",
    produto: "Sorgo",
    dataRastreamento: new Date(2026, 9, 9, 10, 0, 0).toISOString(),
  }]);
  assert.equal(
    Math.floor((now.getTime() - new Date(result.viaVeiculos[0].dataRastreamento).getTime()) / 60000),
    120,
  );
  assert.equal(result.permanencia.desde, new Date(2026, 9, 9, 6, 0, 30, 800).toISOString());
  assert.equal(result.permanencia.texto, "5h 59min");
  assert.equal(result.permanencia.placa, "PAT-0001");
  assert.equal(result.permanencia.produto, "Milho");
  assert.equal(result.maisAntigos.length, 5);
  assert.equal(result.maisAntigos[0].placa, "PAT-0001");
  assert.equal(result.maisAntigos[0].produto, "Milho");
  assert.equal(result.maisAntigos[1].placa, "OLD-0001");
  assert.equal(result.maisAntigos[4].placa, "OLD-0004");
});

test("classifica os quatro prefixos NCM e ignora cargas refugadas", async () => {
  const result = await parseFilaResponse(
    createResponse(
      createCarga({ produto: "10059900", placa: "A" }),
      createCarga({ produto: "10709900", placa: "B" }),
      createCarga({ produto: "11049900", placa: "C" }),
      createCarga({ produto: "12019900", placa: "D" }),
      createCarga({ produto: "99999999", placa: "E" }),
      createCarga({ produto: "10059002", placa: "F", classe: "Refugado" }),
    ),
    now,
  );
  assert.deepEqual(result.ofertas.hoje, { Milho: 1, Sorgo: 1, Trigo: 1, Soja: 1 });
});

test("lista veículos com C80 mesmo quando o rastro não tem data", async () => {
  const result = await parseFilaResponse(
    createResponse(createCarga({
      placa: "VIA-0002",
      saiuPatio: true,
      rastros: "<rastro><rastro>C80</rastro></rastro>",
    })),
    now,
  );
  assert.deepEqual(result.viaVeiculos, [{
    placa: "VIA-0002",
    produto: "Milho",
    dataRastreamento: null,
  }]);
});

test("inclui no trânsito carga que saiu do pátio sem inventar o horário C80", async () => {
  const result = await parseFilaResponse(
    createResponse(createCarga({
      placa: "VIA-0003",
      saiuPatio: true,
    })),
    now,
  );
  assert.deepEqual(result.viaVeiculos, [{
    placa: "VIA-0003",
    produto: "Milho",
    dataRastreamento: null,
  }]);
  assert.equal(result.via.Milho, 1);
});

test("retorna erro explícito para XML inválido ou falha SOAP", async () => {
  await assert.rejects(parseFilaResponse("<cargas>"), FilaXmlError);
  await assert.rejects(
    parseFilaResponse("<Envelope><Body><Fault>erro</Fault></Body></Envelope>"),
    /falha SOAP/,
  );
});
