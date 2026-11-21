
const express = require("express");

module.exports = function crearRutasProductos(pool, autenticar) {
  const router = express.Router();

  // ACCESO OBLIGATORIO
  router.use(autenticar);

  function idValido(valor) {
    return /^\d+$/.test(String(valor)) &&
      Number.isSafeInteger(Number(valor)) &&
      Number(valor) > 0;
  }

  // ========================================
  // 1. CONSULTAR FAMILIAS Y POLITICAS
  // ========================================

  router.get("/familias", async (req, res) => {
    try {
      const resultado = await pool.query(
        `SELECT
           id,
           codigo,
           nombre,
           primera_alerta_dias,
           alerta_urgente_dias
         FROM mass_control.familias
         ORDER BY nombre ASC`
      );

      res.json({
        total: resultado.rows.length,
        familias: resultado.rows
      });
    } catch (error) {
      console.error("Consulta familias:", error.code);

      res.status(500).json({
        error: "No se pudieron consultar las familias"
      });
    }
  });

  // ========================================
  // 2. CONSULTAR PRODUCTOS
  // ========================================

  router.get("/", async (req, res) => {
    const admin = req.cuenta.rol === "ADMIN";

    const tienda = admin
      ? req.query.tienda_id
      : req.cuenta.tienda_id;

    if (
      !admin &&
      req.query.tienda_id != null &&
      String(req.query.tienda_id) !== String(tienda)
    ) {
      return res.status(403).json({
        error: "Acceso a otra tienda prohibido"
      });
    }

    const filtro = tienda != null && tienda !== "";
    if (!admin && !filtro) return res.status(403).json({ error: "Tienda no asignada" });

    const consulta = req.query.q ?? "";
    if (typeof consulta !== "string" || consulta.length > 120) {
      return res.status(400).json({ error: "Búsqueda no válida" });
    }
    const palabras = consulta.toLowerCase().normalize("NFD")
      .replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) || [];
    const params = [];
    const condiciones = [];
    if (filtro) {
      params.push(tienda);
      condiciones.push("p.tienda_id = $1");
    }
    if (req.query.para_lote === "1") {
      condiciones.push("p.activo = TRUE AND p.controla_fecha = TRUE");
    }
    if (palabras.length) {
      params.push(palabras);
      condiciones.push(`NOT EXISTS (
        SELECT 1 FROM unnest($${params.length}::text[]) AS termino(palabra)
        WHERE strpos(translate(lower(concat_ws(' ', p.descripcion, p.codigo_interno, p.codigo_barras)),
          'áéíóúüñ', 'aeiouun'), termino.palabra) = 0
      )`);
    }

    if (filtro && !idValido(tienda)) {
      return res.status(400).json({
        error: "Tienda no valida"
      });
    }

    try {
      const resultado = await pool.query(
        `SELECT
           p.id,
           p.tienda_id,
           p.codigo_interno,
           p.codigo_barras,
           p.descripcion,
           p.familia_id,
           p.controla_fecha,
           p.activo,
           p.creado_en,
           f.nombre AS familia
         FROM mass_control.productos p
         LEFT JOIN mass_control.familias f
           ON f.id = p.familia_id
         ${condiciones.length ? "WHERE " + condiciones.join(" AND ") : ""}
         ORDER BY p.id DESC
         LIMIT 100`,
        params
      );

      res.json({
        productos: resultado.rows
      });
    } catch (error) {
      console.error("Consulta productos:", error.code);

      res.status(500).json({
        error: "No se pudieron consultar productos"
      });
    }
  });

  // ========================================
  // 3. REGISTRAR PRODUCTO
  // ========================================

  router.post("/", async (req, res) => {
    const datos = req.body || {};
    const admin = req.cuenta.rol === "ADMIN";

    const tienda = admin
      ? datos.tienda_id
      : req.cuenta.tienda_id;

    if (
      !admin &&
      datos.tienda_id != null &&
      String(datos.tienda_id) !== String(tienda)
    ) {
      return res.status(403).json({
        error: "No puedes registrar en otra tienda"
      });
    }

    const codigo = datos.codigo_interno;
    const descripcion = datos.descripcion;
    const barras = datos.codigo_barras;
    const familia = datos.familia_id ?? null;

    if (
      !idValido(tienda) ||
      typeof codigo !== "string" ||
      !codigo.trim() ||
      codigo.length > 100 ||
      typeof descripcion !== "string" ||
      !descripcion.trim() ||
      descripcion.length > 500 ||
      (
        barras != null &&
        (
          typeof barras !== "string" ||
          barras.length > 100
        )
      ) ||
      (
        familia != null &&
        !idValido(familia)
      ) ||
      (
        datos.controla_fecha != null &&
        typeof datos.controla_fecha !== "boolean"
      )
    ) {
      return res.status(400).json({
        error: "Datos del producto no validos"
      });
    }

    try {
      const resultado = await pool.query(
        `INSERT INTO mass_control.productos
         (
           tienda_id,
           familia_id,
           codigo_interno,
           codigo_barras,
           descripcion,
           controla_fecha
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING
           id,
           tienda_id,
           codigo_interno,
           codigo_barras,
           descripcion,
           familia_id,
           controla_fecha,
           activo`,
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

  // ASIGNAR FAMILIA A UN PRODUCTO
  router.patch("/:id/familia", async (req, res) => {
    const productoId = req.params.id;
    const familiaId = req.body?.familia_id;

    if (!idValido(productoId) ||
        !idValido(familiaId)) {
      return res.status(400).json({
        error: "Identificadores no validos"
      });
    }

    const admin = req.cuenta.rol === "ADMIN";

    try {
      const resultado = await pool.query(
        `UPDATE mass_control.productos AS p
         SET familia_id = $2
         WHERE p.id = $1
           AND ($3::boolean
                OR p.tienda_id = $4::bigint)
           AND EXISTS (
             SELECT 1
             FROM mass_control.familias f
             WHERE f.id = $2
           )
         RETURNING
           p.id,
           p.tienda_id,
           p.codigo_interno,
           p.descripcion,
           p.familia_id`,
        [
          productoId,
          familiaId,
          admin,
          req.cuenta.tienda_id
        ]
      );

      if (!resultado.rows.length) {
        return res.status(404).json({
          error: "Producto o familia no encontrado"
        });
      }

      res.json({
        producto: resultado.rows[0]
      });

    } catch (error) {
      console.error("Asignar familia:", error.code);

      res.status(500).json({
        error: "No se pudo asignar la familia"
      });
    }
  });

  let tablaFotos;
  function prepararFotos() {
    tablaFotos ||= pool.query(`CREATE TABLE IF NOT EXISTS mass_control.fotos_producto (
      producto_id bigint PRIMARY KEY REFERENCES mass_control.productos(id) ON DELETE CASCADE,
      jpeg bytea NOT NULL CHECK (octet_length(jpeg) BETWEEN 4 AND 350000)
    )`).catch(error => { tablaFotos = null; throw error; });
    return tablaFotos;
  }

  router.get("/:id/foto", async (req, res) => {
    if (!idValido(req.params.id)) return res.sendStatus(400);
    try {
      await prepararFotos();
      const {rows} = await pool.query(`SELECT f.jpeg FROM mass_control.fotos_producto f
        JOIN mass_control.productos p ON p.id = f.producto_id
        WHERE p.id = $1 AND ($2::boolean OR p.tienda_id = $3::bigint)`,
        [req.params.id, req.cuenta.rol === "ADMIN", req.cuenta.tienda_id]);
      if (!rows.length) return res.sendStatus(404);
      res.set({"Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff"});
      res.type("image/jpeg").send(rows[0].jpeg);
    } catch (error) {
      console.error("Consultar foto:", error.code || error.name);
      res.sendStatus(500);
    }
  });

  router.put("/:id/foto", express.raw({type:"image/jpeg", limit:350000}), async (req, res) => {
    const jpeg = req.body;
    if (!idValido(req.params.id) || !Buffer.isBuffer(jpeg) || jpeg.length < 4 ||
        jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg[jpeg.length - 2] !== 255 || jpeg[jpeg.length - 1] !== 217) {
      return res.status(400).json({error:"Selecciona una foto válida."});
    }
    try {
      await prepararFotos();
      const resultado = await pool.query(`INSERT INTO mass_control.fotos_producto (producto_id, jpeg)
        SELECT p.id, $4 FROM mass_control.productos p
        WHERE p.id = $1 AND ($2::boolean OR p.tienda_id = $3::bigint)
        ON CONFLICT (producto_id) DO UPDATE SET jpeg = excluded.jpeg RETURNING producto_id`,
        [req.params.id, req.cuenta.rol === "ADMIN", req.cuenta.tienda_id, jpeg]);
      if (!resultado.rowCount) return res.sendStatus(404);
      res.sendStatus(204);
    } catch (error) {
      console.error("Guardar foto:", error.code || error.name);
      res.status(500).json({error:"No se pudo guardar la foto."});
    }
  });

  return router;
};
