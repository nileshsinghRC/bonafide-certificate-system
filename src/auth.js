// src/auth.js
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = process.env.JWT_EXPIRY || "8h";

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set — refusing to start without it.");
}

function signToken(user) {
  return jwt.sign(
    { sub: user.user_id, role: user.role_code, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

// Verifies the bearer token and attaches { userId, role, name } to req.auth.
// Does NOT hit the database — route handlers that need the fresh user row
// (e.g. to check `active`) should look it up explicitly.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: { code: "NO_TOKEN", message: "Missing bearer token." } });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = { userId: payload.sub, role: payload.role, name: payload.name };
    next();
  } catch (e) {
    return res.status(401).json({ error: { code: "INVALID_TOKEN", message: "Session expired or invalid — please sign in again." } });
  }
}

// RBAC gate — call as requireRole('registrar_admin','super_admin')
function requireRole() {
  const allowed = Array.prototype.slice.call(arguments);
  return function (req, res, next) {
    if (!req.auth || allowed.indexOf(req.auth.role) === -1) {
      return res.status(403).json({ error: { code: "FORBIDDEN", message: "Your role does not permit this action." } });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requireRole };
