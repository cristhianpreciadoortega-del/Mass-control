
const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    aplicacion: "Mass Control",
    estado: "Servidor funcionando"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mass Control activo en puerto ${PORT}`);
});
