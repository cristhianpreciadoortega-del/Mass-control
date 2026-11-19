
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { rateLimit } = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

// ========================================
// CONEXION POSTGRESQL
// ========================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000
});

pool.on("error", (error) => {
  console.error("Error PostgreSQL:", error.code);
});

// ========================================
// ESTADO DEL SERVIDOR
// ========================================

app.get("/", (req, res) => {
  res.json({
    aplicacion: "Mass Control",
    estado: "Servidor funcionando"
  });
});

// ========================================
// COMPROBACION DE LAS SIETE TABLAS
// ========================================

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

// ========================================
// SEGURIDAD
// ========================================

function obtenerSecreto() {
  const secreto = process.env.JWT_SECRET;

  return secreto && Buffer.byteLength(secreto) >= 32
    ? secreto
    : null;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Demasiados intentos de acceso"
  }
});

// ========================================
// INICIO DE SESION
// ========================================

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  const { usuario, contrasena } = req.body || {};

  if (
    typeof usuario !== "string" ||
    typeof contrasena !== "string" ||
    !usuario.trim() ||
    !contrasena ||
    usuario.length > 100 ||
    contrasena.length > 256
  ) {
    return res.status(400).json({
      error: "Datos de acceso invalidos"
    });
  }

  const secreto = obtenerSecreto();

  if (!secreto) {
    return res.status(503).json({
      error: "Autenticacion no configurada"
    });
  }

  try {
    const resultado = await pool.query(
      `SELECT
         c.id,
         c.usuario,
         c.clave_hash,
         c.rol,
         c.tienda_id,
         c.activa,
         t.activa AS tienda_activa
       FROM mass_control.cuentas c
       LEFT JOIN mass_control.tiendas t
         ON t.id = c.tienda_id
       WHERE c.usuario = $1
       LIMIT 1`,
      [usuario.trim()]
    );

    const cuenta = resultado.rows[0];

    const permitida = cuenta &&
      cuenta.activa &&
      (
        cuenta.rol === "ADMIN" ||
        (
          cuenta.rol === "TIENDA" &&
          cuenta.tienda_activa
        )
      );

    const claveCorrecta = permitida
      ? await bcrypt.compare(
          contrasena,
          cuenta.clave_hash
        )
      : false;

    if (!claveCorrecta) {
      return res.status(401).json({
        error: "Credenciales incorrectas"
      });
    }

    const token = jwt.sign({}, secreto, {
      algorithm: "HS256",
      subject: String(cuenta.id),
      issuer: "mass-control",
      audience: "mass-control-app",
      expiresIn: "8h"
    });

    res.json({
      token,
      rol: cuenta.rol,
      tienda_id: cuenta.tienda_id
    });

  } catch (error) {
    console.error(
      "Error login:",
      error.code || error.name
    );

    res.status(500).json({
      error: "No se pudo iniciar sesion"
    });
  }
});

// ========================================
// VERIFICAR SESION Y PERMISOS
// ========================================

async function autenticar(req, res, next) {
  const secreto = obtenerSecreto();

  if (!secreto) {
    return res.status(503).json({
      error: "Autenticacion no configurada"
    });
  }

  const encabezado = req.headers.authorization || "";

  const token = encabezado.startsWith("Bearer ")
    ? encabezado.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  try {
    const datos = jwt.verify(token, secreto, {
      algorithms: ["HS256"],
      issuer: "mass-control",
      audience: "mass-control-app"
    });

    const resultado = await pool.query(
      `SELECT
         c.id,
         c.usuario,
         c.rol,
         c.tienda_id
       FROM mass_control.cuentas c
       LEFT JOIN mass_control.tiendas t
         ON t.id = c.tienda_id
       WHERE c.id = $1
         AND c.activa = TRUE
         AND (
           c.rol = 'ADMIN'
           OR (
             c.rol = 'TIENDA'
             AND t.activa = TRUE
           )
         )`,
      [datos.sub]
    );

    if (!resultado.rows.length) {
      return res.status(401).json({
        error: "Cuenta no autorizada"
      });
    }

    req.cuenta = resultado.rows[0];
    next();

  } catch (error) {
    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError" ||
      error.name === "NotBeforeError"
    ) {
      return res.status(401).json({
        error: "Sesion no valida"
      });
    }

    console.error(
      "Error sesion:",
      error.code || error.name
    );

    res.status(500).json({
      error: "No se pudo verificar la sesion"
    });
  }
}

// ========================================
// CONSULTAR CUENTA ACTUAL
// ========================================

app.get("/api/auth/me", autenticar, (req, res) => {
  res.json({
    usuario: req.cuenta.usuario,
    rol: req.cuenta.rol,
    tienda_id: req.cuenta.tienda_id
  });
});

// ========================================
// MODULOS DE MASS CONTROL
// ========================================

// 1. PRODUCTOS Y FAMILIAS
app.use(
  "/api/productos",
  require("./productos")(pool, autenticar)
);

// 2. LOTES Y CADUCIDADES
app.use(
  "/api/lotes",
  require("./lotes")(pool, autenticar)
);

// 3. ALERTAS DE CADUCIDAD
app.use(
  "/api/alertas",
  require("./alertas")(pool, autenticar)
);

// 4. RETIRADAS DE PRODUCTOS
app.use(
  "/api/retiradas",
  require("./retiradas")(pool, autenticar)
);

// 5. HISTORIAL DE MOVIMIENTOS
app.use(
  "/api/historial",
  require("./historial")(pool, autenticar)
);

// ========================================
// INICIO DEL SERVIDOR
// ========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Mass Control activo en puerto ${PORT}`
  );
});
