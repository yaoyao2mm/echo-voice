import crypto from "node:crypto";

const SESSION_PREFIX = "echo1";

export function publicUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || "user"
  };
}

export function findUser(users, username) {
  const normalized = String(username || "").trim().toLowerCase();
  return users.find((user) => user.username.toLowerCase() === normalized) || null;
}

export function validatePassword(user, password) {
  if (!user) return false;
  const candidate = String(password || "");
  if (user.passwordSha256) {
    return safeEqual(sha256(candidate), user.passwordSha256.toLowerCase());
  }
  return safeEqual(candidate, user.password || "");
}

export function createSessionToken({ user, secret, ttlMs }) {
  const now = Date.now();
  const payload = {
    sub: user.username,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || "user",
    iat: now,
    exp: now + ttlMs
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${SESSION_PREFIX}.${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifySessionToken({ token, users, secret }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_PREFIX) return null;

  const [, encodedPayload, signature] = parts;
  if (!safeEqual(signature, sign(encodedPayload, secret))) return null;

  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!payload?.username || !payload?.exp || Date.now() > payload.exp) return null;
  const user = findUser(users, payload.username);
  return user ? publicUser(user) : null;
}

export function bearerToken(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  const length = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const leftPadded = Buffer.alloc(length);
  const rightPadded = Buffer.alloc(length);
  leftBuffer.copy(leftPadded);
  rightBuffer.copy(rightPadded);
  return crypto.timingSafeEqual(leftPadded, rightPadded) && leftBuffer.length === rightBuffer.length;
}
