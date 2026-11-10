const crypto = require("crypto");
const fs = require("fs/promises");
const bcrypt = require("bcryptjs");

const SESSION_DURATION_SECONDS = 8 * 60 * 60;

function createSessionToken(email, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    email: email.toLowerCase(),
    expiresAt: Math.floor(now / 1000) + SESSION_DURATION_SECONDS,
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readSessionEmail(token, secret, now = Date.now()) {
  if (typeof token !== "string") {
    return null;
  }

  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) {
    return null;
  }

  const expectedSignature = crypto.createHmac("sha256", secret).update(payload).digest();
  let actualSignature;
  try {
    actualSignature = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (
    actualSignature.length !== expectedSignature.length
    || !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof session.email !== "string"
      || !session.email
      || !Number.isInteger(session.expiresAt)
      || session.expiresAt <= Math.floor(now / 1000)
    ) {
      return null;
    }
    return session.email.toLowerCase();
  } catch {
    return null;
  }
}

function isUserEnabled(user) {
  return Boolean(user)
    && typeof user.Status === "string"
    && ["ativo", "habilitado"].includes(user.Status.trim().toLowerCase());
}

function getPublicUser(user) {
  return {
    Nome: user.Nome,
    Email: user.Email,
    Permissao: user.Permissao,
    Status: user.Status,
  };
}

async function loadUsers(usersFile) {
  const users = JSON.parse(await fs.readFile(usersFile, "utf8"));
  if (!Array.isArray(users)) {
    throw new Error("O cadastro de usuários deve ser uma lista.");
  }
  return users;
}

async function authenticateUser(email, password, usersFile) {
  const normalizedEmail = email.trim().toLowerCase();
  const users = await loadUsers(usersFile);
  const user = users.find((item) =>
    item
    && typeof item.Email === "string"
    && item.Email.trim().toLowerCase() === normalizedEmail
  );
  if (
    !user
    || typeof user.Senha !== "string"
    || typeof password !== "string"
    || !await bcrypt.compare(password, user.Senha)
    || !isUserEnabled(user)
  ) {
    return null;
  }
  return getPublicUser(user);
}

async function findEnabledUser(email, usersFile) {
  const users = await loadUsers(usersFile);
  const user = users.find((item) =>
    item
    && typeof item.Email === "string"
    && item.Email.trim().toLowerCase() === email.toLowerCase()
    && isUserEnabled(item)
  );
  return user ? getPublicUser(user) : null;
}

module.exports = {
  SESSION_DURATION_SECONDS,
  authenticateUser,
  createSessionToken,
  findEnabledUser,
  readSessionEmail,
};
