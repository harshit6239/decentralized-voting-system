const express = require("express");
const pino = require("pino");

const app = express();
const logger = pino();
const PORT = process.env.PORT_LEDGER || 4000;

app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});

app.listen(PORT, () => {
    logger.info({ port: PORT }, "ledger prototype listening");
});
