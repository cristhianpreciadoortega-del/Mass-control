
const express = require("express");

module.exports = function crearRutasAlertas(pool, autenticar) {
  const router = express.Router();

  // Todas las operaciones requieren autenticacion
  router.use(autenticar);

  function idValido(valor) {
    return /^\d+$/.test(String(valor)) &&
      Number.isSafeInteger(Number(valor)) &&
      Number(valor) > 0;
  }

  function obtenerTienda(req, res) {
    const admin = req.cuenta.rol === "ADMIN";

    const tienda = admin
      ? req.query.tienda_id ?? null
      : req.cuenta.tienda_id;

    if (
      !admin &&
      req.query.tienda_id != null &&
      String(req.query.tienda_id) !== String(tienda)
    ) {
      res.status(403).json({
        error: "Acceso a otra tienda prohibido"
      });
      return undefined;
    }

    if (tienda != null && !idValido(tienda)) {
      res.status(400).json({
        error: "Tienda no valida"
      });
      return undefined;
    }

    return tienda;
  }

  // ========================================
  // 1. CONSULTAR PROXIMAS CADUCIDADES
  // ========================================

  router.get("/proximas", async (req, res) => {
    const tienda = obtenerTienda(req, res);
    if (tienda === undefined) return;

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
        [tienda]
      );

      res.json({
        total: resultado.rows.length,
        alertas: resultado.rows
      });

    } catch (error) {
      console.error("Consulta de alertas:", error.code);

      res.status(500).json({
        error: "No se pudieron consultar las alertas"
      });
    }
  });

  // ========================================
  // 2. GUARDAR ALERTAS SIN DUPLICADOS
  // ========================================

  router.post("/sincronizar", async (req, res) => {
    const tienda = obtenerTienda(req, res);
    if (tienda === undefined) return;

    try {
      const resultado = await pool.query(
        `WITH candidatas AS (
           SELECT
             l.id AS lote_id,

             CASE
               WHEN l.fecha_limite <
                 (NOW() AT TIME ZONE 'Europe/Madrid')::date
                 THEN 'VENCIDO'

               WHEN f.id IS NULL
                 THEN NULL

               WHEN (
                 l.fecha_limite -
                 (NOW() AT TIME ZONE 'Europe/Madrid')::date
               ) <= f.alerta_urgente_dias
                 THEN 'URGENTE'

               WHEN (
                 l.fecha_limite -
                 (NOW() AT TIME ZONE 'Europe/Madrid')::date
               ) <= f.primera_alerta_dias
                 THEN 'PRIMERA'

               ELSE NULL
             END AS tipo

           FROM mass_control.lotes l

           JOIN mass_control.productos p
             ON p.id = l.producto_id

           LEFT JOIN mass_control.familias f
             ON f.id = p.familia_id

           WHERE p.activo = TRUE
             AND p.controla_fecha = TRUE
             AND l.estado = 'ACTIVO'
             AND l.fecha_confirmada = TRUE
             AND l.fecha_limite IS NOT NULL
             AND l.cantidad > 0
             AND (
               $1::bigint IS NULL
               OR p.tienda_id = $1::bigint
             )
         )

         INSERT INTO mass_control.alertas
           (lote_id, tipo)

         SELECT lote_id, tipo
         FROM candidatas
         WHERE tipo IS NOT NULL

         ON CONFLICT (lote_id, tipo)
         DO NOTHING

         RETURNING
           id,
           lote_id,
           tipo,
           estado`,
        [tienda]
      );

      res.json({
        mensaje: "Sincronizacion completada",
        nuevas: resultado.rows.length,
        alertas_creadas: resultado.rows
      });

    } catch (error) {
      console.error("Sincronizar alertas:", error.code);

      res.status(500).json({
        error: "No se pudieron sincronizar las alertas"
      });
    }
  });

  // ========================================
  // 3. CONSULTAR ALERTAS GUARDADAS
  // ========================================

  router.get("/registradas", async (req, res) => {
    const tienda = obtenerTienda(req, res);
    if (tienda === undefined) return;

    const estado = req.query.estado ?? null;

    if (
      estado != null &&
      !["PENDIENTE", "REVISADA", "CERRADA"].includes(estado)
    ) {
      return res.status(400).json({
        error: "Estado no valido"
      });
    }

    try {
      const resultado = await pool.query(
        `SELECT
           a.id AS alerta_id,
           a.lote_id,
           p.tienda_id,
           p.codigo_interno,
           p.descripcion,
           l.cantidad,

           TO_CHAR(
             l.fecha_limite,
             'YYYY-MM-DD'
           ) AS fecha_caducidad,

           (
             l.fecha_limite -
             (NOW() AT TIME ZONE 'Europe/Madrid')::date
           ) AS dias_restantes,

           a.tipo,
           a.estado,

           TO_CHAR(
             a.creada_en AT TIME ZONE 'Europe/Madrid',
             'YYYY-MM-DD HH24:MI:SS'
           ) AS creada_en,

           TO_CHAR(
             a.revisada_en AT TIME ZONE 'Europe/Madrid',
             'YYYY-MM-DD HH24:MI:SS'
           ) AS revisada_en

         FROM mass_control.alertas a

         JOIN mass_control.lotes l
           ON l.id = a.lote_id

         JOIN mass_control.productos p
           ON p.id = l.producto_id

         WHERE
           (
             $1::bigint IS NULL
             OR p.tienda_id = $1::bigint
           )
           AND
           (
             $2::text IS NULL
             OR a.estado = $2::text
           )

         ORDER BY
           a.creada_en DESC,
           a.id DESC

         LIMIT 100`,
        [tienda, estado]
      );

      res.json({
        total: resultado.rows.length,
        alertas: resultado.rows
      });

    } catch (error) {
      console.error("Alertas registradas:", error.code);

      res.status(500).json({
        error: "No se pudieron consultar las alertas registradas"
      });
    }
  });

  return router;
};
