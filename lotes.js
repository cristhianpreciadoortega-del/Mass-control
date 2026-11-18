
const express = require("express");

module.exports = function crearRutasLotes(pool, autenticar) {
  const router = express.Router();

  router.use(autenticar);

  function idValido(valor) {
    return /^\d+$/.test(String(valor)) &&
      Number.isSafeInteger(Number(valor)) &&
      Number(valor) > 0;
  }

  function fechaValida(valor) {
    if (typeof valor !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
      return false;
    }

    const fecha = new Date(valor + "T00:00:00Z");

    return !Number.isNaN(fecha.getTime()) &&
      fecha.toISOString().slice(0, 10) === valor;
  }

  // CONSULTAR LOTES
  router.get("/", async (req, res) => {
    const admin = req.cuenta.rol === "ADMIN";

    const tiendaId = admin
      ? req.query.tienda_id ?? null
      : req.cuenta.tienda_id;

    const productoId = req.query.producto_id ?? null;

    if (!admin &&
        req.query.tienda_id != null &&
        String(req.query.tienda_id) !== String(tiendaId)) {
      return res.status(403).json({
        error: "Acceso a otra tienda prohibido"
      });
    }

    if ((tiendaId != null && !idValido(tiendaId)) ||
        (productoId != null && !idValido(productoId))) {
      return res.status(400).json({
        error: "Identificador no valido"
      });
    }

    try {
      const resultado = await pool.query(
        `SELECT l.id, l.producto_id,
                p.tienda_id, p.codigo_interno,
                p.descripcion, l.numero_lote,
                l.fecha_limite, l.tipo_fecha,
                l.fecha_confirmada, l.cantidad,
                l.estado, l.registrado_en
         FROM mass_control.lotes l
         JOIN mass_control.productos p
           ON p.id = l.producto_id
         WHERE ($1::bigint IS NULL
                OR p.tienda_id = $1::bigint)
           AND ($2::bigint IS NULL
                OR l.producto_id = $2::bigint)
         ORDER BY l.fecha_limite ASC NULLS LAST,
                  l.id DESC
         LIMIT 100`,
        [tiendaId, productoId]
      );

      res.json({ lotes: resultado.rows });
    } catch (error) {
      console.error("Consulta lotes:", error.code);
      res.status(500).json({
        error: "No se pudieron consultar los lotes"
      });
    }
  });

  // REGISTRAR LOTE Y GUARDAR HISTORIAL
  router.post("/", async (req, res) => {
    const datos = req.body || {};

    const productoId = datos.producto_id;
    const fechaLimite = datos.fecha_limite;
    const cantidad = datos.cantidad;
    const numeroLote = datos.numero_lote;

    if (!idValido(productoId) ||
        !fechaValida(fechaLimite) ||
        !Number.isInteger(cantidad) ||
        cantidad <= 0 ||
        cantidad > 1000000 ||
        (numeroLote != null &&
         (typeof numeroLote !== "string" ||
          numeroLote.length > 100))) {
      return res.status(400).json({
        error: "Datos del lote no validos"
      });
    }

    const admin = req.cuenta.rol === "ADMIN";
    let client;

    try {
      client = await pool.connect();
      await client.query("BEGIN");

      const resultado = await client.query(
        `INSERT INTO mass_control.lotes
         (producto_id, numero_lote, fecha_limite,
          tipo_fecha, fecha_confirmada, cantidad,
          estado)
         SELECT p.id, $2, $3::date,
                'CADUCIDAD', FALSE, $4,
                'PENDIENTE_REVISION'
         FROM mass_control.productos p
         WHERE p.id = $1
           AND p.activo = TRUE
           AND ($5::boolean
                OR p.tienda_id = $6::bigint)
         RETURNING id, producto_id, numero_lote,
                   fecha_limite, tipo_fecha,
                   fecha_confirmada, cantidad, estado`,
        [
          productoId,
          numeroLote ? numeroLote.trim() : null,
          fechaLimite,
          cantidad,
          admin,
          req.cuenta.tienda_id
        ]
      );

      if (!resultado.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "Producto inexistente o no autorizado"
        });
      }

      const lote = resultado.rows[0];

      await client.query(
        `INSERT INTO mass_control.movimientos
         (lote_id, cuenta_id, accion, datos_nuevos)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          lote.id,
          req.cuenta.id,
          "CREACION_LOTE",
          JSON.stringify(lote)
        ]
      );

      await client.query("COMMIT");

      res.status(201).json({ lote });
    } catch (error) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
      }

      console.error("Registro lote:", error.code);
      res.status(500).json({
        error: "No se pudo registrar el lote"
      });
    } finally {
      if (client) client.release();
    }
  });

  return router;
  
  // CONFIRMAR FECHA DE UN LOTE
  router.patch("/:id/confirmar", async (req, res) => {
    if (!idValido(req.params.id)) {
      return res.status(400).json({
        error: "ID de lote no valido"
      });
    }

    let client;

    try {
      client = await pool.connect();
      await client.query("BEGIN");

      const resultado = await client.query(
        `SELECT l.id, l.estado, l.fecha_confirmada,
                l.fecha_limite, p.tienda_id
         FROM mass_control.lotes l
         JOIN mass_control.productos p
           ON p.id = l.producto_id
         WHERE l.id = $1
         FOR UPDATE OF l`,
        [req.params.id]
      );

      const lote = resultado.rows[0];

      if (!lote ||
          (req.cuenta.rol !== "ADMIN" &&
           String(lote.tienda_id) !==
           String(req.cuenta.tienda_id))) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "Lote no encontrado"
        });
      }

      if (lote.estado !== "PENDIENTE_REVISION" ||
          lote.fecha_confirmada ||
          !lote.fecha_limite) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "El lote no esta pendiente de confirmacion"
        });
      }

      const actualizado = await client.query(
        `UPDATE mass_control.lotes
         SET fecha_confirmada = TRUE,
             estado = 'ACTIVO'
         WHERE id = $1
         RETURNING id, estado, fecha_confirmada`,
        [lote.id]
      );

      await client.query(
        `INSERT INTO mass_control.movimientos
         (lote_id, cuenta_id, accion,
          datos_anteriores, datos_nuevos)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
        [
          lote.id,
          req.cuenta.id,
          "CONFIRMACION_FECHA",
          JSON.stringify({
            estado: lote.estado,
            fecha_confirmada: lote.fecha_confirmada
          }),
          JSON.stringify({
            estado: "ACTIVO",
            fecha_confirmada: true
          })
        ]
      );

      await client.query("COMMIT");

      res.json({
        lote: actualizado.rows[0]
      });
    } catch (error) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
      }

      console.error("Confirmar lote:", error.code);
      res.status(500).json({
        error: "No se pudo confirmar el lote"
      });
    } finally {
      if (client) client.release();
    }
  });

};
