
const express = require("express");

module.exports = function crearRutasLotes(pool, autenticar) {
  const router = express.Router();

  // =========================================
  // AUTENTICACION OBLIGATORIA
  // =========================================

  router.use(autenticar);

  function idValido(valor) {
    return /^\d+$/.test(String(valor)) &&
      Number.isSafeInteger(Number(valor)) &&
      Number(valor) > 0;
  }

  function fechaValida(valor) {
    if (
      typeof valor !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(valor)
    ) {
      return false;
    }

    const fecha = new Date(valor + "T00:00:00Z");

    return !Number.isNaN(fecha.getTime()) &&
      fecha.toISOString().slice(0, 10) === valor;
  }

  // =========================================
  // 1. CONSULTAR LOTES
  // =========================================

  router.get("/", async (req, res) => {
    const admin = req.cuenta.rol === "ADMIN";

    const tiendaId = admin
      ? req.query.tienda_id ?? null
      : req.cuenta.tienda_id;

    const productoId = req.query.producto_id ?? null;

    // IMPEDIR ACCESO A OTRAS TIENDAS
    if (
      !admin &&
      req.query.tienda_id != null &&
      String(req.query.tienda_id) !== String(tiendaId)
    ) {
      return res.status(403).json({
        error: "Acceso a otra tienda prohibido"
      });
    }

    // VALIDAR IDENTIFICADORES
    if (
      (tiendaId != null && !idValido(tiendaId)) ||
      (productoId != null && !idValido(productoId))
    ) {
      return res.status(400).json({
        error: "Identificador no valido"
      });
    }

    try {
      const resultado = await pool.query(
        `SELECT
           l.id,
           l.producto_id,
           p.tienda_id,
           p.codigo_interno,
           p.descripcion,
           f.nombre AS familia,
           l.numero_lote,
           l.fecha_limite,
           l.tipo_fecha,
           l.fecha_confirmada,
           l.multilote_pendiente,
           l.cantidad,
           l.estado,
           l.registrado_en

         FROM mass_control.lotes l

         JOIN mass_control.productos p
           ON p.id = l.producto_id
         LEFT JOIN mass_control.familias f ON f.id = p.familia_id

         WHERE
           (
             $1::bigint IS NULL
             OR p.tienda_id = $1::bigint
           )

           AND
           (
             $2::bigint IS NULL
             OR l.producto_id = $2::bigint
           )

         ORDER BY
           l.fecha_limite ASC NULLS LAST,
           l.id DESC

         LIMIT 250`,
        [tiendaId, productoId]
      );

      res.json({
        lotes: resultado.rows
      });

    } catch (error) {
      console.error(
        "Consulta lotes:",
        error.code || error.name
      );

      res.status(500).json({
        error: "No se pudieron consultar los lotes"
      });
    }
  });

  // =========================================
  // 2. REGISTRAR NUEVO LOTE
  // =========================================

  router.post("/", async (req, res) => {
    const datos = req.body || {};

    const productoId = datos.producto_id;
    const fechaLimite = datos.fecha_limite;
    const cantidad = datos.cantidad;
    const numeroLote = datos.numero_lote;

    // NUEVO: RESPETAR EL TIPO DE FECHA ELEGIDO
    const tipoFecha = datos.tipo_fecha ?? "CADUCIDAD";

    // =========================================
    // VALIDACION DE DATOS
    // =========================================

    if (
      !idValido(productoId) ||

      !fechaValida(fechaLimite) ||

      !Number.isInteger(cantidad) ||

      cantidad <= 0 ||

      cantidad > 1000000 ||

      ![
        "CADUCIDAD",
        "CONSUMO_PREFERENTE"
      ].includes(tipoFecha) ||

      (
        numeroLote != null &&
        (
          typeof numeroLote !== "string" ||
          numeroLote.length > 100
        )
      )
    ) {
      return res.status(400).json({
        error: "Datos del lote no validos"
      });
    }

    const admin = req.cuenta.rol === "ADMIN";

    let client;
    let transaccion = false;

    try {
      client = await pool.connect();

      await client.query("BEGIN");
      transaccion = true;

      // =========================================
      // INSERTAR LOTE EN SU TIENDA
      // =========================================

      const resultado = await client.query(
        `INSERT INTO mass_control.lotes
         (
           producto_id,
           numero_lote,
           fecha_limite,
           tipo_fecha,
           fecha_confirmada,
           cantidad,
           estado
         )

         SELECT
           p.id,
           $2,
           $3::date,
           $4,
           FALSE,
           $5,
           'PENDIENTE_REVISION'

         FROM mass_control.productos p

         WHERE p.id = $1

           AND p.activo = TRUE

           AND (
             $6::boolean
             OR p.tienda_id = $7::bigint
           )

         RETURNING
           id,
           producto_id,
           numero_lote,
           fecha_limite,
           tipo_fecha,
           fecha_confirmada,
           cantidad,
           estado`,
        [
          productoId,
          numeroLote ? numeroLote.trim() : null,
          fechaLimite,
          tipoFecha,
          cantidad,
          admin,
          req.cuenta.tienda_id
        ]
      );

      // PRODUCTO INEXISTENTE O SIN PERMISOS
      if (!resultado.rows.length) {
        await client.query("ROLLBACK");
        transaccion = false;

        return res.status(404).json({
          error: "Producto inexistente o no autorizado"
        });
      }

      const lote = resultado.rows[0];

      // =========================================
      // GUARDAR HISTORIAL DE CREACION
      // =========================================

      await client.query(
        `INSERT INTO mass_control.movimientos
         (
           lote_id,
           cuenta_id,
           accion,
           datos_nuevos
         )

         VALUES
         (
           $1,
           $2,
           $3,
           $4::jsonb
         )`,
        [
          lote.id,
          req.cuenta.id,
          "CREACION_LOTE",
          JSON.stringify(lote)
        ]
      );

      // CONFIRMAR TRANSACCION
      await client.query("COMMIT");
      transaccion = false;

      res.status(201).json({
        lote: lote
      });

    } catch (error) {

      // DESHACER TRANSACCION SI FALLA
      if (client && transaccion) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
      }

      console.error(
        "Registro lote:",
        error.code || error.name
      );

      // POSIBLE RESTRICCION DE TIPO DE FECHA
      // EN EL ESQUEMA EXISTENTE
      if (
        error.code === "23514" ||
        error.code === "22P02" ||
        error.code === "42804"
      ) {
        return res.status(400).json({
          error:
            "La base de datos no admite alguno " +
            "de los valores enviados. " +
            "Comprueba la configuracion de tipo_fecha."
        });
      }

      if (error.code === "23503") {
        return res.status(400).json({
          error: "Referencia de producto no valida"
        });
      }

      res.status(500).json({
        error: "No se pudo registrar el lote"
      });

    } finally {
      if (client) {
        client.release();
      }
    }
  });

  // =========================================
  // 3. CONFIRMAR FECHA DE UN LOTE
  // =========================================

  router.patch("/:id/confirmar", async (req, res) => {

    if (!idValido(req.params.id)) {
      return res.status(400).json({
        error: "ID de lote no valido"
      });
    }

    const { fecha_limite: fecha, tipo_fecha: tipo, cantidad } = req.body || {};
    const revision = fecha !== undefined || tipo !== undefined || cantidad !== undefined;
    const agotado = cantidad === 0;
    if (revision && !agotado && (!fechaValida(fecha) ||
        !["CADUCIDAD", "CONSUMO_PREFERENTE"].includes(tipo) ||
        !Number.isInteger(cantidad) || cantidad < 1 || cantidad > 1000000)) {
      return res.status(400).json({ error: "Indica una fecha válida, su tipo y al menos una unidad." });
    }

    let client;
    let transaccion = false;

    try {
      client = await pool.connect();

      await client.query("BEGIN");
      transaccion = true;

      // =========================================
      // BUSCAR Y BLOQUEAR LOTE
      // =========================================

      const resultado = await client.query(
        `SELECT
           l.id,
           l.estado,
           l.fecha_confirmada,
           l.fecha_limite,
           l.tipo_fecha,
           l.cantidad,
           l.multilote_pendiente,
           p.tienda_id

         FROM mass_control.lotes l

         JOIN mass_control.productos p
           ON p.id = l.producto_id

         WHERE l.id = $1

         FOR UPDATE OF l`,
        [req.params.id]
      );

      const lote = resultado.rows[0];

      // =========================================
      // VERIFICAR PERMISOS DE TIENDA
      // =========================================

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

      // =========================================
      // EVITAR CONFIRMACIONES DUPLICADAS
      // =========================================

      if (
        agotado
          ? !["PENDIENTE_REVISION", "ACTIVO"].includes(lote.estado)
          : lote.estado !== "PENDIENTE_REVISION" || lote.fecha_confirmada ||
            (!revision && (!lote.fecha_limite || !(lote.cantidad > 0)))
      ) {
        await client.query("ROLLBACK");
        transaccion = false;

        return res.status(409).json({
          error:
            "El lote no esta pendiente " +
            "de confirmacion"
        });
      }

      // =========================================
      // ACTIVAR LOTE CONFIRMADO
      // =========================================

      if (lote.multilote_pendiente) {
        await client.query("ROLLBACK");
        transaccion = false;
        return res.status(409).json({ error: "Multilote pendiente. Comprueba y registra cada lote físico por separado." });
      }

      const actualizado = await client.query(
        `UPDATE mass_control.lotes

         SET
           fecha_limite = COALESCE($2::date, fecha_limite),
           tipo_fecha = COALESCE($3::text, tipo_fecha),
           cantidad = COALESCE($4::integer, cantidad),
           fecha_confirmada = CASE WHEN $5 THEN fecha_confirmada ELSE TRUE END,
           estado = CASE WHEN $5 THEN 'AGOTADO' ELSE 'ACTIVO' END

         WHERE id = $1

         RETURNING
           id,
           producto_id,
           fecha_limite,
           tipo_fecha,
           cantidad,
           estado,
           fecha_confirmada`,
        [lote.id, agotado ? null : fecha ?? null, agotado ? null : tipo ?? null, cantidad ?? null, agotado]
      );

      // =========================================
      // HISTORIAL DE CONFIRMACION
      // =========================================

      await client.query(
        `INSERT INTO mass_control.movimientos
         (
           lote_id,
           cuenta_id,
           accion,
           datos_anteriores,
           datos_nuevos
         )

         VALUES
         (
           $1,
           $2,
           $3,
           $4::jsonb,
           $5::jsonb
         )`,
        [
          lote.id,
          req.cuenta.id,
          agotado ? "AGOTAMIENTO" : "CONFIRMACION_FECHA",

          JSON.stringify({
            fecha_limite: lote.fecha_limite,
            tipo_fecha: lote.tipo_fecha,
            cantidad: lote.cantidad,
            estado: lote.estado,
            fecha_confirmada: lote.fecha_confirmada
          }),

          JSON.stringify(actualizado.rows[0])
        ]
      );

      // CONFIRMAR TRANSACCION
      await client.query("COMMIT");
      transaccion = false;

      res.json({
        lote: actualizado.rows[0]
      });

    } catch (error) {

      if (client && transaccion) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
      }

      console.error(
        "Confirmar lote:",
        error.code || error.name
      );

      res.status(500).json({
        error: "No se pudo confirmar el lote"
      });

    } finally {
      if (client) {
        client.release();
      }
    }
  });


  router.patch("/:id/fecha", async (req, res) => {
    const { fecha_limite: fecha, fecha_anterior: anterior } = req.body || {};
    if (!idValido(req.params.id) || !fechaValida(fecha) ||
        (anterior !== null && !fechaValida(anterior))) {
      return res.status(400).json({ error: "Fecha o lote no válido." });
    }

    const admin = req.cuenta.rol === "ADMIN";
    if (!admin && req.cuenta.rol !== "TIENDA") {
      return res.status(403).json({ error: "Acceso prohibido." });
    }

    try {
      const { rows: [resultado] } = await pool.query(
        `WITH seleccionado AS (
          SELECT l.id, l.fecha_limite, l.estado
          FROM mass_control.lotes l
          JOIN mass_control.productos p ON p.id = l.producto_id
          WHERE l.id = $1 AND ($2::boolean OR p.tienda_id = $3::bigint)
          FOR UPDATE OF l
        ), actualizado AS (
          UPDATE mass_control.lotes l
          SET fecha_limite = $4::date
          FROM seleccionado s
          WHERE l.id = s.id AND s.estado IN ('ACTIVO', 'PENDIENTE_REVISION')
            AND s.fecha_limite IS NOT DISTINCT FROM $5::date
            AND s.fecha_limite IS DISTINCT FROM $4::date
          RETURNING l.id, s.fecha_limite AS fecha_anterior, l.fecha_limite
        ), movimiento AS (
          INSERT INTO mass_control.movimientos
            (lote_id, cuenta_id, accion, datos_anteriores, datos_nuevos)
          SELECT id, $6, 'CAMBIO_FECHA',
            jsonb_build_object('fecha_limite', fecha_anterior),
            jsonb_build_object('fecha_limite', fecha_limite)
          FROM actualizado
          RETURNING lote_id
        )
        SELECT s.id, s.estado, s.fecha_limite::text AS fecha_actual,
          m.lote_id IS NOT NULL AS guardado
        FROM seleccionado s LEFT JOIN movimiento m ON m.lote_id = s.id`,
        [req.params.id, admin, req.cuenta.tienda_id, fecha, anterior, req.cuenta.id]
      );

      if (!resultado) return res.status(404).json({ error: "Lote no encontrado." });
      if (!["ACTIVO", "PENDIENTE_REVISION"].includes(resultado.estado)) {
        return res.status(409).json({ error: "El estado del lote impide editarlo." });
      }
      if (!resultado.guardado && resultado.fecha_actual !== fecha) {
        return res.status(409).json({ error: "La fecha cambió. Actualiza la lista y vuelve a intentarlo." });
      }
      res.json({ id: resultado.id, fecha_limite: fecha });
    } catch (error) {
      console.error("Editar fecha de lote:", error.code || error.name);
      res.status(500).json({ error: "No se pudo guardar la fecha." });
    }
  });

  // =========================================
  // FINAL DEL MODULO
  // =========================================

  return router;
};
