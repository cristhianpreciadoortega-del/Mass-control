
const express = require("express");

module.exports = function crearRutasHistorial(pool, autenticar) {
  const router = express.Router();

  // ACCESO OBLIGATORIO
  router.use(autenticar);

  function idValido(valor) {
    return /^\d+$/.test(String(valor)) &&
      Number.isSafeInteger(Number(valor)) &&
      Number(valor) > 0;
  }

  // =========================================
  // CONSULTAR HISTORIAL DE MOVIMIENTOS
  // =========================================

  router.get("/", async (req, res) => {
    const admin = req.cuenta.rol === "ADMIN";

    if (!admin && req.cuenta.rol !== "TIENDA") {
      return res.status(403).json({
        error: "Acceso prohibido"
      });
    }

    const tiendaId = admin
      ? req.query.tienda_id ?? null
      : req.cuenta.tienda_id;

    const loteId = req.query.lote_id ?? null;

    const pagina = req.query.pagina == null
      ? 1
      : Number(req.query.pagina);

    const limite = req.query.limite == null
      ? 50
      : Number(req.query.limite);

    // PROTEGER DATOS DE OTRAS TIENDAS
    if (
      !admin &&
      req.query.tienda_id != null &&
      String(req.query.tienda_id) !== String(tiendaId)
    ) {
      return res.status(403).json({
        error: "Acceso a otra tienda prohibido"
      });
    }

    // VALIDAR FILTROS
    if (
      (tiendaId != null && !idValido(tiendaId)) ||
      (loteId != null && !idValido(loteId)) ||
      !idValido(pagina) ||
      !idValido(limite) ||
      limite > 100
    ) {
      return res.status(400).json({
        error: "Filtros no validos"
      });
    }

    const desplazamiento = (pagina - 1) * limite;

    if (!Number.isSafeInteger(desplazamiento)) {
      return res.status(400).json({
        error: "Pagina no valida"
      });
    }

    try {
      const resultado = await pool.query(
        `SELECT
           m.id,
           m.lote_id,
           p.tienda_id,
           p.codigo_interno,
           p.descripcion,
           c.usuario AS cuenta,
           m.accion,
           m.datos_anteriores,
           m.datos_nuevos,
           m.observaciones,
           TO_CHAR(
             m.registrado_en
               AT TIME ZONE 'Europe/Madrid',
             'YYYY-MM-DD HH24:MI:SS'
           ) AS registrado_en

         FROM mass_control.movimientos m

         JOIN mass_control.lotes l
           ON l.id = m.lote_id

         JOIN mass_control.productos p
           ON p.id = l.producto_id

         LEFT JOIN mass_control.cuentas c
           ON c.id = m.cuenta_id

         WHERE
           (
             $1::bigint IS NULL
             OR p.tienda_id = $1::bigint
           )
           AND
           (
             $2::bigint IS NULL
             OR m.lote_id = $2::bigint
           )

         ORDER BY
           m.registrado_en DESC,
           m.id DESC

         LIMIT $3 OFFSET $4`,
        [
          tiendaId,
          loteId,
          limite,
          desplazamiento
        ]
      );

      res.json({
        pagina: pagina,
        limite: limite,
        movimientos: resultado.rows
      });

    } catch (error) {
      console.error(
        "Consulta historial:",
        error.code
      );

      res.status(500).json({
        error: "No se pudo consultar el historial"
      });
    }
  });

  return router;
};
