
const express = require("express");

module.exports = function crearRutasRetiradas(pool, autenticar) {
  const router = express.Router();

  router.use(autenticar);

  function idValido(valor) {
    return /^\d+$/.test(String(valor)) &&
      Number.isSafeInteger(Number(valor)) &&
      Number(valor) > 0;
  }

  // REGISTRAR RETIRADA DE UNIDADES
  router.post("/", async (req, res) => {
    const datos = req.body || {};

    const loteId = datos.lote_id;
    const cantidad = datos.cantidad;
    const motivo = datos.motivo;
    const observaciones = datos.observaciones ?? "";

    if (
      !idValido(loteId) ||
      !Number.isSafeInteger(cantidad) ||
      cantidad <= 0 ||
      !["CADUCIDAD", "DETERIORO", "OTRO"].includes(motivo) ||
      typeof observaciones !== "string" ||
      observaciones.length > 500
    ) {
      return res.status(400).json({
        error: "Datos de retirada no validos"
      });
    }

    let client;
    let transaccion = false;

    try {
      client = await pool.connect();
      await client.query("BEGIN");
      transaccion = true;

      const consulta = await client.query(
        `SELECT
           l.id,
           l.producto_id,
           l.cantidad,
           l.estado,
           p.tienda_id
         FROM mass_control.lotes l
         JOIN mass_control.productos p
           ON p.id = l.producto_id
         WHERE l.id = $1
         FOR UPDATE OF l`,
        [loteId]
      );

      const lote = consulta.rows[0];

      if (
        !lote ||
        (
          req.cuenta.rol !== "ADMIN" &&
          String(lote.tienda_id) !==
          String(req.cuenta.tienda_id)
        )
      ) {
        await client.query("ROLLBACK");
        transaccion = false;

        return res.status(404).json({
          error: "Lote no encontrado"
        });
      }

      if (lote.estado !== "ACTIVO") {
        await client.query("ROLLBACK");
        transaccion = false;

        return res.status(409).json({
          error: "El lote no esta activo"
        });
      }

      if (cantidad > lote.cantidad) {
        await client.query("ROLLBACK");
        transaccion = false;

        return res.status(409).json({
          error: "La cantidad supera las unidades disponibles"
        });
      }

      const restante = lote.cantidad - cantidad;

      const nuevoEstado =
        restante === 0 ? "RETIRADO" : "ACTIVO";

      const actualizado = await client.query(
        `UPDATE mass_control.lotes
         SET cantidad = $2,
             estado = $3
         WHERE id = $1
         RETURNING
           id,
           producto_id,
           cantidad,
           estado`,
        [loteId, restante, nuevoEstado]
      );

      // GUARDAR HISTORIAL
      await client.query(
        `INSERT INTO mass_control.movimientos
         (
           lote_id,
           cuenta_id,
           accion,
           datos_anteriores,
           datos_nuevos,
           observaciones
         )
         VALUES (
           $1, $2, $3, $4::jsonb, $5::jsonb, $6
         )`,
        [
          loteId,
          req.cuenta.id,
          "RETIRADA_UNIDADES",
          JSON.stringify({
            cantidad: lote.cantidad,
            estado: lote.estado
          }),
          JSON.stringify({
            cantidad: restante,
            estado: nuevoEstado,
            unidades_retiradas: cantidad,
            motivo: motivo
          }),
          observaciones.trim()
        ]
      );

      await client.query("COMMIT");
      transaccion = false;

      res.json({
        mensaje: "Retirada registrada correctamente",
        unidades_retiradas: cantidad,
        motivo: motivo,
        lote: actualizado.rows[0]
      });

    } catch (error) {
      if (client && transaccion) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
      }

      console.error("Registro retirada:", error.code);

      res.status(500).json({
        error: "No se pudo registrar la retirada"
      });

    } finally {
      if (client) client.release();
    }
  });

  return router;
};
