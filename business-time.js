const timeZone = "America/Sao_Paulo";
const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function getBusinessDateParts(date) {
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );
}

function dateKeyFromParts(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function businessDateKey(date) {
  const { year, month, day } = getBusinessDateParts(date);
  return dateKeyFromParts(year, month, day);
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return dateKeyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function businessDateTime(year, month, day, hour, minute, second = 0, millisecond = 0) {
  const wallTime = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let timestamp = wallTime;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = getBusinessDateParts(new Date(timestamp));
    const representedTime = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      millisecond,
    );
    const adjustment = wallTime - representedTime;
    if (adjustment === 0) {
      return new Date(timestamp);
    }
    timestamp += adjustment;
  }

  throw new RangeError("Não foi possível interpretar o horário no fuso America/Sao_Paulo.");
}

module.exports = { addDaysToDateKey, businessDateKey, businessDateTime, getBusinessDateParts };
