// src/db.js
const { Pool } = require("pg");

const useSsl = String(process.env.DB_SSL).toLowerCase() === "true";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});

module.exports = { pool };
