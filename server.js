
await pool.query(`
  SELECT COUNT(*) FROM mass_control.tiendas
  UNION ALL SELECT COUNT(*) FROM mass_control.cuentas
  UNION ALL SELECT COUNT(*) FROM mass_control.familias
  UNION ALL SELECT COUNT(*) FROM mass_control.productos
  UNION ALL SELECT COUNT(*) FROM mass_control.lotes
  UNION ALL SELECT COUNT(*) FROM mass_control.alertas
  UNION ALL SELECT COUNT(*) FROM mass_control.movimientos
`);
