const assert = require("node:assert/strict");
const test = require("node:test");
const { parseCargaFileName, parseDescargaXml } = require("../xml-import");

function createEnvelope(fields) {
  const payload = Object.entries(fields)
    .map(([name, value]) => `<${name}>${value}</${name}>`)
    .join("");
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body><SendRest><Request><PostData><![CDATA[
      <soap:Envelope><soap:Body><processarEntradaTerminalPrivado>
        ${payload}
      </processarEntradaTerminalPrivado></soap:Body></soap:Envelope>
    ]]></PostData></Request></SendRest></soap:Body>
  </soap:Envelope>`;
}

test("extrai idcarga de nomes válidos e ignora outros arquivos", () => {
  assert.equal(parseCargaFileName("SendRest_407849.xml"), 407849);
  assert.equal(parseCargaFileName("sendrest_123.xml"), 123);
  assert.equal(parseCargaFileName("outro_407849.xml"), null);
  assert.equal(parseCargaFileName("SendRest_sem-id.xml"), null);
  assert.throws(() => parseCargaFileName("SendRest_99999999999.xml"), /ID de carga inválido/);
});

test("mapeia somente os campos de descargas a partir do PostData SOAP", async () => {
  const xml = createEnvelope({
    idCarga: "407849",
    dataPesoEntrada: "08/10/2026",
    horaPesoEntrada: "21:59",
    pesoEntrada: "73790",
    dataPesoSaida: "09/10/2026",
    horaPesoSaida: "00:00",
    pesoSaida: "26600",
    ncmProduto: "10059002",
    nomeCliente: "Cliente de teste",
    placaCavalo: "ABC1D23",
    placaCarreta: "EFG4H56",
    placaCarreta2: "IJK7L89",
    chaveAcesso: "nao-deve-ser-persistida",
    nomeMotorista: "Motorista de teste",
  });

  const result = await parseDescargaXml(xml);
  assert.deepEqual(result, {
    idcarga: 407849,
    dataentrada: "2026-10-08 21:59:00",
    pesoentrada: 73790,
    datasaida: "2026-10-09 00:00:00",
    pesosaida: 26600,
    pesoliquido: 47190,
    produto: "10059002",
    cliente: "Cliente de teste",
    placacavalo: "ABC1D23",
    placacarreta1: "EFG4H56",
    placacarreta2: "IJK7L89",
    placacarreta3: null,
  });
});

test("rejeita carga sem identificador ou com data inválida", async () => {
  const incomplete = createEnvelope({
    dataPesoEntrada: "08/10/2026",
    horaPesoEntrada: "21:59",
    dataPesoSaida: "09/10/2026",
    horaPesoSaida: "00:00",
  });
  await assert.rejects(parseDescargaXml(incomplete), /idCarga/);

  const invalidDate = createEnvelope({
    idCarga: "1",
    dataPesoEntrada: "31/02/2026",
    horaPesoEntrada: "21:59",
    dataPesoSaida: "09/10/2026",
    horaPesoSaida: "00:00",
  });
  await assert.rejects(parseDescargaXml(invalidDate), /Data ou hora/);
});
