
const express = require("express");

module.exports = function crearRutasAlertas(pool, autenticar) {
  const router = express.Router();

  // Todas las consultas requieren iniciar sesion
  router.use(autenticar);

  function idValido(valor) {
    return /^\d+$/.test(String(valor)) &&
      Number.isSafeInteger(Number(valor)) &&
      Number(valor) > 0;
  }

  // =========================================
  // CONSULTAR PROXIMAS CADUCIDADES
  // =========================================

  router.get("/proximas", async (req, res) => {
    const admin = req.cuenta.rol === "ADMIN";

    const tiendaId = admin
      ? req.query.tienda_id ?? null
      : req.cuenta.tienda_id;

    if (
      !admin &&
      req.query.tienda_id != null &&
      String(req.query.tienda_id) !== String(tiendaId)
    ) {
      return res.status(403).json({
        error: "Acceso a otra tienda prohibido"
      });
    }

    if (
      tiendaId != null &&
      !idValido(tiendaId)
    ) {
      return res.status(400).json({
        error: "Tienda no valida"
      });
    }

    try {
      const resultado = await pool.query(
        `WITH base AS (
           SELECT
             l.id AS lote_id,
             l.producto_id,
             p.tienda_id,
             p.codigo_interno,
             p.descripcion,
             l.cantidad,
             l.fecha_limite,
             p.familia_id,
             f.primera_alerta_dias,
             f.alerta_urgente_dias,
             (
               l.fecha_limite -
               (NOW() AT TIME ZONE 'Europe/Madrid')::date
             ) AS dias_restantes

           FROM mass_control.lotes l

           JOIN mass_control.productos p
             ON p.id = l.producto_id

           LEFT JOIN mass_control.familias f
             ON f.id = p.familia_id

           WHERE p.activo = TRUE
             AND l.estado = 'ACTIVO'
             AND l.fecha_confirmada = TRUE
             AND l.fecha_limite IS NOT NULL
             AND l.cantidad > 0
             AND (
               $1::bigint IS NULL
               OR p.tienda_id = $1::bigint
             )
         )

         SELECT
           lote_id,
           producto_id,
           tienda_id,
           codigo_interno,
           descripcion,
           cantidad,
           TO_CHAR(
             fecha_limite, 'YYYY-MM-DD'
           ) AS fecha_caducidad,
           dias_restantes,

           CASE
             WHEN dias_restantes < 0
               THEN 'VENCIDO'

             WHEN dias_restantes = 0
               THEN 'VENCE_HOY'

             WHEN familia_id IS NULL
               THEN 'SIN_POLITICA'

             WHEN dias_restantes <= alerta_urgente_dias
               THEN 'URGENTE'

             WHEN dias_restantes <= primera_alerta_dias
               THEN 'PRIMERA'

             ELSE 'FUERA_DE_PLAZO'
           END AS tipo_alerta

         FROM base

         WHERE dias_restantes <= 0
            OR (
              familia_id IS NULL
              AND dias_restantes <= 30
            )
            OR (
              familia_id IS NOT NULL
              AND dias_restantes <= primera_alerta_dias
            )

         ORDER BY fecha_limite ASC, lote_id ASC
         LIMIT 200`,
        [tiendaId]
      );

      res.json({
        total: resultado.rows.length,
        alertas: resultado.rows
      });

    } catch (error) {
      console.error(
        "Consulta de alertas:",
        error.code
      );

      res.status(500).json({
        error: "No se pudieron consultar las alertas"
      });
    }
  });

  return router;
};
