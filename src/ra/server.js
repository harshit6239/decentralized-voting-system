const express = require("express");
const pino = require("pino");

const { PORT_RA } = require("../common/config");
const { issueToken, getToken } = require("./tokenService");

const logger = pino();

const createApp = () => {
    const app = express();
    app.use(express.json());

    app.post("/issue-token", (req, res) => {
        const { electionId, voterId } = req.body || {};

        try {
            const token = issueToken({ electionId, voterId });
            res.status(201).json({
                tokenId: token.tokenId,
                tokenJwt: token.tokenJwt,
                saved: token.tokenFilePath,
                issuedAt: token.issuedAt,
            });
        } catch (error) {
            logger.warn(
                { err: error, electionId, voterId },
                "token issuance failed"
            );
            res.status(400).json({ message: error.message });
        }
    });

    app.get("/token/:tokenId", (req, res) => {
        const { tokenId } = req.params;
        try {
            const record = getToken(tokenId);
            if (!record) {
                res.status(404).json({ message: "Token not found" });
                return;
            }

            res.json(record);
        } catch (error) {
            logger.error(
                { err: error, tokenId },
                "Failed to fetch token record"
            );
            res.status(500).json({ message: "Internal server error" });
        }
    });

    return app;
};

if (require.main === module) {
    const app = createApp();
    const port = Number(PORT_RA) || 4100;
    app.listen(port, () => {
        logger.info({ port }, "RA service listening");
    });
}

module.exports = {
    createApp,
};
