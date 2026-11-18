
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000
});

pool.on("error", (error) => {
  console.error("Error PostgreSQL:", error.code);
});

app.get("/", (req, res) => {
  res.json({
    aplicacion: "Mass Control",
    estado: "Servidor funcionando"
  });
});

app.get("/health/db", async (req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({
      postgresql: "sin_configurar"
    });
  }

  try {
    await pool.query(`
      SELECT COUNT(*) FROM mass_control.tiendas
      UNION ALL SELECT COUNT(*) FROM mass_control.cuentas
      UNION ALL SELECT COUNT(*) FROM mass_control.familias
      UNION ALL SELECT COUNT(*) FROM mass_control.productos
      UNION ALL SELECT COUNT(*) FROM mass_control.lotes
      UNION ALL SELECT COUNT(*) FROM mass_control.alertas
      UNION ALL SELECT COUNT(*) FROM mass_control.movimientos
    `);

    res.json({
      postgresql: "conectado"
    });
  } catch (error) {
    console.error("Error de base de datos:", error.code);

    res.status(503).json({
      postgresql: "no_disponible"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mass Control activo en puerto ${PORT}`);
});
