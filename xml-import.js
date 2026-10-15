const xml2js = require("xml2js");

function parseCargaFileName(fileName) {
  const match = /^SendRest_(\d+)\.xml$/i.exec(fileName);
  if (!match) {
    return null;
  }

  const idcarga = Number(match[1]);
  if (!Number.isSafeInteger(idcarga) || idcarga < 1 || idcarga > 2147483647) {
    throw new Error(`ID de carga inválido no nome do arquivo: ${fileName}.`);
  }
  return idcarga;
}

function localName(name) {
  return name.split(":").pop();
}

function textValue(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textValue(item);
      if (text !== null) {
        return text;
      }
    }
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (value && typeof value === "object") {
    if (typeof value._ === "string") {
      return value._.trim();
    }
    for (const child of Object.values(value)) {
      const text = textValue(child);
      if (text !== null) {
        return text;
      }
    }
  }
  return null;
}

function findElementText(node, wantedName) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const text = findElementText(item, wantedName);
      if (text !== null) {
        return text;
      }
    }
  } else if (node && typeof node === "object") {
    for (const [name, value] of Object.entries(node)) {
      if (localName(name) === wantedName) {
        const text = textValue(value);
        if (text !== null) {
          return text;
        }
      }
      const nestedText = findElementText(value, wantedName);
      if (nestedText !== null) {
        return nestedText;
      }
    }
  }
  return null;
}

function requiredField(xml, name) {
  const value = findElementText(xml, name);
  if (value === null || value === "") {
    throw new Error(`Campo obrigatório ausente no XML: ${name}.`);
  }
  return value;
}

function optionalField(xml, name) {
  const value = findElementText(xml, name);
  return value === "" ? null : value;
}

function integerField(xml, name, required = false) {
  const value = required ? requiredField(xml, name) : optionalField(xml, name);
  if (value === null) {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`Campo numérico inválido no XML: ${name}.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > 2147483647) {
    throw new Error(`Campo numérico fora do limite integer: ${name}.`);
  }
  return number;
}

function dateTimeField(xml, dateName, timeName) {
  const date = requiredField(xml, dateName);
  const time = requiredField(xml, timeName);
  const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!dateMatch || !timeMatch) {
    throw new Error(`Data ou hora inválida no XML: ${dateName}/${timeName}.`);
  }

  const [, dayText, monthText, yearText] = dateMatch;
  const [, hourText, minuteText, secondText = "00"] = timeMatch;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    year < 1000 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    throw new Error(`Data ou hora fora do intervalo válido: ${dateName}/${timeName}.`);
  }
  return `${yearText}-${monthText}-${dayText} ${hourText}:${minuteText}:${secondText}`;
}

async function parseDescargaXml(xml) {
  const envelope = await xml2js.parseStringPromise(xml);
  const postData = findElementText(envelope, "PostData");
  const payload = postData ? await xml2js.parseStringPromise(postData) : envelope;
  const pesoentrada = integerField(payload, "pesoEntrada");
  const pesosaida = integerField(payload, "pesoSaida");

  return {
    idcarga: integerField(payload, "idCarga", true),
    dataentrada: dateTimeField(payload, "dataPesoEntrada", "horaPesoEntrada"),
    pesoentrada,
    datasaida: dateTimeField(payload, "dataPesoSaida", "horaPesoSaida"),
    pesosaida,
    pesoliquido: pesoentrada === null || pesosaida === null ? null : pesoentrada - pesosaida,
    produto: optionalField(payload, "ncmProduto"),
    cliente: optionalField(payload, "nomeCliente"),
    placacavalo: optionalField(payload, "placaCavalo"),
    placacarreta1: optionalField(payload, "placaCarreta"),
    placacarreta2: optionalField(payload, "placaCarreta2"),
    placacarreta3: optionalField(payload, "placaCarreta3"),
  };
}

module.exports = { parseCargaFileName, parseDescargaXml };
