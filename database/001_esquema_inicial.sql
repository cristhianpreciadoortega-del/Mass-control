
BEGIN;

CREATE SCHEMA IF NOT EXISTS mass_control;

-- 1. TIENDAS
CREATE TABLE IF NOT EXISTS mass_control.tiendas (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo TEXT NOT NULL UNIQUE,
    nombre TEXT NOT NULL,
    activa BOOLEAN NOT NULL DEFAULT TRUE,
    creada_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. CUENTAS DE ACCESO
CREATE TABLE IF NOT EXISTS mass_control.cuentas (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tienda_id BIGINT REFERENCES mass_control.tiendas(id),
    usuario TEXT NOT NULL UNIQUE,
    clave_hash TEXT NOT NULL,
    rol TEXT NOT NULL CHECK (rol IN ('ADMIN', 'TIENDA')),
    activa BOOLEAN NOT NULL DEFAULT TRUE,
    creada_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cuenta_rol_tienda CHECK (
        (rol = 'ADMIN' AND tienda_id IS NULL)
        OR
        (rol = 'TIENDA' AND tienda_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS una_cuenta_por_tienda
ON mass_control.cuentas(tienda_id)
WHERE rol = 'TIENDA';

-- 3. FAMILIAS Y POLITICAS DE ALERTA
CREATE TABLE IF NOT EXISTS mass_control.familias (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo TEXT NOT NULL UNIQUE,
    nombre TEXT NOT NULL,
    primera_alerta_dias INTEGER NOT NULL,
    alerta_urgente_dias INTEGER NOT NULL,
    CHECK (
        primera_alerta_dias >= alerta_urgente_dias
        AND alerta_urgente_dias >= 0
    )
);

INSERT INTO mass_control.familias
(codigo, nombre, primera_alerta_dias, alerta_urgente_dias)
VALUES
('CARNE_PESCADO', 'Carne y pescado fresco', 3, 1),
('REFRIGERADOS', 'Refrigerados y lacteos frescos', 7, 3),
('HUEVOS', 'Huevos', 14, 5),
('PAN_BOLLERIA', 'Pan de molde y bolleria', 7, 2),
('EMBUTIDOS', 'Embutidos envasados', 14, 5),
('SNACKS', 'Snacks y aperitivos', 30, 7),
('LECHE_UHT', 'Leche UHT', 30, 7),
('BEBIDAS', 'Bebidas', 30, 7),
('ALIMENTACION_SECA', 'Conservas y alimentacion seca', 60, 15)
ON CONFLICT (codigo) DO NOTHING;

-- 4. PRODUCTOS
CREATE TABLE IF NOT EXISTS mass_control.productos (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tienda_id BIGINT NOT NULL REFERENCES mass_control.tiendas(id),
    familia_id BIGINT REFERENCES mass_control.familias(id),
    codigo_interno TEXT NOT NULL,
    codigo_barras TEXT,
    descripcion TEXT NOT NULL,
    controla_fecha BOOLEAN NOT NULL DEFAULT TRUE,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tienda_id, codigo_interno)
);

-- 5. LOTES Y FECHAS
CREATE TABLE IF NOT EXISTS mass_control.lotes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    producto_id BIGINT NOT NULL REFERENCES mass_control.productos(id),
    numero_lote TEXT,
    fecha_limite DATE,
    tipo_fecha TEXT NOT NULL DEFAULT 'POR_CONFIRMAR'
        CHECK (tipo_fecha IN (
            'CADUCIDAD',
            'CONSUMO_PREFERENTE',
            'POR_CONFIRMAR'
        )),
    fecha_confirmada BOOLEAN NOT NULL DEFAULT FALSE,
    multilote_pendiente BOOLEAN NOT NULL DEFAULT FALSE,
    cantidad INTEGER CHECK (cantidad >= 0),
    documento_origen TEXT,
    estado TEXT NOT NULL DEFAULT 'PENDIENTE_REVISION'
        CHECK (estado IN (
            'PENDIENTE_REVISION',
            'ACTIVO',
            'RETIRADO',
            'AGOTADO',
            'BLOQUEADO'
        )),
    registrado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. ALERTAS
CREATE TABLE IF NOT EXISTS mass_control.alertas (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lote_id BIGINT NOT NULL REFERENCES mass_control.lotes(id),
    tipo TEXT NOT NULL CHECK (
        tipo IN ('PRIMERA', 'URGENTE', 'VENCIDO')
    ),
    estado TEXT NOT NULL DEFAULT 'PENDIENTE'
        CHECK (estado IN (
            'PENDIENTE',
            'REVISADA',
            'CERRADA'
        )),
    creada_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revisada_en TIMESTAMPTZ,
    UNIQUE (lote_id, tipo)
);

-- 7. HISTORIAL DE MOVIMIENTOS
CREATE TABLE IF NOT EXISTS mass_control.movimientos (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lote_id BIGINT NOT NULL REFERENCES mass_control.lotes(id),
    cuenta_id BIGINT REFERENCES mass_control.cuentas(id),
    accion TEXT NOT NULL,
    datos_anteriores JSONB,
    datos_nuevos JSONB,
    observaciones TEXT,
    registrado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- INDICES DE CONSULTA
CREATE INDEX IF NOT EXISTS idx_productos_tienda
ON mass_control.productos(tienda_id);

CREATE INDEX IF NOT EXISTS idx_lotes_producto_fecha
ON mass_control.lotes(producto_id, fecha_limite);

CREATE INDEX IF NOT EXISTS idx_alertas_estado
ON mass_control.alertas(estado);

CREATE INDEX IF NOT EXISTS idx_movimientos_lote
ON mass_control.movimientos(lote_id, registrado_en);

COMMIT;
