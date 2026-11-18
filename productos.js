
const express = require("express");

module.exports = function crearRutasProductos(pool, autenticar) {
  const router = express.Router();

  // Todas las operaciones requieren iniciar sesion
  router.use(autenticar);

  function idValido(valor) {
    return /^\d+$/.test(String(valor)) &&
      Number.isSafeInteger(Number(valor)) &&
      Number(valor) > 0;
  }

  // CONSULTAR PRODUCTOS
  router.get("/", async (req, res) => {
    const admin = req.cuenta.rol === "ADMIN";
    const tienda = admin
      ? req.query.tienda_id
      : req.cuenta.tienda_id;

    if (!admin && req.query.tienda_id != null &&
        String(req.query.tienda_id) !== String(tienda)) {
      return res.status(403).json({
        error: "Acceso a otra tienda prohibido"
      });
    }

    const filtro = tienda != null && tienda !== "";

    if (filtro && !idValido(tienda)) {
      return res.status(400).json({
        error: "Tienda no valida"
      });
    }

    try {
      const resultado = await pool.query(
        `SELECT p.id, p.tienda_id,
                p.codigo_interno, p.codigo_barras,
                p.descripcion, p.familia_id,
                p.controla_fecha, p.activo,
                p.creado_en,
                f.nombre AS familia
         FROM mass_control.productos p
         LEFT JOIN mass_control.familias f
           ON f.id = p.familia_id
         ${filtro ? "WHERE p.tienda_id = $1" : ""}
         ORDER BY p.id DESC
         LIMIT 100`,
        filtro ? [tienda] : []
      );

      res.json({ productos: resultado.rows });
    } catch (error) {
      console.error("Consulta productos:", error.code);
      res.status(500).json({
        error: "No se pudieron consultar productos"
      });
    }
  });

  // REGISTRAR PRODUCTO
  router.post("/", async (req, res) => {
    const datos = req.body || {};
    const admin = req.cuenta.rol === "ADMIN";

    const tienda = admin
      ? datos.tienda_id
      : req.cuenta.tienda_id;

    if (!admin && datos.tienda_id != null &&
        String(datos.tienda_id) !== String(tienda)) {
      return res.status(403).json({
        error: "No puedes registrar en otra tienda"
      });
    }

    const codigo = datos.codigo_interno;
    const descripcion = datos.descripcion;
    const barras = datos.codigo_barras;
    const familia = datos.familia_id ?? null;

    if (!idValido(tienda) ||
        typeof codigo !== "string" ||
        !codigo.trim() || codigo.length > 100 ||
        typeof descripcion !== "string" ||
        !descripcion.trim() ||
        descripcion.length > 500 ||
        (barras != null &&
          (typeof barras !== "string" || barras.length > 100)) ||
        (familia != null && !idValido(familia)) ||
        (datos.controla_fecha != null &&
          typeof datos.controla_fecha !== "boolean")) {
      return res.status(400).json({
        error: "Datos del producto no validos"
      });
    }

    try {
      const resultado = await pool.query(
        `INSERT INTO mass_control.productos
         (tienda_id, familia_id, codigo_interno,
          codigo_barras, descripcion, controla_fecha)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, tienda_id, codigo_interno,
                   codigo_barras, descripcion,
                   familia_id, controla_fecha, activo`,
        [
          tienda,
          familia,
          codigo.trim(),
          barras == null ? null : barras.trim(),
          descripcion.trim(),
          datos.controla_fecha ?? true
        ]
      );

      res.status(201).json({
        producto: resultado.rows[0]
      });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          error: "Codigo interno duplicado en la tienda"
        });
      }

      if (error.code === "23503") {
        return res.status(400).json({
          error: "Tienda o familia inexistente"
        });
      }

      console.error("Registro producto:", error.code);
      res.status(500).json({
        error: "No se pudo registrar el producto"
      });
    }
  });

  return router;
};
